import { randomUUID } from 'node:crypto';

import { totpAt } from '@core/identity/crypto/totp';

import { DEV } from '../../prisma/seed/run';
import { type IntApp } from './int-app';

/** Bearer header for supertest. */
export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Operator SMS-OTP sign-in (accepts an invitation when a code is given); advances the clock past the resend gap. */
export async function operatorToken(t: IntApp, phone: string, invitationCode?: string): Promise<string> {
  t.clock.advance(61_000);
  const challenge = await t.http.post('/v1/auth/operator/otp/request').send({ phone });
  if (challenge.status !== 200)
    throw new Error(`otp request ${challenge.status}: ${JSON.stringify(challenge.body)}`);
  const code = t.sms.lastCodeTo(phone);
  const res = await t.http
    .post('/v1/auth/operator/otp/verify')
    .send({ challengeId: challenge.body.challengeId, code, ...(invitationCode ? { invitationCode } : {}) });
  if (res.status !== 200) throw new Error(`otp verify ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.accessToken as string;
}

export const ownerToken = (t: IntApp) => operatorToken(t, '+660000000001');

const totpSecrets = new Map<string, string>();

/** Platform sign-in with mandatory TOTP: enrols on the first call, then password + TOTP. */
export async function platformToken(
  t: IntApp,
  email: string,
  password: string = DEV.password,
): Promise<string> {
  t.clock.advance(31_000); // a fresh TOTP step (replay protection)
  const secret = totpSecrets.get(email);
  const login = await t.http
    .post('/v1/auth/platform/login')
    .send({ email, password, ...(secret ? { totpCode: totpAt(secret, t.clock.now()) } : {}) });
  if (login.status === 200) return login.body.accessToken as string;
  if (login.body.code !== 'auth.totp_enrollment_required')
    throw new Error(`platform login ${login.status}: ${JSON.stringify(login.body)}`);
  const enrol = await t.http
    .post('/v1/auth/platform/totp/enroll')
    .send({ enrollmentToken: login.body.enrollmentToken });
  totpSecrets.set(email, enrol.body.secret as string);
  const activated = await t.http.post('/v1/auth/platform/totp/activate').send({
    enrollmentToken: login.body.enrollmentToken,
    code: totpAt(enrol.body.secret as string, t.clock.now()),
  });
  if (activated.status !== 200)
    throw new Error(`totp activate ${activated.status}: ${JSON.stringify(activated.body)}`);
  return activated.body.accessToken as string;
}

export const adminToken = (t: IntApp) => platformToken(t, 'admin@getproperty.invalid');
export const supportToken = (t: IntApp) => platformToken(t, 'support@getproperty.invalid');

/** Onboards another tenant through the admin API and signs its first Owner in; returns its id and token. */
export async function onboardTenant(
  t: IntApp,
  admin: string,
  input: { slug: string; phone: string; type?: string },
): Promise<{ tenantId: string; token: string }> {
  const res = await t.http
    .post('/v1/admin/tenants')
    .set(bearer(admin))
    .set('Idempotency-Key', randomUUID())
    .send({
      type: input.type ?? 'pm_company',
      slug: input.slug,
      displayName: `Tenant ${input.slug}`,
      legalName: `บริษัท ${input.slug} จำกัด (ทดสอบ)`,
      legalForm: 'company',
      owner: { phone: input.phone },
    });
  if (res.status !== 201) throw new Error(`onboard ${res.status}: ${JSON.stringify(res.body)}`);
  const token = await operatorToken(t, input.phone, res.body.invitation.code as string);
  return { tenantId: res.body.tenant.id as string, token };
}

/** A fresh Idempotency-Key header. */
export const idem = () => ({ 'Idempotency-Key': randomUUID() });
