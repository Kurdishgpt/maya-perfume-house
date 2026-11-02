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

Replit Secrets do not automatically copy to Cloudflare. Set these values on the
Cloudflare Worker itself, and make sure `VITE_SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` belong to the same Supabase project. The build-time
`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` must also point to that project.

After deploying, verify `GET /api/supabase/status` returns
`{"status":"connected"}` and `GET /api/products` returns HTTP 200. If the
status says `schema_not_ready`, check the Worker’s Supabase project URL and
service-role key; the workspace’s Supabase database already contains the
required catalog tables. If `POST /api/admin/passcode` returns HTTP 403, update
the Cloudflare Worker secret `ADMIN_PANEL_PASSWORD` to the passcode you intend
to use. Do not put the passcode or service-role key in this repository.

The Supabase image bucket `maya-product-images` must exist. Keep the service-role
key private; only the public anon key belongs in the browser build.

## Administrator password changes

Apply `supabase/migrations/202611020002_admin_password_settings.sql` to the same
Supabase project to enable **Admin → Settings → Change administrator password**.
The configured Worker `ADMIN_PANEL_PASSWORD` remains the initial password until
the administrator changes it. The replacement is stored only as a salted
PBKDF2 hash in the private `admin_auth_settings` table. Changing it signs out
other administrator sessions; the current session receives a new unlock cookie.

## Cloudflare-specific limits

Legacy image URLs served from Replit Object Storage are not available in a
Cloudflare Worker. New product uploads use Supabase Storage; old Replit-hosted
images need to be copied to Supabase Storage and their product URLs updated.
The Replit-only fragrance image search connector also needs a Cloudflare-compatible
search provider before that optional admin feature can run there.

## SEO discovery and public sitemaps

Before using **Admin → SEO Discovery**, apply
`supabase/migrations/202611020001_seo_discovery.sql` to the same Supabase project
used by this Worker. In Supabase SQL Editor, review and run that additive
migration. It creates private crawl-history and discovery tables; the Worker
accesses them with its service-role secret. No schema changes are applied
automatically by this repository.

The worker is configured for `https://mayacolllection.com` through
`SEO_SITE_ORIGIN`. Update that plain Worker variable if the production hostname
changes. The crawler follows the site's `robots.txt`, stays on that HTTPS
origin, limits a run to 500 URLs and 1 MB per response, checks at most eight
pages per batch, and waits between page requests. It does not sign in, bypass
CAPTCHAs, or fetch off-site redirects. Products are discovered from the public
`/api/products` catalog and the verified `/product/{id}` route. Raw materials
are catalog entries on `/raw-material`, not separate detail pages, so their
dashboard links open a filtered listing item and they are not duplicated in
the product sitemap.

Public XML endpoints include `/sitemap.xml` (the full URL list),
`/products-sitemap.xml`, `/pages-sitemap.xml`, and `/images-sitemap.xml`.
`robots.txt` points to the index and excludes admin, cart, checkout, wishlist,
and welcome routes. Sitemap generation uses successfully checked canonical,
indexable records only; unknown `lastmod` values are omitted.

The storefront build also refreshes XML copies of these routes from the public
SEO API before Vite builds. This is required for static hosting, where the
single-page-app fallback would otherwise return `index.html` for `/sitemap.xml`.
Run `pnpm --filter @workspace/maya-perfume-shop run refresh:sitemaps` to refresh
the public files without a full build. A failed or incomplete source response
stops the build rather than publishing an empty sitemap.

Cloudflare Cron Triggers are configured every 15 minutes. They process one
small batch at a time and start a new crawl only when scheduled crawling is
enabled in the admin dashboard and its configured interval has elapsed
(24 hours by default). A manual crawl can also be started and monitored in the
dashboard. Search Console is currently not connected: indexing counts stay
unknown until authorized Search Console data is configured. The sitemap can
still be submitted manually in Search Console; submission does not guarantee
indexing.
