import { describe, expect, it } from "vitest";
import { checkReceipt, type ReceiptCheckInput } from "../src/receipt.js";

// 2026-11-07 19:30 in Mexico City (UTC-6) = 2026-11-08T01:30Z
const accepted = new Date("2026-11-08T01:30:00Z");
const uploaded = new Date("2026-11-08T01:45:00Z");
const store = { lat: 17.2486, lng: -99.5114 };

const base = (over: Partial<ReceiptCheckInput> = {}): ReceiptCheckInput => ({
  reading: {
    total: 4500,
    date: "2026-11-07",
    time: "19:41",
    merchant: "Purificadora",
    folio: "A-1",
    handwritten: false,
  },
  amount: 4500,
  expectedItems: 4500,
  acceptedAt: accepted,
  uploadedAt: uploaded,
  courierLocation: { lat: store.lat + 0.0005, lng: store.lng },
  pickup: store,
  duplicatePhoto: false,
  duplicateFolio: false,
  ...over,
});

describe("checkReceipt", () => {
  it("passes a printed receipt from today, after acceptance, at the store, matching the typed amount", () => {
    const r = checkReceipt(base());
    expect(r).toMatchObject({ status: "ok", flags: [] });
    expect(r.distanceM).toBeLessThan(100);
  });

  it("uses the Mexico City date, not the UTC date (01:45Z is still the 7th locally)", () => {
    expect(checkReceipt(base()).flags).not.toContain("not_today");
    expect(
      checkReceipt(
        base({ reading: { ...base().reading!, date: "2026-11-08" } }),
      ).flags,
    ).toContain("not_today");
  });

  it("flags a receipt printed before the courier accepted the order (beyond clock skew)", () => {
    expect(
      checkReceipt(base({ reading: { ...base().reading!, time: "19:20" } }))
        .flags,
    ).not.toContain("before_order_accepted"); // 10 min, within 15 min skew
    const r = checkReceipt(
      base({ reading: { ...base().reading!, time: "18:00" } }),
    );
    expect(r.status).toBe("review");
    expect(r.flags).toContain("before_order_accepted");
  });

  it("flags a receipt timed after the photo was uploaded", () => {
    expect(
      checkReceipt(base({ reading: { ...base().reading!, time: "20:30" } }))
        .flags,
    ).toContain("after_upload");
  });

  it("flags a typed amount that differs from the printed total, and amounts above the customer's own price", () => {
    expect(checkReceipt(base({ amount: 5500 })).flags).toEqual(
      expect.arrayContaining(["total_mismatch", "over_customer_price"]),
    );
  });

  it("flags an upload far from the store, and a missing GPS fix", () => {
    expect(
      checkReceipt(
        base({ courierLocation: { lat: store.lat + 0.02, lng: store.lng } }),
      ).flags,
    ).toContain("far_from_store");
    expect(checkReceipt(base({ courierLocation: null })).flags).toContain(
      "no_location",
    );
  });

  it("flags reused photos and folios", () => {
    expect(
      checkReceipt(base({ duplicatePhoto: true, duplicateFolio: true })).flags,
    ).toEqual(expect.arrayContaining(["duplicate_photo", "duplicate_folio"]));
  });

  it("a handwritten note without a time is informational only", () => {
    const r = checkReceipt(
      base({
        reading: {
          total: 4500,
          date: null,
          time: null,
          merchant: null,
          folio: null,
          handwritten: true,
        },
      }),
    );
    expect(r).toMatchObject({
      status: "ok",
      flags: ["handwritten", "no_time"],
    });
  });

  it("no receipt at all is 'sin ticket' and goes to review", () => {
    expect(checkReceipt(base({ reading: null }))).toMatchObject({
      status: "review",
      flags: ["sin_ticket"],
    });
  });
});
