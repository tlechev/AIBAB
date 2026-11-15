import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * VerifiedUserId may only be created from a verified session (ADR-010).
 * @type {{ selector: string; message: string }[]}
 */
const verifiedUserIdRules = [
  {
    selector:
      "TSAsExpression > TSTypeReference[typeName.name='VerifiedUserId'], TSTypeAssertion > TSTypeReference[typeName.name='VerifiedUserId']",
    message:
      "VerifiedUserId may only be created from a verified Supabase session (src/server/auth/session.ts).",
  },
];

/**
 * Unsafe SQL APIs (docs/ARCHITECTURE.md § 7.1): SQL injection in the runtime
 * connection would allow impersonating any user, so app code may only build
 * queries with parameterized Drizzle APIs (`sql` tagged templates, query builder).
 * @type {{ selector: string; message: string }[]}
 */
const unsafeSqlRules = [
  {
    // sql.raw(...), sql.raw as a reference, sql["raw"], ns.sql.raw
    selector:
      "MemberExpression[property.name='raw'][object.name='sql'], MemberExpression[property.value='raw'][object.name='sql'], MemberExpression[property.name='raw'][object.property.name='sql']",
    message: "sql.raw() inserts unescaped SQL. Use sql`...` with ${parameters} instead.",
  },
  {
    // const { raw } = sql
    selector: "VariableDeclarator[init.name='sql'] > ObjectPattern > Property[key.name='raw']",
    message: "sql.raw() inserts unescaped SQL. Use sql`...` with ${parameters} instead.",
  },
  {
    // Any .unsafe member (postgres.js sql.unsafe / tx.unsafe), including references and ["unsafe"]
    selector: "MemberExpression[property.name='unsafe'], MemberExpression[property.value='unsafe']",
    message: "postgres.js .unsafe() runs unescaped SQL. Use parameterized Drizzle queries.",
  },
  {
    // const { unsafe } = client
    selector: "ObjectPattern > Property[key.name='unsafe']",
    message: "postgres.js .unsafe() runs unescaped SQL. Use parameterized Drizzle queries.",
  },
  {
    // Drizzle's execute(query: SQLWrapper | string) runs strings unparameterized, and a
    // variable may hold a string. Only a direct sql`...` template is accepted. To
    // compose a query dynamically, wrap it: tx.execute(sql`${fragment}`) — Drizzle
    // embeds SQL fragments as SQL and plain strings as bound parameters.
    selector:
      "CallExpression:matches([callee.property.name='execute'], [callee.property.value='execute']):not([arguments.0.type='TaggedTemplateExpression'][arguments.0.tag.name='sql'])",
    message:
      "execute() only accepts a direct sql`...` template. Wrap dynamic queries as sql`${fragment}`.",
  },
  {
    // The imported `sql` may only be used as a template tag, as `sql.<member>` (sql.raw is
    // forbidden above), in its import, in `typeof sql`, or as a property/key name. This
    // prevents aliases that would evade the rules: `const s2 = sql`, fn(sql), { sql },
    // export { sql }, and shadowing (`const sql = ...`).
    selector:
      "Identifier[name='sql']:not(TaggedTemplateExpression > Identifier.tag, MemberExpression > Identifier.object, MemberExpression[computed=false] > Identifier.property, ImportSpecifier > Identifier, TSTypeQuery > Identifier, Property[computed=false][shorthand=false] > Identifier.key, TSPropertySignature > Identifier.key)",
    message:
      "Use the drizzle `sql` import only as sql`...` or sql.<helper>; do not alias, pass, re-export or shadow it.",
  },
  {
    // import { sql as q } from "drizzle-orm" would hide q.raw from the rules above
    selector:
      "ImportDeclaration[source.value=/^drizzle-orm/] > ImportSpecifier[imported.name='sql'][local.name!='sql']",
    message:
      "Import `sql` from drizzle-orm without renaming it (keeps unsafe-SQL checks effective).",
  },
  {
    // StringChunk is emitted verbatim (sql.raw is `new SQL([new StringChunk(str)])`).
    // Verified against the installed drizzle-orm in tests/unit/drizzle-sql-construction.test.ts.
    selector: "Identifier[name='StringChunk']",
    message: "StringChunk embeds raw SQL. Use sql`...` with ${parameters} instead.",
  },
  {
    // Drizzle recognizes chunks by the global symbol Symbol.for("drizzle:entityKind"),
    // so any class carrying it can impersonate StringChunk.
    selector:
      "Identifier[name=/^(entityKind|hasOwnEntityKind)$/], MemberExpression[object.name='Symbol'][property.name='for']",
    message: "Drizzle entity symbols can forge raw SQL chunks; they are not for application code.",
  },
  {
    // template.queryChunks[n].constructor is the StringChunk class.
    selector:
      "MemberExpression[property.name='queryChunks'], MemberExpression[property.value='queryChunks'], ObjectPattern > Property[key.name='queryChunks']",
    message: "SQL.queryChunks exposes raw SQL internals. Compose queries with sql`...` instead.",
  },
  {
    // .inlineParams() turns bound parameters into inlined literals.
    selector:
      "MemberExpression[property.name='inlineParams'], MemberExpression[property.value='inlineParams']",
    message: ".inlineParams() removes query parameterization. Keep values as bound parameters.",
  },
  {
    // Dynamic import/require of drizzle-orm would bypass the import-based checks.
    selector:
      "ImportExpression[source.value=/^drizzle-orm/], CallExpression[callee.name='require'][arguments.0.value=/^drizzle-orm/]",
    message: "Import drizzle-orm statically with named imports.",
  },
  {
    // import * as d from "drizzle-orm" would allow d.sql to be copied without the identifier rule seeing it
    selector: "ImportDeclaration[source.value=/^drizzle-orm/] > ImportNamespaceSpecifier",
    message: 'Use named imports from drizzle-orm (e.g. `import { sql } from "drizzle-orm"`).',
  },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Security boundaries (docs/ARCHITECTURE.md § 7.1). Flat config replaces, not
  // merges, a rule set for the same file, so each block lists every selector it needs.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/server/auth/session.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...verifiedUserIdRules, ...unsafeSqlRules],
    },
  },
  {
    files: ["src/server/auth/session.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...unsafeSqlRules],
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/server/db/client.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "postgres",
              message:
                "Use getDatabase() + withUserTx() from src/server/db instead of a raw client.",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
