import { Router, type IRouter } from "express";
import {
  GetSeoSummaryResponse, ListSeoCrawlsResponse, ListSeoRecordsQueryParams,
  ListSeoRecordsResponse, StartSeoCrawlResponse, StepSeoCrawlResponse,
  UpdateSeoSettingsBody, UpdateSeoSettingsResponse,
} from "@workspace/api-zod";
import { requireAdmin } from "../middlewares/requireAdmin";
import { getSupabaseAdmin } from "../lib/supabase";
import { processSeoCrawlBatch, startSeoCrawl } from "../lib/seoCrawler";

const router: IRouter = Router();
const defaultOrigin = () => (process.env.SEO_SITE_ORIGIN || "https://mayacolllection.com").replace(/\/+$/, "");
const cleanRun = (row: Record<string, unknown>) => ({
  ...row,
  remaining_urls: Array.isArray(row.queue_urls) ? row.queue_urls.length : 0,
});
const escapeXml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");

router.use("/admin/seo", requireAdmin, (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

router.get("/admin/seo/summary", async (req, res): Promise<void> => {
  try {
    const db = getSupabaseAdmin();
    const base = () => db.from("seo_discovery_records").select("url", { count: "exact", head: true }).eq("is_removed", false);
    const [pages, products, rawMaterials, successful, broken, images, current, latest, settings] = await Promise.all([
      base().eq("page_type", "page"),
      base().eq("page_type", "product"),
      base().eq("page_type", "raw_material"),
      base().gte("http_status", 200).lt("http_status", 300),
      base().gte("http_status", 400),
      db.from("seo_discovery_records").select("image_urls").eq("is_removed", false),
      db.from("seo_crawl_runs").select("*").eq("status", "running").order("started_at", { ascending: false }).limit(1).maybeSingle(),
      db.from("seo_crawl_runs").select("completed_at,sitemap_generated_at,crawl_errors,broken_links").order("started_at", { ascending: false }).limit(1).maybeSingle(),
      db.from("seo_crawl_settings").select("*").eq("id", 1).maybeSingle(),
    ]);
    const failures = [pages, products, rawMaterials, successful, broken, images, current, latest, settings].find((result) => result.error);
    if (failures?.error) throw failures.error;
    const imageCount = new Set((images.data ?? []).flatMap((row) => Array.isArray(row.image_urls) ? row.image_urls : [])).size;
    res.json(GetSeoSummaryResponse.parse({
      pages_discovered: pages.count ?? 0, products_discovered: products.count ?? 0,
      raw_materials_discovered: rawMaterials.count ?? 0, images_discovered: imageCount,
      successful_urls: successful.count ?? 0, broken_links: latest.data?.broken_links ?? broken.count ?? 0,
      crawl_errors: Array.isArray(latest.data?.crawl_errors) ? latest.data.crawl_errors.length : 0,
      last_crawl_at: latest.data?.completed_at ?? null,
      sitemap_generated_at: latest.data?.sitemap_generated_at ?? null,
      current_run: current.data ? cleanRun(current.data) : null,
      scheduled_enabled: settings.data?.scheduled_enabled ?? false,
      google_search_console_connected: false,
      verified_indexed_pages: null,
    }));
  } catch (error) {
    req.log.error({ err: error }, "SEO summary could not load");
    res.status(503).json({ error: "SEO storage is not ready. Apply the Supabase SEO migration and retry." });
  }
});

router.get("/admin/seo/records", async (req, res): Promise<void> => {
  const parsed = ListSeoRecordsQueryParams.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Invalid record filters." }); return; }
  try {
    const { search, kind, issue, sitemap, page = 1, per_page = 20 } = parsed.data;
    let query = getSupabaseAdmin().from("seo_discovery_records")
      .select("url,canonical_url,page_type,title,description,image_urls,price,currency,http_status,last_checked_at,last_modified,indexable,sitemap_included,issue_codes,category,google_index_status", { count: "exact" })
      .eq("is_removed", false)
      .order("last_checked_at", { ascending: false, nullsFirst: false });
    if (search?.trim()) {
      const term = search.trim().replace(/[\\%_]/g, "\\$&");
      query = query.ilike("search_text", `%${term}%`);
    }
    if (kind && kind !== "all") query = query.eq("page_type", kind);
    if (issue) query = query.contains("issue_codes", [issue]);
    if (sitemap === "included") query = query.eq("sitemap_included", true);
    if (sitemap === "excluded") query = query.eq("sitemap_included", false);
    const start = (page - 1) * per_page;
    const { data, count, error } = await query.range(start, start + per_page - 1);
    if (error) throw error;
    res.json(ListSeoRecordsResponse.parse({
      items: data ?? [], total: count ?? 0, page, per_page,
      pages: Math.ceil((count ?? 0) / per_page),
    }));
  } catch (error) {
    req.log.error({ err: error }, "SEO record search failed");
    res.status(503).json({ error: "SEO records could not be loaded. Check the database setup and retry." });
  }
});

router.get("/admin/seo/crawls", async (req, res): Promise<void> => {
  try {
    const { data, error } = await getSupabaseAdmin().from("seo_crawl_runs")
      .select("*").order("started_at", { ascending: false }).limit(20);
    if (error) throw error;
    res.json(ListSeoCrawlsResponse.parse({ items: (data ?? []).map(cleanRun) }));
  } catch (error) {
    req.log.error({ err: error }, "SEO crawl history could not load");
    res.status(503).json({ error: "Crawl history is unavailable until the SEO database migration is applied." });
  }
});

router.post("/admin/seo/crawls", async (req, res): Promise<void> => {
  try {
    const run = await startSeoCrawl(false);
    res.status(202).json(StartSeoCrawlResponse.parse(cleanRun(run as unknown as Record<string, unknown>)));
  } catch (error) {
    const message = error instanceof Error ? error.message : "A crawl could not start.";
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    res.status(message.includes("already running") || code === "23505" ? 409 : 503).json({ error: message });
  }
});

router.post("/admin/seo/crawls/:id/step", async (req, res): Promise<void> => {
  try {
    const run = await processSeoCrawlBatch(req.params.id);
    res.json(StepSeoCrawlResponse.parse(cleanRun(run as unknown as Record<string, unknown>)));
  } catch (error) {
    req.log.error({ err: error }, "SEO crawl batch failed");
    res.status(503).json({ error: error instanceof Error ? error.message : "Crawl batch failed." });
  }
});

router.patch("/admin/seo/settings", async (req, res): Promise<void> => {
  const parsed = UpdateSeoSettingsBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Choose whether scheduled crawling is enabled." }); return; }
  try {
    const db = getSupabaseAdmin();
    const { data, error } = await db.from("seo_crawl_settings").update({
      scheduled_enabled: parsed.data.scheduled_enabled, updated_at: new Date().toISOString(),
    }).eq("id", 1).select("*").single();
    if (error || !data) throw error ?? new Error("Settings row not found.");
    const { data: latest } = await db.from("seo_crawl_runs").select("completed_at")
      .order("started_at", { ascending: false }).limit(1).maybeSingle();
    const nextAt = data.scheduled_enabled && latest?.completed_at
      ? new Date(new Date(latest.completed_at).getTime() + Number(data.interval_hours) * 3_600_000).toISOString()
      : null;
    res.json(UpdateSeoSettingsResponse.parse({
      scheduled_enabled: data.scheduled_enabled, interval_hours: data.interval_hours,
      site_origin: defaultOrigin(), next_crawl_at: nextAt,
    }));
  } catch (error) {
    req.log.error({ err: error }, "SEO schedule settings failed");
    res.status(503).json({ error: "Scheduled crawl settings are unavailable. Apply the SEO database migration." });
  }
});

async function sitemapXml(path: string, origin: string): Promise<string> {
  const db = getSupabaseAdmin();
  const { data, error } = await db.from("seo_discovery_records")
    .select("canonical_url,page_type,last_modified,image_urls")
    .eq("is_removed", false).eq("indexable", true).eq("sitemap_included", true)
    .gte("http_status", 200).lt("http_status", 300).limit(1000);
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    canonical_url: string;
    page_type: string;
    last_modified: string | null;
    image_urls: string[] | null;
  }>;
  if (path === "/seo/sitemap.xml" || path === "/seo/sitemap-index.xml") {
    const lastmod = rows.reduce<string | null>((latest, row) =>
      row.last_modified && (!latest || row.last_modified > latest) ? row.last_modified : latest, null);
    const childMaps = ["pages-sitemap.xml", "products-sitemap.xml", "images-sitemap.xml"];
    return `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${childMaps.map((name) =>
      `<sitemap><loc>${escapeXml(`${origin}/${name}`)}</loc>${lastmod ? `<lastmod>${escapeXml(lastmod)}</lastmod>` : ""}</sitemap>`,
    ).join("")}</sitemapindex>`;
  }
  const kind = path.includes("products-") ? "product" : path.includes("pages-") ? "page" : null;
  const selected = kind ? rows.filter((row) => row.page_type === kind) : rows;
  const seen = new Set<string>();
  const unique = selected.filter((row) => {
    const url = new URL(row.canonical_url);
    if (url.origin !== origin || url.hash || seen.has(url.toString())) return false;
    seen.add(url.toString());
    return true;
  });
  if (path.includes("images-")) {
    return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">${unique.map((row) => {
      const imageUrls = Array.isArray(row.image_urls) ? row.image_urls : [];
      const images = [...new Set(imageUrls.filter((image: string) => {
        try { return new URL(image).protocol === "https:" && !new URL(image).username && !new URL(image).password; } catch { return false; }
      }))].slice(0, 10);
      return images.length ? `<url><loc>${escapeXml(row.canonical_url)}</loc>${images.map((image) => `<image:image><image:loc>${escapeXml(image)}</image:loc></image:image>`).join("")}</url>` : "";
    }).join("")}</urlset>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${unique.map((row) =>
    `<url><loc>${escapeXml(row.canonical_url)}</loc>${row.last_modified ? `<lastmod>${escapeXml(row.last_modified)}</lastmod>` : ""}</url>`,
  ).join("")}</urlset>`;
}

const publicSitemapPaths = ["/seo/sitemap.xml", "/seo/sitemap-index.xml", "/seo/pages-sitemap.xml", "/seo/products-sitemap.xml", "/seo/images-sitemap.xml"];
for (const path of publicSitemapPaths) {
  router.get(path, async (req, res): Promise<void> => {
    try {
      const xml = await sitemapXml(path, defaultOrigin());
      res.setHeader("Content-Type", "application/xml; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=300");
      res.send(xml);
    } catch (error) {
      req.log.error({ err: error }, "Public SEO sitemap could not be generated");
      res.status(503).setHeader("Content-Type", "text/plain; charset=utf-8").send("Sitemap generation is temporarily unavailable.");
    }
  });
}

export default router;
