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
      // Remote-proxied bindings (Workers AI, Images) require authenticating
      // against the deployed worker's domain, which sits behind Cloudflare
      // Access — without an Access service token, `vinext dev` exits at
      // startup (docs/troubleshooting.md). Off by default so local dev works
      // out of the box; opt in when Access credentials are configured:
      //   ENABLE_REMOTE_BINDINGS=1 npm run dev
      // Dev-server-only setting; deploys via `wrangler deploy` are unaffected.
      remoteBindings: process.env.ENABLE_REMOTE_BINDINGS === "1",
    }),
  ],
});
