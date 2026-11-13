import { is } from "drizzle-orm";
import { getTableConfig, isPgEnum, type PgEnum, PgTable } from "drizzle-orm/pg-core";
import { beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";

import { type Catalog, readCatalog } from "./catalog";
import { adminSql } from "./helpers";

/**
 * The SQL migrations are the source of truth. This file verifies that
 *   1. the Drizzle mirror matches the real database (both directions), and
 *   2. the security-relevant catalog matches the reviewed snapshot
 *      (`npm run db:snapshot` updates it deliberately), and
 *   3. security invariants hold regardless of the snapshot.
 */

let catalog: Catalog;
beforeAll(async () => {
  catalog = await readCatalog(adminSql);
});

const exported: unknown[] = Object.values(schema);
const drizzleTables = exported.filter((v): v is PgTable => is(v, PgTable));
const drizzleEnums = exported.filter((v): v is PgEnum<[string, ...string[]]> => isPgEnum(v));

/** `"app"."industry"` / `app.industry` / `industry` → `industry`; arrays keep `[]`. */
function normalizeType(type: string): string {
  return type
    .replace(/"/g, "")
    .replace(/^app\./, "")
    .replace(/^timestamp with time zone$/, "timestamptz")
    .replace(/^time without time zone$/, "time");
}

describe("Drizzle mirror ↔ database", () => {
  it("defines exactly the tables that exist in the app schema", () => {
    const mirrored = drizzleTables
      .map((t) => getTableConfig(t))
      .filter((c) => c.schema === "app")
      .map((c) => c.name)
      .sort();
    expect(mirrored).toEqual(catalog.tables.map((t) => t.table));
  });

  it("defines exactly the enums that exist in the app schema, with the same values", () => {
    const mirrored = drizzleEnums
      .map((e) => ({ name: e.enumName, values: [...e.enumValues] }))
      .sort((a, b) => a.name.localeCompare(b.name));
    expect(mirrored).toEqual(catalog.enums);
  });

  describe.each(drizzleTables.map((t) => [getTableConfig(t).name, getTableConfig(t)] as const))(
    "%s",
    (tableName, config) => {
      it("columns: names, types, nullability and defaults", () => {
        const db = catalog.columns
          .filter((c) => c.table === tableName)
          .map((c) => ({
            column: c.column,
            type: normalizeType(c.type),
            notNull: c.not_null,
            hasDefault: c.default !== null,
          }));
        const mirror = config.columns.map((c) => ({
          column: c.name,
          type: normalizeType(c.getSQLType()),
          notNull: c.notNull,
          hasDefault: c.hasDefault,
        }));
        const byName = (a: { column: string }, b: { column: string }) =>
          a.column.localeCompare(b.column);
        expect(mirror.sort(byName)).toEqual(db.sort(byName));
      });

      const dbConstraintColumns = (type: string) =>
        catalog.constraints
          .filter((c) => c.table === tableName && c.type === type)
          .map((c) => /\(([^)]*)\)/.exec(c.definition)?.[1]?.replace(/\s/g, "") ?? "")
          .sort();

      it("primary key", () => {
        const fromColumns = config.columns.filter((c) => c.primary).map((c) => c.name);
        const composite = config.primaryKeys.flatMap((pk) => pk.columns.map((c) => c.name));
        expect([[...fromColumns, ...composite].join(",")]).toEqual(dbConstraintColumns("p"));
      });

      it("unique constraints", () => {
        const fromColumns = config.columns.filter((c) => c.isUnique).map((c) => c.name);
        const tableLevel = config.uniqueConstraints.map((u) =>
          u.columns.map((c) => c.name).join(","),
        );
        expect([...fromColumns, ...tableLevel].sort()).toEqual(dbConstraintColumns("u"));
      });

      it("foreign keys: columns and referenced table", () => {
        const mirror = config.foreignKeys
          .map((fk) => {
            const ref = fk.reference();
            return `(${ref.columns.map((c) => c.name).join(",")})->${getTableConfig(ref.foreignTable).name}(${ref.foreignColumns.map((c) => c.name).join(",")})`;
          })
          .sort();
        const db = catalog.constraints
          .filter((c) => c.table === tableName && c.type === "f")
          .map((c) => {
            const m = /FOREIGN KEY \(([^)]*)\) REFERENCES (?:[a-z_]+\.)?([a-z_]+)\(([^)]*)\)/.exec(
              c.definition,
            );
            return `(${m?.[1]?.replace(/\s/g, "")})->${m?.[2]}(${m?.[3]?.replace(/\s/g, "")})`;
          })
          .sort();
        expect(mirror).toEqual(db);
      });

      it("named indexes declared in Drizzle exist", () => {
        const dbIndexes = catalog.indexes.filter((i) => i.table === tableName).map((i) => i.name);
        for (const index of config.indexes) {
          expect(dbIndexes).toContain(index.config.name);
        }
      });
    },
  );
});

