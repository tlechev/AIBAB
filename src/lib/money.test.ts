import { describe, expect, it } from "vitest";

import { formatMoney, formatPriceRange, type MoneyFormatOptions } from "./money";

// Intl output may use non-breaking spaces; normalize for readable assertions.
const normalize = (value: string) => value.replace(/[  ]/g, " ");

const bgEur: MoneyFormatOptions = { locale: "bg-BG", currency: "EUR" };
const enEur: MoneyFormatOptions = { locale: "en-IE", currency: "EUR" };

describe("formatMoney", () => {
  it("formats cents as EUR in the Bulgarian locale", () => {
    expect(normalize(formatMoney(12_350, bgEur))).toBe("123,50 €");
  });

  it("formats zero", () => {
    expect(normalize(formatMoney(0, bgEur))).toBe("0,00 €");
  });

  it("formats the same amount for an English locale", () => {
    expect(formatMoney(12_350, enEur)).toBe("€123.50");
  });

  it("rejects fractional cents", () => {
    expect(() => formatMoney(10.5, bgEur)).toThrow(RangeError);
  });
});

describe("formatPriceRange", () => {
  it("formats a closed range", () => {
    const range = formatPriceRange(5_000, 12_000, bgEur);
    expect(normalize(range.from)).toBe("50,00 €");
    expect(normalize(range.to ?? "")).toBe("120,00 €");
  });

  it("supports open-ended 'from' pricing", () => {
    expect(formatPriceRange(5_000, null, bgEur).to).toBeNull();
  });

  it("rejects an inverted range", () => {
    expect(() => formatPriceRange(12_000, 5_000, bgEur)).toThrow(RangeError);
  });
});
