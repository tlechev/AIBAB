// @vitest-environment node
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Lint fixtures for the unsafe-SQL rules in eslint.config.mjs. Code is linted
 * in memory with the project's real configuration, as if it lived in src/.
 */
let eslint: ESLint;
beforeAll(() => {
  eslint = new ESLint({ cwd: process.cwd() });
});

async function restrictedSyntax(code: string, filePath = "src/server/db/__lint_fixture__.ts") {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? [])
    .filter((m) => m.ruleId === "no-restricted-syntax")
    .map((m) => m.message);
}

const sqlImport = `import { sql } from "drizzle-orm";\n`;
const declarations = [
  "declare const db: { execute(q: unknown): unknown };",
  "declare const tx: { unsafe(q: string): unknown };",
  "declare const userInput: string;",
  "",
].join("\n");

/** Builds a fixture module; `ownImports` cases bring their own drizzle import. */
const fixture = (body: string, ownImports = false) =>
  `${ownImports ? "" : sqlImport}${declarations}${body}`;

describe("unsafe SQL APIs are rejected in src/", () => {
  it.each([
    ["sql.raw() call", `export const q = sql.raw(userInput);`, false],
    ["sql.raw as a reference", `const r = sql.raw;\nexport const q = r(userInput);`, false],
    ["computed sql['raw']", `export const q = sql["raw"](userInput);`, false],
    ["destructured raw", `const { raw } = sql;\nexport const q = raw(userInput);`, false],
    [
      "namespace import d.sql.raw",
      `import * as d from "drizzle-orm";\nexport const q = d.sql.raw(userInput);`,
      true,
    ],
    [
      "renamed sql import",
      `import { sql as s } from "drizzle-orm";\nexport const q = s\`select 1\`;`,
      true,
    ],
    ["postgres.js .unsafe() call", `export const q = tx.unsafe(userInput);`, false],
    ["computed ['unsafe']", `export const q = tx["unsafe"](userInput);`, false],
    ["unsafe as a reference", `const u = tx.unsafe;\nexport const q = u(userInput);`, false],
    ["destructured unsafe", `const { unsafe } = tx;\nexport const q = unsafe(userInput);`, false],
    ["execute() with a string literal", `export const q = db.execute("select 1");`, false],
    [
      "execute() with an interpolated template string",
      "export const q = db.execute(`select * from t where id = '${userInput}'`);",
      false,
    ],
    ["execute() with concatenation", `export const q = db.execute("select " + userInput);`, false],
    // Bypass 1: execute() with a value held in a variable or produced by a call.
    [
      "execute() with a string held in a variable",
      `const query = "SELECT * FROM t WHERE id = '" + userInput + "'";\nexport const q = db.execute(query);`,
      false,
    ],
    [
      "execute() with a variable even if it holds sql",
      "const query = sql`select 1`;\nexport const q = db.execute(query);",
      false,
    ],
    [
      "execute() with a function result",
      `const build = () => "select 1";\nexport const q = db.execute(build());`,
      false,
    ],
    [
      "execute() with sql.join(...) instead of a template",
      "export const q = db.execute(sql.join([sql`a`, sql`b`], sql` `));",
      false,
    ],
    ["computed ['execute'] with a string", `export const q = db["execute"]("select 1");`, false],
    [
      "execute() with a tag other than sql",
      "const t = String.raw;\nexport const q = db.execute(t`select 1`);",
      false,
    ],
    // Bypass 2: copies and aliases of the imported sql object.
    [
      "alias const s2 = sql; s2.raw()",
      `const s2 = sql;\nexport const q = s2.raw(userInput);`,
      false,
    ],
    ["alias by assignment", `let s2: unknown;\ns2 = sql;\nexport const q = s2;`, false],
    [
      "sql passed to a function",
      `const wrap = (s: unknown) => s;\nexport const q = wrap(sql);`,
      false,
    ],
    ["sql stored in an object (shorthand)", `export const helpers = { sql };`, false],
    ["sql stored in an object (explicit value)", `export const helpers = { tag: sql };`, false],
    ["sql stored in an array", `export const list = [sql];`, false],
    ["sql re-exported", `export { sql };`, false],
    [
      "shadowing sql with a local value",
      `import { eq } from "drizzle-orm";\nconst sql = { raw: (s: string) => s };\nexport const q = [eq, sql.raw(userInput)];`,
      true,
    ],
    [
      "namespace import used for sql templates",
      'import * as d from "drizzle-orm";\nexport const q = d.sql`select 1`;',
      true,
    ],
    // Low-level construction APIs that embed raw SQL (see drizzle-sql-construction.test.ts).
    [
      "StringChunk import and construction",
      'import { sql, StringChunk } from "drizzle-orm";\nexport const q = sql`select ${new StringChunk(userInput)}`;',
      true,
    ],
    [
      "StringChunk from a deep import path",
      'import { sql } from "drizzle-orm";\nimport { StringChunk } from "drizzle-orm/sql/sql";\nexport const q = sql`${new StringChunk(userInput)}`;',
      true,
    ],
    [
      "new SQL([new StringChunk(...)])",
      'import { SQL, StringChunk } from "drizzle-orm";\nexport const q = new SQL([new StringChunk(userInput)]);',
      true,
    ],
    [
      "entityKind import (forging chunks)",
      'import { entityKind } from "drizzle-orm";\nexport class Fake { static [entityKind] = "StringChunk"; }',
      true,
    ],
    [
      "Symbol.for('drizzle:entityKind') forgery",
      'export class Fake { static [Symbol.for("drizzle:entityKind")] = "StringChunk"; value = [userInput]; }',
      false,
    ],
    [
      "leaking the StringChunk class via queryChunks",
      "const Leaked = sql`x`.queryChunks[0]!.constructor;\nexport const q = Leaked;",
      false,
    ],
    [
      "destructuring queryChunks",
      "const { queryChunks } = sql`x`;\nexport const q = queryChunks;",
      false,
    ],
    ["computed ['queryChunks']", 'export const q = sql`x`["queryChunks"];', false],
    [".inlineParams()", "export const q = sql`select ${userInput}`.inlineParams();", false],
    [
      "dynamic import of drizzle-orm",
      'export const q = async () => (await import("drizzle-orm")).sql;',
      false,
    ],
    [
      "require of drizzle-orm",
      'declare const require: (m: string) => unknown;\nexport const q = require("drizzle-orm");',
      false,
    ],
  ])("%s", async (_label, body, ownImports) => {
    const code = fixture(body, ownImports);
    expect((await restrictedSyntax(code)).length, code).toBeGreaterThan(0);
  });
});

