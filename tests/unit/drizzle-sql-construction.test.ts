// @vitest-environment node
import { entityKind, SQL, sql, StringChunk } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

/**
 * Verifies, against the installed drizzle-orm, which SQL construction APIs embed
 * text as raw SQL and which turn values into bound parameters. The ESLint rules in
 * eslint.config.mjs forbid exactly the raw ones in src/ (docs/ARCHITECTURE.md § 7.1).
 */
const dialect = new PgDialect();
const compile = (query: SQL) => dialect.sqlToQuery(query);
const attack = "1; drop table app.organizations; --";

describe("APIs that embed raw SQL (forbidden in src/)", () => {
  it("StringChunk inside a template is emitted verbatim", () => {
    const query = compile(sql`select ${new StringChunk(attack)}`);
    expect(query.sql).toBe(`select ${attack}`);
    expect(query.params).toEqual([]);
  });

  it("new SQL([new StringChunk(...)]) is raw SQL", () => {
    expect(compile(new SQL([new StringChunk(attack)])).sql).toBe(attack);
  });

  it("sql.raw() is StringChunk under the hood", () => {
    expect(compile(sql`select ${sql.raw(attack)}`).sql).toBe(`select ${attack}`);
  });

  it("a forged chunk using Symbol.for('drizzle:entityKind') is treated as StringChunk", () => {
    // No drizzle import needed: the symbol is in the global registry.
    class ForgedChunk {
      value = [attack];
    }
    Object.defineProperty(ForgedChunk, Symbol.for("drizzle:entityKind"), { value: "StringChunk" });
    expect(entityKind).toBe(Symbol.for("drizzle:entityKind"));
    expect(compile(sql`select ${new ForgedChunk()}`).sql).toBe(`select ${attack}`);
  });

  it("the StringChunk class is reachable through queryChunks[n].constructor", () => {
    const template = sql`select 1`;
    const Leaked = template.queryChunks[0]!.constructor as new (value: string) => unknown;
    expect(compile(sql`select ${Leaked === StringChunk ? new Leaked(attack) : ""}`).sql).toBe(
      `select ${attack}`,
    );
  });
});

describe("APIs that keep values as bound parameters (allowed)", () => {
  it("values in sql`...` templates become parameters", () => {
    const query = compile(sql`select * from t where id = ${attack}`);
    expect(query.sql).toBe("select * from t where id = $1");
    expect(query.params).toEqual([attack]);
  });

  it("sql.join() with plain strings parameterizes items and the separator", () => {
    const query = compile(sql.join([attack, "b"], ", " as unknown as SQL));
    expect(query.sql).toBe("$1$2$3");
    expect(query.params).toEqual([attack, ", ", "b"]);
  });

  it("sql.join() of parameterized fragments with an sql separator", () => {
    const query = compile(sql.join([sql`a = ${attack}`, sql`b = ${1}`], sql` and `));
    expect(query.sql).toBe("a = $1 and b = $2");
    expect(query.params).toEqual([attack, 1]);
  });

  it("new SQL([...]) and sql.fromList() parameterize plain strings", () => {
    expect(compile(new SQL([attack])).sql).toBe("$1");
    expect(compile(sql.fromList([attack])).params).toEqual([attack]);
  });

  it("sql.identifier() escapes double quotes", () => {
    expect(compile(sql`select ${sql.identifier('a"; drop table x; --')}`).sql).toBe(
      'select "a""; drop table x; --"',
    );
  });

  it("sql.param() and sql.placeholder() are parameters", () => {
    expect(compile(sql`select ${sql.param(attack)}`).params).toEqual([attack]);
    expect(compile(sql`select ${sql.placeholder("id")}`).sql).toBe("select $1");
  });
});

describe(".inlineParams() (forbidden in src/: not raw, but removes parameterization)", () => {
  it("inlines strings as quoted literals with doubled single quotes", () => {
    const query = compile(sql`select ${"it's"}`.inlineParams());
    expect(query.sql).toBe("select 'it''s'");
    expect(query.params).toEqual([]);
  });
});
