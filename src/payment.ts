import { randomBytes } from "node:crypto";
import type { BankAccount, CodiPaid } from "./pey.js";

/**
 * Deterministic money rules for "pay the worker directly" with CoDi. Pure functions: no I/O,
 * so the same inputs always give the same decision and every rule is unit-tested.
 */

/** A charge may only be routed to an account that pey says is ACTIVE and that holds the worker's own CLABE. */
export function canReceive(account: Pick<BankAccount, "id" | "status" | "clabe"> | null | undefined, workerClabe: string | null | undefined): boolean {
  return Boolean(account?.id && account.status === "ACTIVE" && workerClabe && account.clabe === workerClabe);
}

export interface ExpectedPayment {
  /** Centavos actually requested from the payer (may differ from the order total in test mode). */
  chargedAmount: number;
  /** The worker account the request was routed to. */
  bankAccountId: string;
  /** Whether this order was already marked paid by an earlier event. */
  alreadyPaid: boolean;
}

export type PaymentOutcome = "paid" | "already_paid" | "amount_mismatch" | "account_mismatch";

/**
 * Decides what a verified pey payment event means for one order. Never "paid" on a wrong amount or a
 * different receiving account. "already_paid" = the payer paid twice (pey cannot refund: return it by hand).
 * Persist the decision with a conditional write (e.g. `UPDATE … WHERE paid_at IS NULL`) so two concurrent
 * events can't both win.
 */
export function decidePayment(expected: ExpectedPayment, ev: Pick<CodiPaid, "amount" | "bankAccountId">): PaymentOutcome {
  if (expected.alreadyPaid) return "already_paid";
  if (ev.amount !== expected.chargedAmount) return "amount_mismatch";
  if (ev.bankAccountId && ev.bankAccountId !== expected.bankAccountId) return "account_mismatch";
  return "paid";
}

/** pey's numRef: digits only, up to 7. Reuse one per order so a late payment of an earlier request still matches. */
export function newNumRef(): string {
  return String(1_000_000 + (randomBytes(4).readUInt32BE() % 9_000_000));
}
