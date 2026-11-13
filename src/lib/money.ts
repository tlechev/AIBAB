/**
 * Money helpers. Amounts are always integer minor units (cents, ADR-003).
 * Locale and currency are explicit inputs: they come from the organization's
 * regional settings, never from a hard-coded market default (ADR-006).
 */

/** ISO 4217 codes the platform supports. Extend when entering a new market. */
export const SUPPORTED_CURRENCIES = ["EUR"] as const;
export type CurrencyCode = (typeof SUPPORTED_CURRENCIES)[number];

export type MoneyFormatOptions = {
  /** BCP 47 locale used for display, e.g. "bg-BG" or "en-IE". */
  locale: string;
  currency: CurrencyCode;
};

function assertCents(amountCents: number): void {
  if (!Number.isSafeInteger(amountCents)) {
    throw new RangeError(`Amount must be an integer number of cents, received: ${amountCents}`);
  }
}

export function formatMoney(amountCents: number, { locale, currency }: MoneyFormatOptions): string {
  assertCents(amountCents);
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amountCents / 100);
}

/**
 * Formats a service price range, e.g. "50,00 €" and "120,00 €".
 * A `null` upper bound means "from" pricing; the label is localized by the caller.
 */
export function formatPriceRange(
  fromCents: number,
  toCents: number | null,
  options: MoneyFormatOptions,
): { from: string; to: string | null } {
  assertCents(fromCents);
  if (toCents !== null) {
    assertCents(toCents);
    if (toCents < fromCents) {
      throw new RangeError("Price range upper bound is lower than the lower bound");
    }
  }
  return {
    from: formatMoney(fromCents, options),
    to: toCents === null ? null : formatMoney(toCents, options),
  };
}
