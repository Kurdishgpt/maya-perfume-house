---
name: Cloudflare Workers runtime
description: Runtime boundaries for the Maya store's Cloudflare Worker deployment.
---

Keep the Cloudflare entry fetch-based and isolate platform adaptation at the Worker boundary. Share API business routes, but do not rely on a listening Node HTTP server, Replit Object Storage sidecars, or Replit-only connectors in the Worker runtime. Supabase Storage is the supported path for new product uploads.

**Why:** Cloudflare Workers handle Fetch requests and do not provide Replit's local sidecar services; Node HTTP server adapters are not a drop-in replacement.

**How to apply:** Verify compatibility using `wrangler dev` and `wrangler deploy --dry-run`. Before migrating additional endpoints, identify any Node server APIs or Replit integrations they depend on and replace those dependencies with Worker-compatible services.
