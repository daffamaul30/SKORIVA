/**
 * Client-side transaction id (T-31.7).
 *
 * Every operational action and lifecycle call carries a `txId` for idempotency
 * (backend `{matchId, txId}` unique index). The value is opaque and never
 * contains credentials.
 */

let counter = 0;

export function createTxId(): string {
  const globalCrypto = globalThis.crypto;

  if (globalCrypto && typeof globalCrypto.randomUUID === 'function') {
    return globalCrypto.randomUUID();
  }

  counter += 1;
  return `tx-${Date.now().toString(36)}-${counter}`;
}