describe("security catalog snapshot", () => {
  it("matches the reviewed snapshot (update deliberately with `npm run db:snapshot`)", async () => {
    await expect(`${JSON.stringify(catalog, null, 2)}\n`).toMatchFileSnapshot(
      "../../supabase/schema.snapshot.json",
    );
  });
});

describe("security invariants", () => {
  const ownRoles = new Set(["aibab_user", "aibab_definer"]);
  const forbiddenGrantees = /^(=|anon=|authenticated=|service_role=|aibab_app=)/;

  it("every app table has RLS enabled and is owned by postgres", () => {
    for (const table of catalog.tables) {
      expect(table.rls, table.table).toBe(true);
      expect(table.owner, table.table).toBe("postgres");
    }
  });

  it("policies apply only to AIBAB roles", () => {
    for (const policy of catalog.policies) {
      for (const role of policy.roles)
        expect(ownRoles.has(role), `${policy.table}.${policy.name}`).toBe(true);
    }
  });

  it("no table, column, schema or function grants to PUBLIC, API roles or aibab_app", () => {
    const acls = [
      ...catalog.tables.flatMap((t) => t.acl.map((a) => [t.table, a])),
      ...catalog.columns.flatMap((c) => c.acl.map((a) => [`${c.table}.${c.column}`, a])),
      ...catalog.schemas.flatMap((s) => s.acl.map((a) => [s.schema, a])),
      ...catalog.functions.flatMap((f) => f.acl.map((a) => [f.signature, a])),
    ];
    for (const [object, acl] of acls) expect(acl, object).not.toMatch(forbiddenGrantees);
  });

  it("every function has an explicit ACL, a fixed empty search_path and a known owner", () => {
    for (const fn of catalog.functions) {
      expect(
        fn.acl.length,
        `${fn.signature} must not rely on default (PUBLIC) privileges`,
      ).toBeGreaterThan(0);
      expect(fn.config, fn.signature).toContain('search_path=""');
      expect(["postgres", "aibab_definer"], fn.signature).toContain(fn.owner);
    }
  });

  it("SECURITY DEFINER functions are owned by aibab_definer (no BYPASSRLS), never by postgres", () => {
    const definers = catalog.functions.filter((f) => f.security_definer);
    expect(definers.length).toBeGreaterThan(0);
    for (const fn of definers) expect(fn.owner, fn.signature).toBe("aibab_definer");
  });

  it("SECURITY DEFINER functions take no user id parameter", () => {
    // Explicit allow-list of definer functions with uuid parameters. None of them
    // accepts the acting user: that is always app_private.current_user_id().
    const reviewedUuidParameters = new Set([
      // Answers only whether the caller shares an organization with that user.
      "app_private.shares_organization_with(uuid)",
      // The uuid is the target organization; the caller must be its owner/admin.
      "app.create_invitation(uuid,text,app.member_role,integer)",
    ]);
    for (const fn of catalog.functions.filter((f) => f.security_definer)) {
      if (fn.signature.includes("uuid")) {
        expect(reviewedUuidParameters.has(fn.signature), fn.signature).toBe(true);
      }
    }
  });

  it("aibab_definer has no UPDATE/DELETE on any table", () => {
    for (const table of catalog.tables) {
      const definerAcl = table.acl.find((a) => a.startsWith("aibab_definer="));
      if (!definerAcl) continue;
      const privileges = definerAcl.split("=")[1]!.split("/")[0]!;
      expect(privileges, table.table).not.toMatch(/[wdD]/);
    }
  });

  it("every tenant table is protected against cross-tenant references and moves", () => {
    const tenantTables = [
      ...new Set(catalog.columns.filter((c) => c.column === "organization_id").map((c) => c.table)),
    ].filter((t) => t !== "memberships");
    for (const table of tenantTables) {
      const hasCompositeTarget = catalog.constraints.some(
        (c) =>
          c.table === table &&
          (c.definition === "UNIQUE (organization_id, id)" ||
            c.definition === "PRIMARY KEY (organization_id)"),
      );
      expect(
        hasCompositeTarget,
        `${table}: (organization_id, id) unique or organization_id PK`,
      ).toBe(true);
      const immutable = catalog.triggers.some(
        (t) => t.table === table && t.definition.includes("prevent_organization_id_change"),
      );
      expect(immutable, `${table}: organization_id immutability trigger`).toBe(true);
    }
  });

  it("all types in the app schemas are owned by postgres", () => {
    for (const type of catalog.types) expect(type.owner, type.name).toBe("postgres");
  });
});
