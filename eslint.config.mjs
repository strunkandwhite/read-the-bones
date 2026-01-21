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
    "out/**",
    "build/**",
    "next-env.d.ts",
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
  // CLI, build scripts, and core libraries can use console freely
  {
    files: ["src/cli/**/*.ts", "src/core/**/*.ts", "src/build/**/*.ts", "scripts/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
]);

export default eslintConfig;
