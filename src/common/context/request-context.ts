import { AsyncLocalStorage } from 'node:async_hooks';

import { isUuid, uuidv7 } from '@common/ids/uuidv7';

import { type Actor } from './actor';
import { type OrgContext } from './org-context';

/**
 * Per-request (or per-job) context carried through async calls: who acts, in which org, and the
 * ids that tie audit rows, activities and domain events together (correlation / causation).
 */
export interface RequestContextStore {
  requestId?: string;
  /** uuid — every event recorded while handling this request shares it. */
  correlationId: string;
  /** Envelope id of the event being handled (worker subscribers). */
  causationId?: string;
  ip?: string;
  userAgent?: string;
  actor?: Actor;
  /** Set by `OrgContextMiddleware` on the owner and staff surfaces (contract §8). */
  org?: OrgContext;
}

const storage = new AsyncLocalStorage<RequestContextStore>();

export const RequestContext = {
  run<T>(store: Partial<RequestContextStore>, work: () => T): T {
    return storage.run({ ...store, correlationId: store.correlationId ?? uuidv7() }, work);
  },

  current(): RequestContextStore | undefined {
    return storage.getStore();
  },

  actor(): Actor | undefined {
    return storage.getStore()?.actor;
  },

  org(): OrgContext | undefined {
    return storage.getStore()?.org;
  },

  /** Set by the auth guard once the bearer token is verified (B1.3). */
  setActor(actor: Actor): void {
    const store = storage.getStore();
    if (store) store.actor = actor;
  },

  setOrg(org: OrgContext | undefined): void {
    const store = storage.getStore();
    if (store) store.org = org;
  },

  /** A request id doubles as the correlation id when it is already a uuid. */
  correlationIdFor(requestId: string | undefined): string {
    return isUuid(requestId) ? requestId : uuidv7();
  },
};
