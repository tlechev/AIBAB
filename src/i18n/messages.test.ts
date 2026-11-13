import { describe, expect, it } from "vitest";

import bg from "../../messages/bg.json";
import en from "../../messages/en.json";
import { defaultLocale, isLocale, locales } from "./config";

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ""): Record<string, string> {
  return Object.entries(tree).reduce<Record<string, string>>((acc, [key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === "string"
      ? { ...acc, [path]: value }
      : { ...acc, ...flatten(value, path) };
  }, {});
}

describe("translation messages", () => {
  const bgFlat = flatten(bg);
  const enFlat = flatten(en);

  it("bg and en define exactly the same keys", () => {
    expect(Object.keys(enFlat).sort()).toEqual(Object.keys(bgFlat).sort());
  });

  it("has no empty strings", () => {
    for (const [key, value] of Object.entries({ ...bgFlat, ...enFlat })) {
      expect(value.trim(), key).not.toBe("");
    }
  });
});

describe("locale config", () => {
  it("defaults to Bulgarian", () => {
    expect(defaultLocale).toBe("bg");
    expect(locales).toContain("en");
  });

  it("validates locales", () => {
    expect(isLocale("bg")).toBe(true);
    expect(isLocale("de")).toBe(false);
  });
});
