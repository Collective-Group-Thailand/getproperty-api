import { RequestContext } from '@common/context/request-context';
import { sameDigest } from '@common/crypto/hashing';
import { LookupHasher } from '@common/crypto/lookup-hasher';
import { DomainException } from '@common/errors/domain.exception';
import { uuidv7 } from '@common/ids/uuidv7';
import { AppConfig } from '@config/app-config';
import { TenantTx } from '@database/tenant-tx';
import { type OtpChallenge, type OtpPurpose } from '@generated/prisma/client';
import { SMS, type SmsPort } from '@integrations/sms/sms.port';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { CLOCK, type Clock } from '../clock/clock';
import { numericCode } from './crypto/secrets';
import { maskPhone } from './phone';

export interface OtpRequestResult {
  challengeId: string;
  expiresAt: Date;
  resendAvailableAt: Date;
}

const MESSAGES: Record<OtpPurpose, { th: string; en: string }> = {
  operator_login: {
    th: 'รหัสเข้าสู่ระบบ getproperty: {code} (หมดอายุใน {minutes} นาที) ห้ามบอกรหัสนี้กับผู้อื่น',
    en: 'getproperty sign-in code: {code} (expires in {minutes} min). Never share this code.',
  },
  resident_login: {
    th: 'รหัสเข้าสู่ระบบ getproperty: {code} (หมดอายุใน {minutes} นาที) หรือแตะ {link}',
    en: 'getproperty sign-in code: {code} (expires in {minutes} min) or tap {link}',
  },
  technician_login: {
    th: 'รหัสเข้าสู่ระบบช่าง getproperty: {code} (หมดอายุใน {minutes} นาที)',
    en: 'getproperty technician code: {code} (expires in {minutes} min).',
  },
  bank_account_change: {
    th: 'รหัสยืนยันการเปลี่ยนบัญชีรับเงิน {account}: {code} (หมดอายุใน {minutes} นาที) หากไม่ได้ทำรายการ โปรดติดต่อ getproperty',
    en: 'Code to confirm the new receiving account {account}: {code} (expires in {minutes} min). Not you? Contact getproperty.',
  },
  lease_signature: {
    th: 'รหัสยืนยันการลงนามสัญญาเช่า: {code} (หมดอายุใน {minutes} นาที)',
    en: 'Lease signature code: {code} (expires in {minutes} min).',
  },
  phone_verify: {
    th: 'รหัสยืนยันเบอร์โทร getproperty: {code} (หมดอายุใน {minutes} นาที)',
    en: 'getproperty phone verification code: {code} (expires in {minutes} min).',
  },
  landlord_signup: {
    th: 'รหัสสมัครใช้ getproperty: {code} (หมดอายุใน {minutes} นาที) ห้ามบอกรหัสนี้กับผู้อื่น',
    en: 'getproperty sign-up code: {code} (expires in {minutes} min). Never share this code.',
  },
};

