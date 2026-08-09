import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  prettier,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".next-e2e/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Git worktrees have their own linting context
    ".worktrees/**",
    ".claude/worktrees/**",
    // Gitignored working data: draft CSVs, decklist URLs, screenshots, and
    // investigation scratch scripts. Not part of the codebase, and linting it
    // fails the build over console statements in throwaway tooling.
    "data/**",
  ]),
  {
    rules: {
      // Allow console in app code (warn) but fix unused vars (error)
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // External SVGs from CDN don't benefit from next/image optimization
      "@next/next/no-img-element": "off",
    },
  },
  // Build scripts and core libraries can use console freely
  {
    files: ["src/core/**/*.ts", "src/build/**/*.ts", "scripts/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
  // Test files can use `any` for mocks
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "src/core/db/__tests__/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
]);

export default eslintConfig;
