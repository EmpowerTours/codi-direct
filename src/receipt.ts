import { distanceKm, type LatLng } from "./geo.js";

/**
 * Receipt verification. An AI model only READS the photo (total, date, time, store, folio);
 * every decision below is deterministic code, so the same inputs always give the same verdict.
 * Nothing here blocks an order: a failed check marks it "review" with the reasons, shown to the
 * customer before they approve the CoDi charge and to admins.
 */
export interface ReceiptReading {
  /** Centavos; null if the model could not read a total. */
  total: number | null;
  /** "YYYY-MM-DD" as printed, or null. */
  date: string | null;
  /** "HH:MM" 24h as printed, or null. */
  time: string | null;
  merchant: string | null;
  folio: string | null;
  handwritten: boolean;
}

export interface ReceiptCheckInput {
  /** null = no reader configured, or the photo had no readable receipt ("sin ticket"). */
  reading: ReceiptReading | null;
  /** Amount the courier confirmed, centavos. */
  amount: number;
  /** What the customer said it costs (their own price), centavos. */
  expectedItems: number;
  /** When the courier was assigned the order. */
  acceptedAt: Date;
  /** Server time of the upload. */
  uploadedAt: Date;
  /** Courier GPS at upload; null if the app did not send it. */
  courierLocation: LatLng | null;
  pickup: LatLng;
  duplicatePhoto: boolean;
  duplicateFolio: boolean;
  /** Minutes east of UTC for the receipt's local time. Mexico City: -360 (no DST since 2022). */
  tzOffsetMinutes?: number;
  maxStoreDistanceM?: number;
  /** Tolerance for store clocks that run fast/slow. */
  clockSkewMinutes?: number;
}

export type ReceiptFlag =
  | "sin_ticket"
  | "total_unreadable"
  | "total_mismatch"
  | "over_customer_price"
  | "not_today"
  | "before_order_accepted"
  | "after_upload"
  | "no_location"
  | "far_from_store"
  | "duplicate_photo"
  | "duplicate_folio"
  // informational only (never trigger review on their own)
  | "handwritten"
  | "no_time";

const INFO: ReadonlySet<ReceiptFlag> = new Set(["handwritten", "no_time"]);

export interface ReceiptCheck {
  status: "ok" | "review";
  flags: ReceiptFlag[];
  /** Distance from the courier to the pickup at upload, meters (null without GPS). */
  distanceM: number | null;
}

/** Local wall-clock parts of an instant at a fixed UTC offset. */
function localParts(d: Date, offsetMin: number) {
  const t = new Date(d.getTime() + offsetMin * 60_000);
  const date = t.toISOString().slice(0, 10);
  return { date, minutes: t.getUTCHours() * 60 + t.getUTCMinutes() };
}

/** Receipt-local "YYYY-MM-DD" + "HH:MM" → absolute instant. */
function receiptInstant(
  date: string,
  time: string,
  offsetMin: number,
): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const h = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!m || !h) return null;
  const [, y, mo, d] = m.map(Number) as [number, number, number, number];
  const [, hh, mm] = h.map(Number) as [number, number, number];
  const utc = Date.UTC(y, mo - 1, d, hh, mm) - offsetMin * 60_000;
  return Number.isFinite(utc) ? new Date(utc) : null;
}

export function checkReceipt(i: ReceiptCheckInput): ReceiptCheck {
  const tz = i.tzOffsetMinutes ?? -360;
  const skewMs = (i.clockSkewMinutes ?? 15) * 60_000;
  const maxM = i.maxStoreDistanceM ?? 300;
  const flags: ReceiptFlag[] = [];

  // Above the customer's own price (the route already rejects anything over price + buffer).
  if (i.amount > i.expectedItems) flags.push("over_customer_price");

  const r = i.reading;
  if (!r) flags.push("sin_ticket");
  else {
    if (r.handwritten) flags.push("handwritten");
    if (r.total === null) flags.push("total_unreadable");
    else if (r.total !== i.amount) flags.push("total_mismatch");
    const today = localParts(i.uploadedAt, tz).date;
    if (r.date && r.date !== today) flags.push("not_today");
    if (!r.time) flags.push("no_time");
    else if (r.date) {
      const at = receiptInstant(r.date, r.time, tz);
      if (at && at.getTime() < i.acceptedAt.getTime() - skewMs)
        flags.push("before_order_accepted");
      if (at && at.getTime() > i.uploadedAt.getTime() + skewMs)
        flags.push("after_upload");
    }
  }

  let distanceM: number | null = null;
  if (!i.courierLocation) flags.push("no_location");
  else {
    distanceM = Math.round(distanceKm(i.courierLocation, i.pickup) * 1000);
    if (distanceM > maxM) flags.push("far_from_store");
  }
  if (i.duplicatePhoto) flags.push("duplicate_photo");
  if (i.duplicateFolio) flags.push("duplicate_folio");

  return {
    status: flags.some((f) => !INFO.has(f)) ? "review" : "ok",
    flags,
    distanceM,
  };
}

/** Spanish reasons shown to the customer and admin. */
export const RECEIPT_FLAG_ES: Record<ReceiptFlag, string> = {
  sin_ticket: "Sin ticket: el repartidor escribió el monto",
  total_unreadable: "No se pudo leer el total del ticket",
  total_mismatch: "El total del ticket no coincide con el monto capturado",
  over_customer_price: "Cuesta más de lo que dijiste",
  not_today: "El ticket no es de hoy",
  before_order_accepted: "El ticket es de antes de aceptar tu pedido",
  after_upload: "La hora del ticket es posterior a la foto",
  no_location: "Sin ubicación del repartidor al subir el ticket",
  far_from_store: "El repartidor no estaba en la tienda al subir el ticket",
  duplicate_photo: "Esta foto ya se usó en otro pedido",
  duplicate_folio: "Este folio ya se usó en otro pedido",
  handwritten: "Nota escrita a mano",
  no_time: "El ticket no tiene hora",
};