/**
 * SMS OTP (contract §4; D-091 bank-account confirmation; D-062 lease signature): 6 digits from a CSPRNG, stored as
 * an HMAC bound to the challenge id, `OTP_TTL_SECONDS` lifetime, `OTP_MAX_ATTEMPTS` per challenge, one resend per
 * `OTP_RESEND_SECONDS` and `OTP_MAX_PER_HOUR` per phone and purpose. The SMS is the authentication transport itself,
 * so it is sent inline (not through the notification outbox). Codes and phones never reach the logs.
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly hasher: LookupHasher,
    private readonly config: AppConfig,
    @Inject(SMS) private readonly sms: SmsPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Creates a challenge and sends the SMS. `send: false` answers with the same shape without creating anything —
   * used when the phone is not eligible, so the endpoint does not reveal which numbers have accounts.
   */
  async request(input: {
    purpose: OtpPurpose;
    phone: string;
    send: boolean;
    subjectType?: string;
    subjectId?: string;
    language?: string;
    vars?: Record<string, string>;
  }): Promise<OtpRequestResult> {
    const now = this.clock.now();
    const ttl = this.config.get('OTP_TTL_SECONDS') * 1000;
    const resend = this.config.get('OTP_RESEND_SECONDS') * 1000;
    const phoneHash = this.hasher.phone(input.phone);
    await this.checkRateLimit(phoneHash, input.purpose, now);
    const id = uuidv7(now.getTime());
    const result = {
      challengeId: id,
      expiresAt: new Date(now.getTime() + ttl),
      resendAvailableAt: new Date(now.getTime() + resend),
    };
    if (!input.send) return result;

    const code = numericCode(6);
    await this.db.platform((tx) =>
      tx.otpChallenge.create({
        data: {
          id,
          purpose: input.purpose,
          phoneE164: input.phone,
          phoneHash,
          codeHash: this.hasher.secret(id, code),
          maxAttempts: this.config.get('OTP_MAX_ATTEMPTS'),
          expiresAt: result.expiresAt,
          subjectType: input.subjectType ?? null,
          subjectId: input.subjectId ?? null,
          ip: RequestContext.current()?.ip ?? null,
          createdAt: now,
        },
      }),
    );
    const template = MESSAGES[input.purpose][input.language === 'en' ? 'en' : 'th'];
    const vars = Object.fromEntries(
      Object.entries(input.vars ?? {}).map(([k, v]) => [k, v.replaceAll('{challengeId}', id)]),
    );
    const text = Object.entries({ code, minutes: String(Math.round(ttl / 60_000)), ...vars }).reduce(
      (t, [k, v]) => t.replaceAll(`{${k}}`, v),
      template,
    );
    try {
      await this.sms.send(input.phone, text);
    } catch (error) {
      this.logger.error(`OTP SMS to ${maskPhone(input.phone)} failed: ${(error as Error).message}`);
      throw new DomainException('provider.unavailable');
    }
    return result;
  }

  private async checkRateLimit(phoneHash: Uint8Array, purpose: OtpPurpose, now: Date): Promise<void> {
    const hourAgo = new Date(now.getTime() - 3_600_000);
    const recent = await this.db.platform((tx) =>
      tx.otpChallenge.findMany({
        where: { phoneHash: Buffer.from(phoneHash), purpose, createdAt: { gt: hourAgo } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
    );
    const resendMs = this.config.get('OTP_RESEND_SECONDS') * 1000;
    const last = recent[0]?.createdAt;
    if (last && now.getTime() - last.getTime() < resendMs) {
      const wait = Math.ceil((resendMs - (now.getTime() - last.getTime())) / 1000);
      throw new DomainException('auth.otp_rate_limited', { headers: { 'Retry-After': String(wait) } });
    }
    if (recent.length >= this.config.get('OTP_MAX_PER_HOUR')) {
      const oldest = recent[recent.length - 1]!.createdAt;
      const wait = Math.ceil((oldest.getTime() + 3_600_000 - now.getTime()) / 1000);
      throw new DomainException('auth.otp_rate_limited', {
        headers: { 'Retry-After': String(Math.max(wait, 1)) },
      });
    }
  }

  /**
   * Checks a code in its own transaction (the row is locked, so two concurrent tries cannot both pass). Wrong code →
   * 401 `auth.otp_invalid` with `attemptsRemaining` (the attempt is counted); too many → 429; expired/used → 401.
   * A correct code consumes the challenge; what it unlocks happens in the caller's next transaction.
   */
  async verify(input: { challengeId: string; code: string; purpose: OtpPurpose }): Promise<OtpChallenge> {
    const now = this.clock.now();
    const outcome = await this.db.platform(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM platform.otp_challenge WHERE id = ${input.challengeId}::uuid FOR UPDATE`;
      const challenge = rows.length
        ? await tx.otpChallenge.findUnique({ where: { id: input.challengeId } })
        : null;
      if (!challenge || challenge.purpose !== input.purpose) return { error: 'auth.otp_invalid' as const };
      if (challenge.consumedAt || challenge.expiresAt.getTime() <= now.getTime())
        return { error: 'auth.otp_expired' as const };
      if (challenge.attempts >= challenge.maxAttempts)
        return { error: 'auth.otp_attempts_exceeded' as const };
      const attempts = challenge.attempts + 1;
      const ok =
        /^\d{6}$/.test(input.code) &&
        sameDigest(challenge.codeHash, this.hasher.secret(challenge.id, input.code));
      await tx.otpChallenge.update({
        where: { id: challenge.id },
        data: ok ? { attempts, consumedAt: now } : { attempts },
      });
      if (ok) return { challenge };
      if (attempts >= challenge.maxAttempts) return { error: 'auth.otp_attempts_exceeded' as const };
      return { error: 'auth.otp_invalid' as const, attemptsRemaining: challenge.maxAttempts - attempts };
    });
    if ('challenge' in outcome && outcome.challenge) return outcome.challenge;
    const failure = outcome as {
      error: 'auth.otp_invalid' | 'auth.otp_expired' | 'auth.otp_attempts_exceeded';
      attemptsRemaining?: number;
    };
    throw new DomainException(failure.error, {
      ...(failure.attemptsRemaining !== undefined
        ? { extensions: { attemptsRemaining: failure.attemptsRemaining } }
        : {}),
    });
  }
}
