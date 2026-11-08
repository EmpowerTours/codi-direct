# codi-direct

Pay workers directly with **CoDi** (Banxico's instant payments) through the
[pey](https://docs.pey.mx) API — the payment lands in the worker's own bank
account, and the platform that requested it never holds the money.

Built for [Traelo](https://traelo.empowertours.xyz), an errands app for towns in
Guerrero, Mexico, where couriers used to front cash for groceries and bills and
hope to be paid back at the door. It is published so that any cooperative,
municipality or small platform can pay its people the same way.

## What it does

| Piece | File | What it guarantees |
|---|---|---|
| pey client | `src/pey.ts` | CoDi push requests (to the payer's phone) and QR codes; bank-account registration and status. **Refuses to build a charge without the worker's account** — omitting it would send the money to the platform's own account. |
| Webhooks | `src/pey.ts` | Verifies pey's [Standard Webhooks](https://www.standardwebhooks.com/) signature on the raw body and rejects replays outside the timestamp tolerance; parses payment and account-activated events. |
| Payment rules | `src/payment.ts` | Pure functions: an account may receive only if pey says it is `ACTIVE` **and** it holds the worker's own CLABE; an order is marked paid only on the exact amount into the requested account; a second payment is flagged `already_paid` (pey cannot refund). |
| CLABE | `src/clabe.ts` | 18-digit CLABE check-digit validation (tested against real accounts) and masking. |
| Receipt checks | `src/receipt.ts` | Deterministic verification of a purchase receipt: date is today (Mexico City time), printed after the job was accepted, uploaded near the store, total matches what was typed and doesn't exceed the customer's own price, photo and folio not reused. Failures add reasons; they never silently block. |
| Receipt reader (optional) | `src/openai-reader.ts` | Reads a receipt photo with the OpenAI API (Responses API, strict structured output; default model `gpt-5.5`). It only extracts fields; `checkReceipt()` makes every decision. Provider-neutral interface and schema in `src/receipt-reader.ts`. |

## Install

```bash
npm install github:EmpowerTours/codi-direct
```

Requires Node 20+. The receipt reader additionally needs `openai` (v6+) and `zod`.

## Usage

```ts
import { PeyCodi, canReceive, decidePayment, newNumRef, phone10 } from "codi-direct";

const pey = new PeyCodi(process.env.PEY_API_KEY!, process.env.PEY_WEBHOOK_SECRET);

// 1. Register the worker's CLABE once (Banxico activation can take up to 5 business days).
const acct = await pey.registerBankAccount({ alias: "worker-42", name: "Legal Name", clabe: "012180015826225713", entity: "PERSON" });

// 2. At the door: request the payment on the customer's phone, routed to the worker's account.
const account = await pey.getBankAccount(acct.id);
if (!canReceive(account, "012180015826225713")) throw new Error("worker account not active");
const numRef = newNumRef();
await pey.push(phone10("+52 747 123 4567"), { amount: 7500, concept: `Order ${numRef}`, numRef, bankAccountId: acct.id, metadata: { orderId: "order-1" }, expiration: 360 });

// 3. Webhook endpoint (raw body!): verify, then decide.
const ev = pey.parseWebhook(rawBody, headers); // throws on a bad signature
if (ev?.kind === "paid") {
  const outcome = decidePayment({ chargedAmount: 7500, bankAccountId: acct.id, alreadyPaid: false }, ev);
  // persist with a conditional write: UPDATE orders SET paid_at=now() WHERE id=$1 AND paid_at IS NULL
}
```

Amounts are integer **centavos** everywhere; the client converts to pesos for pey.

### Receipt photos (optional)

```ts
import { OpenAIReceiptReader } from "codi-direct/openai-reader";
import { checkReceipt } from "codi-direct";

const reader = new OpenAIReceiptReader(process.env.OPENAI_API_KEY!, { model: process.env.OPENAI_MODEL }); // default "gpt-5.5"
const reading = await reader.read(photoBuffer, "image/jpeg"); // null = no receipt in the photo; throws on refusal/API error
const check = checkReceipt({ reading, amount, expectedItems, acceptedAt, uploadedAt, courierLocation, pickup, duplicatePhoto, duplicateFolio });
```

**Migrating from `codi-direct/claude-reader`:** that export and `ClaudeReceiptReader` were removed. Import
`OpenAIReceiptReader` from `codi-direct/openai-reader` and pass an OpenAI API key (not an Anthropic key).
`ReceiptReader`, `ReceiptFields`, `toReading` and `FixedReceiptReader` are unchanged and now come from
`codi-direct/receipt-reader` (also re-exported by `codi-direct/openai-reader`).

## Tests

```bash
npm test        # vitest: CLABE, receipt rules, payment decisions, webhook signatures and replay, receipt reader (mocked HTTP)
npm run typecheck
```

## Status

Used in production by Traelo. A real CoDi payment was made through this code on
2026-11-07 (Mercado Pago → Banxico → pey webhook → the courier's account).

## Licence

**GNU AGPL-3.0** — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
Copyright © 2026 EmpowerTours S.A.S. de C.V.

You may read, run, modify and redistribute this software. If you run a
**modified** version as a network service, AGPL section 13 requires you to offer
your users the complete corresponding source of your version under this same
licence: you may fork this and compete, but you may not fork it, close it, and
compete.

**Dual licensed.** AGPL-3.0 as above, or a **commercial licence** from
EmpowerTours for anyone who wants to build on this without AGPL section 13's
obligations. Enquiries: admin@empowertours.xyz
