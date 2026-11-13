import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Security boundaries (docs/ARCHITECTURE.md, "Trust boundary").
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/server/auth/session.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "TSAsExpression > TSTypeReference[typeName.name='VerifiedUserId'], TSTypeAssertion > TSTypeReference[typeName.name='VerifiedUserId']",
          message:
            "VerifiedUserId may only be created from a verified Supabase session (src/server/auth/session.ts).",
        },
      ],
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
