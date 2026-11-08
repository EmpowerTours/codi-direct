import { randomBytes, randomUUID } from "node:crypto";
import { Webhook } from "standardwebhooks";

/**
 * CoDi (Banxico) collections through pey — https://docs.pey.mx (API version 2026-10-20).
 * pey only COLLECTS: there is no hold, refund or payout endpoint. The platform never holds the money:
 * each charge is routed with `bankAccountId` to the courier's own registered CLABE, and a charge
 * is never sent without one (the API key's default account would be the platform's).
 */
export interface CodiCharge {
  /** Final amount in centavos. */
  amount: number;
  /** Shown to the payer in their bank app. */
  concept: string;
  /** Digits only, up to 7 (pey rule). */
  numRef: string;
  /** Pey ULID of the worker's ACTIVE bank account. Required: without it the payment lands in the API key's default (platform) account. */
  bankAccountId: string;
  /** Echoed back in the webhook as metadata.externalMetadata. */
  metadata: Record<string, string>;
  /** Seconds; pey minimum is 360. */
  expiration: number;
}

export interface CodiPushResult { ref: string; codiId: string | null }
export interface CodiQrResult { ref: string; qrString: string }

export type CodiAccountStatus = "PENDING" | "PROCESSING" | "ACTIVE" | "ERROR";
export interface BankAccountInput { alias: string; name: string; clabe: string; entity: "PERSON" | "BUSINESS" }
export interface BankAccount { id: string; status: CodiAccountStatus; clabe: string | null; errorMessage: string | null }

/** A verified `codi.*.payment_received` event. */
export interface CodiPaid {
  kind: "paid";
  webhookId: string;
  type: "codi.pn.payment_received" | "codi.qr.payment_received";
  /** Centavos (pey sends MXN pesos as a number). */
  amount: number;
  numRef: string;
  transactionId: string;
  bankAccountId: string | null;
  orderId: string | null;
  datePaid: Date;
  /** SPEI tracking key (clave de rastreo), used to look up Banxico's CEP. */
  trackingKey: string | null;
  /** CLABE that received the money, as reported by pey. */
  receivingClabe: string | null;
}
/** A verified `bank.account.updated` event (only sent on the transition to ACTIVE). */
export interface CodiAccountActive { kind: "account_active"; webhookId: string; bankAccountId: string; clabe: string | null }
export type CodiEvent = CodiPaid | CodiAccountActive;

export interface CodiProvider {
  readonly name: "pey" | "mock";
  /** CoDi push: request a payment on the payer's 10-digit phone. */
  push(phone10: string, c: CodiCharge): Promise<CodiPushResult>;
  /** CoDi QR: payload string to render as a QR the payer scans. */
  qr(c: CodiCharge): Promise<CodiQrResult>;
  /** POST /bank-account: starts Banxico registration (up to 5 business days). */
  registerBankAccount(a: BankAccountInput): Promise<{ id: string; status: CodiAccountStatus }>;
  /** GET /bank-account/{id}. */
  getBankAccount(id: string): Promise<BankAccount>;
  /** Verifies the Standard Webhooks signature and parses a known event. Throws on a bad signature. */
  parseWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): CodiEvent | undefined;
}

/** pey amounts are MXN numbers; this library uses integer centavos everywhere. */
export const toPesos = (centavos: number) => Math.round(centavos) / 100;
export const toCentavos = (pesos: number) => Math.round(pesos * 100);

/** "+527471234567" → "7471234567". */
export function phone10(e164: string): string {
  const ten = e164.replace(/\D/g, "").slice(-10);
  if (ten.length !== 10) throw new Error("invalid_phone");
  return ten;
}

const PAID_TYPES = new Set(["codi.pn.payment_received", "codi.qr.payment_received"]);
const STATUSES = new Set<CodiAccountStatus>(["PENDING", "PROCESSING", "ACTIVE", "ERROR"]);
const asStatus = (s: unknown): CodiAccountStatus => (STATUSES.has(s as CodiAccountStatus) ? (s as CodiAccountStatus) : "ERROR");
const str = (v: unknown) => (typeof v === "string" && v.length ? v : null);

export function parsePeyWebhook(secret: string, rawBody: string, headers: Record<string, string | string[] | undefined>): CodiEvent | undefined {
  const h: Record<string, string> = {};
  for (const k of ["webhook-id", "webhook-timestamp", "webhook-signature"]) {
    const v = headers[k];
    h[k] = (Array.isArray(v) ? v[0] : v) ?? "";
  }
  // Throws WebhookVerificationError on a bad/missing signature or a timestamp outside the library's tolerance (replay).
  const ev = new Webhook(secret).verify(rawBody, h) as Record<string, unknown>;
  const webhookId = h["webhook-id"] ?? "";
  if (ev.type === "bank.account.updated") {
    const id = str(ev.bankAccountId);
    if (!id || ev.codiStatus !== "ACTIVE") return undefined;
    return { kind: "account_active", webhookId, bankAccountId: id, clabe: str(ev.clabe) };
  }
  if (typeof ev.type !== "string" || !PAID_TYPES.has(ev.type)) return undefined;
  const meta = (ev.metadata ?? {}) as { externalMetadata?: Record<string, unknown>; trackingKey?: unknown; clabe?: unknown };
  return {
    kind: "paid",
    webhookId,
    type: ev.type as CodiPaid["type"],
    amount: toCentavos(Number(ev.amount)),
    numRef: String(ev.numRef ?? ""),
    transactionId: String(ev.transactionId ?? ""),
    bankAccountId: str(ev.bankAccountId),
    orderId: str(meta.externalMetadata?.orderId),
    datePaid: new Date(Number(ev.datePaid ?? 0) * 1000),
    trackingKey: str(meta.trackingKey),
    receivingClabe: str(meta.clabe),
  };
}

