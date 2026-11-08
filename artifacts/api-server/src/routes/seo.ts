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
const publicPagePaths = ["/", "/collection", "/about", "/raw-material", "/contact", "/faq", "/shipping", "/returns", "/privacy", "/terms"];
const perfumeFamilySku = /^(MAYA-VAR-[A-F0-9]{32})-\d+ML$/i;

type SitemapProductRow = {
  id: string;
  legacy_id: number | null;
  source_id: number | null;
  sku: string | null;
  size_ml: number | null;
  product_type: string;
  image_url: string | null;
  additional_images: string[] | null;
};
type SitemapEntry = { loc: string; imageUrls?: string[] };

function makeUrlSet(entries: SitemapEntry[], includeImages = false): string {
  const unique = [...new Map(entries.map((entry) => [entry.loc, entry])).values()];
  const imageNamespace = includeImages ? ' xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"' : "";
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${imageNamespace}>${unique.map((entry) => {
    const images = includeImages ? [...new Set((entry.imageUrls ?? []).flatMap((raw) => {
      try {
        const image = new URL(raw);
        return image.protocol === "https:" && !image.username && !image.password ? [image.toString()] : [];
      } catch { return []; }
    }))].slice(0, 10) : [];
    return `<url><loc>${escapeXml(entry.loc)}</loc>${images.map((image) => `<image:image><image:loc>${escapeXml(image)}</image:loc></image:image>`).join("")}</url>`;
  }).join("")}</urlset>`;
}

function activeCatalogEntries(rows: SitemapProductRow[], origin: string): SitemapEntry[] {
  const entries: SitemapEntry[] = [];
  const seenRawIds = new Set<number>();
  for (const row of rows) {
    if (row.product_type !== "raw_material" || !Number.isSafeInteger(row.source_id) || !row.source_id || seenRawIds.has(row.source_id)) continue;
    seenRawIds.add(row.source_id);
    entries.push({
      loc: new URL(`/raw-material/${encodeURIComponent(String(row.source_id))}`, origin).toString(),
      imageUrls: [row.image_url ?? "", ...(Array.isArray(row.additional_images) ? row.additional_images : [])].filter(Boolean),
    });
  }

  const perfumeGroups = new Map<string, SitemapProductRow[]>();
  for (const row of rows) {
    if (row.product_type !== "perfume" && row.product_type !== "cosmetic") continue;
    const family = perfumeFamilySku.exec(row.sku ?? "")?.[1]?.toUpperCase();
    const key = family ?? `single:${row.id}`;
    const group = perfumeGroups.get(key) ?? [];
    group.push(row);
    perfumeGroups.set(key, group);
  }
  for (const group of perfumeGroups.values()) {
    const primary = [...group].sort((a, b) => (a.size_ml ?? Number.MAX_SAFE_INTEGER) - (b.size_ml ?? Number.MAX_SAFE_INTEGER))[0];
    const productId = Number(primary?.legacy_id);
    if (!Number.isSafeInteger(productId) || productId < 1) continue;
    entries.push({
      loc: new URL(`/product/${encodeURIComponent(String(productId))}`, origin).toString(),
      imageUrls: group.flatMap((row) => [row.image_url ?? "", ...(Array.isArray(row.additional_images) ? row.additional_images : [])]).filter(Boolean),
    });
  }
  return entries;
}

async function readActiveCatalogRows(): Promise<SitemapProductRow[]> {
  const { data, error } = await getSupabaseAdmin().from("products")
    .select("id,legacy_id,source_id,sku,size_ml,product_type,image_url,additional_images")
    .eq("is_active", true).in("product_type", ["perfume", "cosmetic", "raw_material"])
    .order("created_at", { ascending: true }).order("id", { ascending: true }).limit(50_000);
  if (error) throw error;
  return (data ?? []) as SitemapProductRow[];
}

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
  const parsedOrigin = new URL(origin);
  if (parsedOrigin.protocol !== "https:" || parsedOrigin.origin !== origin) {
    throw new Error("The public sitemap origin must be one HTTPS origin.");
  }
  if (path === "/seo/sitemap-index.xml") {
    const childMaps = ["pages-sitemap.xml", "products-sitemap.xml", "images-sitemap.xml"];
    return `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${childMaps.map((name) =>
      `<sitemap><loc>${escapeXml(`${origin}/${name}`)}</loc></sitemap>`,
    ).join("")}</sitemapindex>`;
  }
  const pageEntries = publicPagePaths.map((page) => ({ loc: new URL(page, origin).toString() }));
  if (path === "/seo/pages-sitemap.xml") return makeUrlSet(pageEntries);

  const products = activeCatalogEntries(await readActiveCatalogRows(), origin);
  if (path === "/seo/products-sitemap.xml") return makeUrlSet(products);
  if (path === "/seo/images-sitemap.xml") return makeUrlSet(products, true);
  return makeUrlSet([...pageEntries, ...products]);
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
