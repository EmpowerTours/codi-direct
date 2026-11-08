/**
 * CLABE (Clave Bancaria Estandarizada): 18 digits = bank (3) + plaza (3) + account (11) + check digit (1).
 * Check digit: weights 3,7,1 repeating over the first 17 digits; sum of (digit × weight) mod 10;
 * check = (10 − sum mod 10) mod 10. pey rejects CLABEs with an invalid check digit.
 */
export function clabeCheckDigit(first17: string): number {
  const w = [3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += ((Number(first17[i]) * (w[i % 3] ?? 0)) % 10);
  return (10 - (sum % 10)) % 10;
}

export function isValidClabe(clabe: string): boolean {
  return /^\d{18}$/.test(clabe) && clabeCheckDigit(clabe.slice(0, 17)) === Number(clabe[17]);
}

/** "••••5713" — never show a full CLABE outside the owner's own profile. */
export const maskClabe = (clabe: string | null | undefined) => (clabe && clabe.length >= 4 ? `••••${clabe.slice(-4)}` : null);
