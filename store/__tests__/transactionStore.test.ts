/**
 * Unit tests for store/transactionStore.ts — signature-recovery slice (#1121).
 *
 * The slice is the half of the feature that survives a refresh: an interrupted
 * signing attempt must still be resumable after the user reloads the page, so
 * the record has to be written to storage and read back intact.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { useTransactionStore, type SignatureRecovery } from "../transactionStore";

const STORAGE_KEY = "kora-tx-history";

function persistedState(): Record<string, unknown> | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw).state as Record<string, unknown>) : null;
}

const RECOVERY: SignatureRecovery = {
  unsignedXdr: "AAAA-recover-me",
  reason: "interrupted",
  detail: "User closed the popup",
  createdAt: 1_700_000_000_000,
};

describe("transactionStore signature recovery (#1121)", () => {
  beforeEach(() => {
    localStorage.clear();
    useTransactionStore.setState({ signatureRecovery: null });
  });

  afterEach(() => {
    localStorage.clear();
    useTransactionStore.setState({ signatureRecovery: null });
  });

  it("starts with no pending attempt", () => {
    expect(useTransactionStore.getState().signatureRecovery).toBeNull();
  });

  it("records and clears a pending attempt", () => {
    const { setSignatureRecovery, clearSignatureRecovery } = useTransactionStore.getState();

    setSignatureRecovery(RECOVERY);
    expect(useTransactionStore.getState().signatureRecovery).toEqual(RECOVERY);

    clearSignatureRecovery();
    expect(useTransactionStore.getState().signatureRecovery).toBeNull();
  });

  it("keeps the unsigned XDR verbatim — the resume must re-sign the same envelope", () => {
    const xdr = "AAAA...exactly-this-envelope...==";

    useTransactionStore.getState().setSignatureRecovery({ ...RECOVERY, unsignedXdr: xdr });

    expect(useTransactionStore.getState().signatureRecovery?.unsignedXdr).toBe(xdr);
    expect(useTransactionStore.getState().signatureRecovery?.unsignedXdr).toBe(xdr);
  });

  it("persists the pending attempt so a refresh can offer the retry", () => {
    useTransactionStore.getState().setSignatureRecovery(RECOVERY);

    expect(persistedState()?.signatureRecovery).toEqual(RECOVERY);
  });

  it("persists the cleared state too, so a resolved attempt does not resurrect", () => {
    useTransactionStore.getState().setSignatureRecovery(RECOVERY);
    useTransactionStore.getState().clearSignatureRecovery();

    expect(persistedState()?.signatureRecovery).toBeNull();
  });

  it("still persists the transaction history alongside the recovery record", () => {
    useTransactionStore.getState().setSignatureRecovery(RECOVERY);
    useTransactionStore.getState().addTransaction({
      hash: "deadbeef",
      type: "fund",
      status: "confirmed",
      timestamp: new Date().toISOString(),
    });

    const state = persistedState();
    expect(Array.isArray(state?.transactions)).toBe(true);
    expect(state?.signatureRecovery).toEqual(RECOVERY);
    expect(state?.escrowState).toBeDefined();
  });
});