describe("parameterized queries are allowed", () => {
  it.each([
    [
      "sql tagged template with a parameter",
      "export const q = sql`select * from t where id = ${userInput}`;",
    ],
    ["execute() with an sql template", "export const q = db.execute(sql`select ${userInput}`);"],
    [
      "sql.join of parameterized fragments",
      "export const q = sql.join([sql`a = ${userInput}`, sql`b = ${userInput}`], sql` and `);",
    ],
    [
      "the safe wrapper for composed queries: execute(sql`${fragment}`)",
      "const fragment = sql`select ${userInput}`;\nexport const q = db.execute(sql`${fragment}`);",
    ],
    [
      "generic execute<T>() with an sql template",
      "export const q = db.execute<{ id: string }>(sql`select ${userInput} as id`);",
    ],
    ["typed sql<T> template", "export const q = sql<number>`select ${userInput}`;"],
    ["other sql helpers", "export const q = [sql.identifier('name'), sql.empty()];"],
    ["typeof sql in a type position", "export type SqlTag = typeof sql;"],
    [
      "unrelated properties and keys named sql or raw",
      "const config = { rawMode: true, sql: 'text' };\nexport const q = [config.rawMode, config.sql];",
    ],
    [
      "interface with a property named sql",
      "export interface Report { sql: string }\nexport const q = sql`select 1`;",
    ],
    [
      "sql.join with an sql separator and sql.fromList (values stay parameters)",
      "export const q = [sql.join([sql`a = ${userInput}`], sql` and `), sql.fromList([userInput])];",
    ],
    [
      "sql.param and sql.placeholder",
      "export const q = [sql.param(userInput), sql.placeholder('id')];",
    ],
    [
      "SQL used as a type",
      'import type { SQL } from "drizzle-orm";\nexport const q: SQL = sql`select ${userInput}`;',
    ],
    [
      "non-drizzle dynamic import",
      "export const load = async (locale: string) => (await import(`../../messages/${locale}.json`)).default;",
    ],
  ])("%s", async (_label, body) => {
    const code = fixture(body);
    expect(await restrictedSyntax(code), code).toEqual([]);
  });
});

describe("rule composition", () => {
  const cast = `import type { VerifiedUserId } from "@/server/auth/verified-user-id";\nexport const id = "x" as VerifiedUserId;\n`;

  it("the VerifiedUserId rule still applies alongside the SQL rules", async () => {
    expect((await restrictedSyntax(cast)).join("\n")).toMatch(/VerifiedUserId/);
  });

  it("the session module may create VerifiedUserId but is still bound by the SQL rules", async () => {
    const filePath = "src/server/auth/session.ts";
    expect(await restrictedSyntax(cast, filePath)).toEqual([]);
    const raw = fixture("export const q = sql.raw(userInput);");
    expect((await restrictedSyntax(raw, filePath)).length).toBeGreaterThan(0);
  });

  it("tests and scripts outside src/ are not restricted", async () => {
    const raw = fixture("export const q = sql.raw(userInput);");
    expect(await restrictedSyntax(raw, "tests/db/__lint_fixture__.ts")).toEqual([]);
  });
});
