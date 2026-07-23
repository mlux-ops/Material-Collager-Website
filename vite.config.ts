import vinext from "vinext";
import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { sites } from "./build/sites-vite-plugin";

// Bindings, worker entry, and compatibility flags come from wrangler.jsonc
// (auto-discovered by the Cloudflare plugin). Local dev simulates D1/R2 via
// Miniflare; deploys go to the Cloudflare account configured in CI — see
// docs/DEPLOYING.md. The sites() plugin still packages .openai/hosting.json
// so the legacy OpenAI Sites hosting path keeps working if ever needed.
export default defineConfig({
  plugins: [
    vinext(),
    sites(),
    cloudflare({
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
    }),
  ],
});
