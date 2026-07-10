import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "dist/**",
    "out/**",
    "build/**",
    ".pip-temp/**",
    ".pytest_cache/**",
    ".test-work/**",
    ".vinext/**",
    ".wrangler/**",
    "tmp*/**",
    "grabbed-references/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
