import { actorEnvelope, userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { LookupHasher } from '@common/crypto/lookup-hasher';
import { DomainException } from '@common/errors/domain.exception';
import { uuidv7 } from '@common/ids/uuidv7';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { type PaymentProvider, type PromptpayIdType, type TenantBankAccount } from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { CLOCK, type Clock } from '../clock/clock';
import { DomainEvents } from '../events/domain-events';
import { type OtpRequestResult, OtpService } from '../identity/otp.service';
import { TenantDataKeys } from './data-keys.service';

export interface BankAccountInput {
  bankCode: string;
  bankNameTh: string;
  branch?: string | null;
  accountNo: string;
  accountName: string;
  promptpayIdType?: PromptpayIdType | null;
  promptpayId?: string | null;
  paymentProvider?: PaymentProvider;
  /** Merchant / biller id at the payment provider (B4.4, D-042): sealed, plus a lookup hash for callbacks. */
  providerMerchantRef?: string | null;
  buildingIds?: string[] | null;
  isDefault: boolean;
}

/** Lookup hash of a provider merchant reference: payment callbacks find their bank account by it (B4.4). */
export const merchantRefHash = (hasher: LookupHasher, provider: string, merchantRef: string) =>
  hasher.secret('payments.merchant', `${provider}|${merchantRef.trim()}`);

export const maskAccountNo = (digits: string): string =>
  digits.length <= 4 ? digits : `${'x'.repeat(digits.length - 4)}${digits.slice(-4)}`;

const masked = (a: TenantBankAccount) => ({
  bankCode: a.bankCode,
  accountNoMasked: a.accountNoMasked,
  accountName: a.accountName,
  isDefault: a.isDefault,
  state: a.state,
});

/**
 * Receiving bank accounts (D-042 the platform never holds funds; D-091 maker-checker by Owner OTP). A new or changed
 * account is stored `pending_otp` (number sealed with the tenant DEK, masked copy for lists, HMAC for duplicates)
 * and an SMS OTP goes to the **acting Owner's verified phone**; only the confirmation with that code makes it
 * `active` and, when default, replaces the previous default. History rows keep masked before/after values.
 */
@Injectable()
export class BankAccountService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly keys: TenantDataKeys,
    private readonly hasher: LookupHasher,
    private readonly otp: OtpService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  list(ctx: TenantContext) {
    return this.db.tenant(ctx, (tx) =>
      tx.tenantBankAccount.findMany({
        where: this.own(ctx, { state: { not: 'removed' } }),
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  private async ownerPhone(): Promise<string> {
    const userId = userIdOf(RequestContext.actor());
    if (!userId) throw new DomainException('auth.unauthenticated');
    const user = await this.db.platform((tx) => tx.userAccount.findUnique({ where: { id: userId } }));
    if (!user?.phoneE164 || !user.phoneVerifiedAt)
      throw new DomainException('bank_account.owner_phone_missing');
    return user.phoneE164;
  }

  private history(
    tx: Tx,
    ctx: TenantContext,
    account: TenantBankAccount,
    change: 'created' | 'activated' | 'replaced' | 'removed',
    before: TenantBankAccount | null,
    otpId: string | null,
  ) {
    return tx.tenantBankAccountHistory.create({
      data: {
        tenantId: ctx.tenantId,
        bankAccountId: account.id,
        change,
        before: before ? masked(before) : undefined,
        after: masked(account),
        otpChallengeId: otpId,
        actor: actorEnvelope(RequestContext.actor()),
        occurredAt: this.clock.now(),
      },
    });
  }

  async request(
    ctx: TenantContext,
    input: BankAccountInput,
  ): Promise<{ account: TenantBankAccount; otp: OtpRequestResult }> {
    const phone = await this.ownerPhone();
    const digits = input.accountNo.replace(/\D/g, '');
    if (digits.length < 6 || digits.length > 20)
      throw new DomainException('validation.failed', {
        errors: [{ path: 'accountNo', code: 'length', message: 'account number must have 6–20 digits' }],
      });
    const account = await this.db.tenant(ctx, async (tx) => {
      if (input.buildingIds?.length) {
        const n = await tx.building.count({
          where: {
            id: { in: input.buildingIds },
            deletedAt: null,
            OR: [{ operatorTenantId: ctx.tenantId }, { ownerTenantId: ctx.tenantId }],
          },
        });
        if (n !== new Set(input.buildingIds).size) throw new DomainException('http.not_found');
      }
      const id = uuidv7();
      const field = (column: string) => ({
        tenantId: ctx.tenantId,
        table: 'platform.tenant_bank_account',
        column,
        rowId: id,
      });
      const row = await tx.tenantBankAccount.create({
        data: {
          id,
          tenantId: ctx.tenantId,
          bankCode: input.bankCode,
          bankNameTh: input.bankNameTh,
          branch: input.branch ?? null,
          accountNoEnc: await this.keys.encrypt(tx, field('account_no'), digits),
          accountNoHash: this.hasher.tenantValue(ctx.tenantId, digits),
          accountNoMasked: maskAccountNo(digits),
          accountName: input.accountName,
          promptpayIdType: input.promptpayIdType ?? null,
          promptpayIdEnc: input.promptpayId
            ? await this.keys.encrypt(tx, field('promptpay_id'), input.promptpayId)
            : null,
          paymentProvider: input.paymentProvider ?? 'none',
          ...(input.providerMerchantRef && (input.paymentProvider ?? 'none') !== 'none'
            ? {
                providerMerchantRefEnc: await this.keys.encrypt(
                  tx,
                  field('provider_merchant_ref'),
                  input.providerMerchantRef,
                ),
                providerMerchantRefHash: merchantRefHash(
                  this.hasher,
                  input.paymentProvider!,
                  input.providerMerchantRef,
                ),
              }
            : {}),
          buildingIds: input.buildingIds ?? [],
          isDefault: false,
          state: 'pending_otp',
          createdBy: userIdOf(RequestContext.actor()),
        },
      });
      await this.history(tx, ctx, row, 'created', null, null);
      await this.audit.record(tx, {
        action: 'tenant.bank_account.requested',
        tenantId: ctx.tenantId,
        subjectType: 'platform.tenant_bank_account',
        subjectId: row.id,
        after: { ...masked(row), requestedDefault: input.isDefault },
      });
      await this.events.record(tx, {
        type: 'tenant.bank_account.otp_requested',
        aggregateType: 'tenant_bank_account',
        aggregateId: row.id,
        tenantId: ctx.tenantId,
        payload: { bankAccountId: row.id, accountNoMasked: row.accountNoMasked, isDefault: input.isDefault },
      });
      return row;
    });
    const otp = await this.sendOtp(account, phone, input.isDefault);
    return { account, otp };
  }

  private sendOtp(
    account: TenantBankAccount,
    phone: string,
    makeDefault: boolean,
  ): Promise<OtpRequestResult> {
    return this.otp.request({
      purpose: 'bank_account_change',
      phone,
      send: true,
      subjectType: makeDefault ? 'platform.tenant_bank_account:default' : 'platform.tenant_bank_account',
      subjectId: account.id,
      vars: { account: account.accountNoMasked },
    });
  }

  async resendOtp(ctx: TenantContext, accountId: string): Promise<OtpRequestResult> {
    const phone = await this.ownerPhone();
    const account = await this.db.tenant(ctx, async (tx) =>
      this.found(await tx.tenantBankAccount.findFirst({ where: this.own(ctx, { id: accountId }) })),
    );
    if (account.state !== 'pending_otp') throw new DomainException('bank_account.invalid_state');
    const last = await this.db.platform((tx) =>
      tx.otpChallenge.findFirst({
        where: { subjectId: accountId, purpose: 'bank_account_change' },
        orderBy: { createdAt: 'desc' },
      }),
    );
    return this.sendOtp(account, phone, last?.subjectType?.endsWith(':default') ?? false);
  }

  /** Confirms with the OTP sent to the acting Owner: the account becomes active (and the default when asked). */
  async confirm(
    ctx: TenantContext,
    accountId: string,
    input: { challengeId: string; code: string },
  ): Promise<TenantBankAccount> {
    const phone = await this.ownerPhone();
    const exists = await this.db.tenant(ctx, async (tx) =>
      this.found(await tx.tenantBankAccount.findFirst({ where: this.own(ctx, { id: accountId }) })),
    );
    if (exists.state !== 'pending_otp') throw new DomainException('bank_account.invalid_state');
    const challenge = await this.otp.verify({
      challengeId: input.challengeId,
      code: input.code,
      purpose: 'bank_account_change',
    });
    if (challenge.subjectId !== accountId || challenge.phoneE164 !== phone)
      throw new DomainException('auth.otp_invalid');
    const makeDefault = challenge.subjectType?.endsWith(':default') ?? false;
    return this.db.tenant(ctx, async (tx) => {
      const now = this.clock.now();
      const account = this.found(
        await tx.tenantBankAccount.findFirst({ where: this.own(ctx, { id: accountId }) }),
      );
      if (account.state !== 'pending_otp') throw new DomainException('bank_account.invalid_state');
      let replaced: TenantBankAccount | null = null;
      if (makeDefault) {
        const previous = await tx.tenantBankAccount.findFirst({
          where: this.own(ctx, { isDefault: true, state: 'active' }),
        });
        if (previous) {
          replaced = await tx.tenantBankAccount.update({
            where: { id: previous.id },
            data: { isDefault: false, state: 'replaced', effectiveTo: now },
          });
          await this.history(tx, ctx, replaced, 'replaced', previous, challenge.id);
        }
      }
      const active = await tx.tenantBankAccount.update({
        where: { id: account.id },
        data: {
          state: 'active',
          isDefault: makeDefault,
          confirmedByOtpId: challenge.id,
          confirmedAt: now,
          effectiveFrom: now,
          updatedBy: userIdOf(RequestContext.actor()),
        },
      });
      await this.history(tx, ctx, active, 'activated', account, challenge.id);
      await this.audit.record(tx, {
        action: 'tenant.bank_account.changed',
        tenantId: ctx.tenantId,
        subjectType: 'platform.tenant_bank_account',
        subjectId: active.id,
        before: replaced ? masked(replaced) : undefined,
        after: masked(active),
        metadata: { otpChallengeId: challenge.id },
      });
      await this.events.record(tx, {
        type: 'tenant.bank_account.changed',
        aggregateType: 'tenant_bank_account',
        aggregateId: active.id,
        tenantId: ctx.tenantId,
        payload: {
          bankAccountId: active.id,
          accountNoMasked: active.accountNoMasked,
          isDefault: active.isDefault,
          replacedBankAccountId: replaced?.id ?? null,
        },
      });
      return active;
    });
  }

  async remove(ctx: TenantContext, accountId: string): Promise<TenantBankAccount> {
    return this.db.tenant(ctx, async (tx) => {
      const account = this.found(
        await tx.tenantBankAccount.findFirst({ where: this.own(ctx, { id: accountId }) }),
      );
      if (account.state === 'removed') throw new DomainException('bank_account.invalid_state');
      const removed = await tx.tenantBankAccount.update({
        where: { id: account.id },
        data: { state: 'removed', isDefault: false, effectiveTo: this.clock.now() },
      });
      await this.history(tx, ctx, removed, 'removed', account, null);
      await this.audit.record(tx, {
        action: 'tenant.bank_account.changed',
        tenantId: ctx.tenantId,
        subjectType: 'platform.tenant_bank_account',
        subjectId: account.id,
        before: masked(account),
        after: masked(removed),
      });
      return removed;
    });
  }
}
