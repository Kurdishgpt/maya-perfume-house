# Cloudflare Workers deployment

The root `wrangler.jsonc` deploys the storefront and API together as one Worker.
It serves the Vite build from `artifacts/maya-perfume-shop/dist/public` and
dispatches `/api/*` requests to the existing API routes.

## Cloudflare build settings

Run commands from the repository root:

- Build: `PORT=22746 BASE_PATH=/ pnpm run build`
- Deploy: `pnpm exec wrangler deploy`

The Vite builds require `PORT` and `BASE_PATH` even though the deployed Worker
does not open a listening port. The explicit root Wrangler config prevents
Wrangler from trying to guess which package in the pnpm workspace to deploy.

Set these build-time variables in the Cloudflare build environment:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `PORT=22746`
- `BASE_PATH=/`

Set these Worker runtime variables/secrets in Cloudflare:

- Variable: `VITE_SUPABASE_URL`
- Secret: `SUPABASE_SERVICE_ROLE_KEY`
- Secret: `ADMIN_PANEL_PASSWORD`
- Secret: `SESSION_SECRET`
- Secret: `GEMINI_API_KEY`

The Supabase image bucket `maya-product-images` must exist. Keep the service-role
key private; only the public anon key belongs in the browser build.

## Cloudflare-specific limits

Legacy image URLs served from Replit Object Storage are not available in a
Cloudflare Worker. New product uploads use Supabase Storage; old Replit-hosted
images need to be copied to Supabase Storage and their product URLs updated.
The Replit-only fragrance image search connector also needs a Cloudflare-compatible
search provider before that optional admin feature can run there.