export class PeyCodi implements CodiProvider {
  readonly name = "pey" as const;
  constructor(private apiKey: string, private webhookSecret: string | undefined, private baseUrl = "https://api.pey.mx") {}

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const r = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await r.text();
    // Response bodies are pey's validation messages; the API key is never echoed into errors.
    if (!r.ok) throw new Error(`pey ${method} ${path.split("/").slice(0, 3).join("/")} ${r.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  }

  private body(c: CodiCharge) {
    if (!c.bankAccountId) throw new Error("bank_account_required");
    return { amount: toPesos(c.amount), concept: c.concept, numRef: c.numRef, expiration: Math.max(360, c.expiration), bankAccountId: c.bankAccountId, metadata: c.metadata };
  }

  async push(phone: string, c: CodiCharge) {
    const r = await this.call<{ transactionId: string; codiId?: string }>("POST", "/codi/pn", { ...this.body(c), phoneNumber: phone });
    return { ref: r.transactionId, codiId: r.codiId ?? null };
  }

  async qr(c: CodiCharge) {
    const r = await this.call<{ id: string; qrString: string }>("POST", "/codi/qr", this.body(c));
    return { ref: r.id, qrString: r.qrString };
  }

  async registerBankAccount(a: BankAccountInput) {
    const r = await this.call<{ id: string; codiStatus: string }>("POST", "/bank-account", a);
    return { id: r.id, status: asStatus(r.codiStatus) };
  }

  async getBankAccount(id: string) {
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) throw new Error("invalid_bank_account_id");
    const r = await this.call<{ id: string; codiStatus: string; clabe?: string; errorMessage?: string }>("GET", `/bank-account/${id}`);
    return { id: r.id, status: asStatus(r.codiStatus), clabe: r.clabe ?? null, errorMessage: r.errorMessage ?? null };
  }

  parseWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>) {
    if (!this.webhookSecret) throw new Error("PEY_WEBHOOK_SECRET not set");
    return parsePeyWebhook(this.webhookSecret, rawBody, headers);
  }
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const fakeUlid = () => Array.from(randomBytes(26), (b) => CROCKFORD[b % 32]).join("");

/** Local demo / tests: records requests; webhooks are signed with a local secret (see sign()). Never used in production. */
export class MockCodi implements CodiProvider {
  readonly name = "mock" as const;
  readonly requests: { kind: "push" | "qr"; phone?: string; charge: CodiCharge; ref: string }[] = [];
  readonly accounts = new Map<string, BankAccount>();
  // Standard Webhooks secrets are "whsec_" + base64.
  constructor(readonly secret = "whsec_" + Buffer.from("codi-direct-local-mock-webhook-secret").toString("base64"), private initialStatus: CodiAccountStatus = "PENDING") {}

  async push(phone: string, c: CodiCharge) {
    if (!c.bankAccountId) throw new Error("bank_account_required");
    const ref = `pn_mock_${randomUUID().slice(0, 8)}`;
    this.requests.push({ kind: "push", phone, charge: c, ref });
    return { ref, codiId: null };
  }

  async qr(c: CodiCharge) {
    if (!c.bankAccountId) throw new Error("bank_account_required");
    const ref = `qr_mock_${randomUUID().slice(0, 8)}`;
    this.requests.push({ kind: "qr", charge: c, ref });
    return { ref, qrString: JSON.stringify({ TYP: 20, demo: true, ref }) };
  }

  async registerBankAccount(a: BankAccountInput) {
    const id = fakeUlid();
    this.accounts.set(id, { id, status: this.initialStatus, clabe: a.clabe, errorMessage: null });
    return { id, status: this.initialStatus };
  }

  async getBankAccount(id: string) {
    return this.accounts.get(id) ?? Promise.reject(new Error("pey GET /bank-account 404"));
  }

  parseWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>) {
    return parsePeyWebhook(this.secret, rawBody, headers);
  }

  /** Builds the exact headers pey would send for `payload` (used by tests and the local demo). */
  sign(payload: unknown, id = `msg_${randomUUID()}`, at = new Date()) {
    const body = JSON.stringify(payload);
    const signature = new Webhook(this.secret).sign(id, at, body);
    return { body, headers: { "webhook-id": id, "webhook-timestamp": String(Math.floor(at.getTime() / 1000)), "webhook-signature": signature } };
  }

  /** Simulates Banxico finishing registration: marks the account ACTIVE and returns the signed pey webhook for it. */
  activate(id: string) {
    const a = this.accounts.get(id);
    if (!a) throw new Error("unknown account");
    a.status = "ACTIVE";
    return this.sign({ type: "bank.account.updated", bankAccountId: id, codiStatus: "ACTIVE", clabe: a.clabe, entity: "PERSON", ownerType: "API_KEY" });
  }
}
