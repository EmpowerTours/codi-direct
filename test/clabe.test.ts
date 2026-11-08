import { describe, expect, it } from "vitest";
import { clabeCheckDigit, isValidClabe, maskClabe } from "../src/clabe.js";

describe("CLABE", () => {
  it("accepts the five pre-authorized hackathon CLABEs (real accounts)", () => {
    for (const c of ["012180015826225713", "012180015913466252", "014180606004536217", "012180015355682429", "127180016558860385"]) expect(isValidClabe(c), c).toBe(true);
  });
  it("rejects a wrong check digit, wrong length and non-digits", () => {
    expect(isValidClabe("012180015826225714")).toBe(false);
    expect(isValidClabe("01218001582622571")).toBe(false);
    expect(isValidClabe("01218001582622571a")).toBe(false);
  });
  it("computes the check digit and masks", () => {
    expect(clabeCheckDigit("01218001582622571")).toBe(3);
    expect(maskClabe("012180015826225713")).toBe("••••5713");
  });
});
