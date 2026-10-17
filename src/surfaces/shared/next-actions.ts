import { RequestContext } from '@common/context/request-context';

/**
 * `nextActions` of the editable aggregates (web contract request "nextActions on editable aggregates"): the
 * `…/actions/{name}` routes the caller may call now, from the same state checks as the endpoints and the caller's
 * permissions (`@Can`). The endpoint still decides; a stale list gets the endpoint's problem response.
 */
const can = (permission: string) => RequestContext.permissions().has(permission);
const when = (ok: boolean, ...actions: string[]) => (ok ? actions : []);

export const unitActions = (status: string) =>
  when(can('unit.manage') && ['vacant', 'inactive', 'maintenance'].includes(status), 'set-status');

export const inspectionActions = (status: string) =>
  when(can('inspection.perform') && (status === 'scheduled' || status === 'in_progress'), 'complete');

export const invitationActions = (state: string, expiresAt: Date, now: Date) =>
  when(can('tenant.member.invite') && state === 'pending' && expiresAt.getTime() > now.getTime(), 'revoke');

export function bankAccountActions(state: string): string[] {
  if (!can('tenant.bank_account.manage')) return [];
  if (state === 'pending_otp') return ['confirm', 'resend-otp', 'remove'];
  if (state === 'active') return ['remove'];
  return [];
}

export function supportGrantActions(state: string): string[] {
  if (!can('tenant.support_grant.approve')) return [];
  if (state === 'requested') return ['approve', 'deny'];
  if (state === 'approved' || state === 'active') return ['revoke'];
  return [];
}

export function dsrActions(state: string): string[] {
  if (!can('privacy.manage')) return [];
  switch (state) {
    case 'received':
      return ['verify', 'start', 'reject'];
    case 'verifying':
      return ['start', 'reject'];
    case 'in_progress':
      return ['fulfil', 'reject'];
    default:
      return [];
  }
}

export function tariffVersionActions(state: string, enteredBy: string | null): string[] {
  if (!can('admin.utility_tariff.verify')) return [];
  const actor = RequestContext.actor();
  const self = actor?.type === 'user' && enteredBy === actor.publicId;
  if (state === 'entered') return self ? [] : ['verify'];
  if (state === 'verified') return ['publish'];
  return [];
}
