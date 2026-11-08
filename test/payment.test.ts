import { describe, expect, it } from "vitest";
import { canReceive, decidePayment, MockCodi, newNumRef, phone10, toCentavos, toPesos } from "../src/index.js";

const ACCOUNT = "01JBAVWE4NS5TGXHWGMX3KH23Q";

describe("routing to the worker's own account", () => {
  it("only an ACTIVE account holding the worker's own CLABE can receive", () => {
    const clabe = "012180015826225713";
    expect(canReceive({ id: ACCOUNT, status: "ACTIVE", clabe }, clabe)).toBe(true);
    expect(canReceive({ id: ACCOUNT, status: "PENDING", clabe }, clabe)).toBe(false);
    expect(canReceive({ id: ACCOUNT, status: "ACTIVE", clabe: "014180606004536217" }, clabe)).toBe(false);
    expect(canReceive(null, clabe)).toBe(false);
  });
  it("the pey client refuses to build a charge without a worker account", async () => {
    const codi = new MockCodi();
    await expect(codi.push("7471234567", { amount: 1, concept: "x", numRef: "1", bankAccountId: "", metadata: {}, expiration: 360 })).rejects.toThrow("bank_account_required");
  });
});

describe("payment decisions", () => {
  const expected = { chargedAmount: 7500, bankAccountId: ACCOUNT, alreadyPaid: false };
  it("paid only on the exact amount into the requested account", () => {
    expect(decidePayment(expected, { amount: 7500, bankAccountId: ACCOUNT })).toBe("paid");
    expect(decidePayment(expected, { amount: 7499, bankAccountId: ACCOUNT })).toBe("amount_mismatch");
    expect(decidePayment(expected, { amount: 7500, bankAccountId: "01JBAVWE4NS5TGXHWGMX3KH23R" })).toBe("account_mismatch");
    expect(decidePayment({ ...expected, alreadyPaid: true }, { amount: 7500, bankAccountId: ACCOUNT })).toBe("already_paid");
  });
  it("money and reference helpers", () => {
    expect(toPesos(7550)).toBe(75.5);
    expect(toCentavos(0.01)).toBe(1);
    expect(toCentavos(75.5)).toBe(7550);
    expect(phone10("+52 747 123 4567")).toBe("7471234567");
    for (let i = 0; i < 50; i++) expect(newNumRef()).toMatch(/^\d{7}$/);
  });
});

describe("pey webhooks (Standard Webhooks)", () => {
  const codi = new MockCodi();
  const event = { type: "codi.pn.payment_received", amount: 0.01, numRef: "1234567", transactionId: "01M3QR5E7XHXMNZDEPFH3JAWS0", datePaid: 1790724758,
    bankAccountId: ACCOUNT, metadata: { trackingKey: "0192191042", clabe: "012180015826225713", externalMetadata: { orderId: "order-1" } } };
  it("parses a correctly signed payment event into centavos with order id and tracking key", () => {
    const s = codi.sign(event);
    expect(codi.parseWebhook(s.body, s.headers)).toMatchObject({ kind: "paid", amount: 1, orderId: "order-1", trackingKey: "0192191042", bankAccountId: ACCOUNT });
  });
  it("rejects a forged signature and a tampered body", () => {
    const s = codi.sign(event);
    expect(() => codi.parseWebhook(s.body, { ...s.headers, "webhook-signature": "v1,AAAA" })).toThrow();
    expect(() => codi.parseWebhook(s.body.replace("0.01", "9999"), s.headers)).toThrow();
  });
  it("rejects a replay outside the timestamp tolerance", () => {
    const s = codi.sign(event, "msg_old", new Date(Date.now() - 60 * 60 * 1000));
    expect(() => codi.parseWebhook(s.body, s.headers)).toThrow();
  });
  it("parses the account-activated event and ignores unknown types", () => {
    const acc = codi.sign({ type: "bank.account.updated", bankAccountId: ACCOUNT, codiStatus: "ACTIVE", clabe: "012180015826225713" });
    expect(codi.parseWebhook(acc.body, acc.headers)).toMatchObject({ kind: "account_active", bankAccountId: ACCOUNT });
    const other = codi.sign({ type: "payment_link.status_updated" });
    expect(codi.parseWebhook(other.body, other.headers)).toBeUndefined();
  });
});
