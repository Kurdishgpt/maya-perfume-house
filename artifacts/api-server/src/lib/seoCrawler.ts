import { parseHTML } from "linkedom";
import { getSupabaseAdmin } from "./supabase";

const BATCH_SIZE = 8;
const MAX_URLS = 500;
const MAX_HTML_BYTES = 1_000_000;
const FETCH_TIMEOUT_MS = 8_000;
const PRIVATE_PATHS = [/^\/admin(?:\/|$)/i, /^\/(?:bag|wishlist|checkout|welcome)(?:\/|$)/i, /^\/api(?:\/|$)/i];
const ignoredQueryParams = /^(utm_.+|gclid|fbclid|ref|session|token)$/i;

type PageKind = "page" | "product" | "raw_material";
type HtmlNode = {
  textContent: string | null;
  getAttribute(name: string): string | null;
  querySelector(selector: string): HtmlNode | null;
  querySelectorAll(selector: string): Iterable<HtmlNode>;
};
type HtmlDocument = HtmlNode & { documentElement: HtmlNode };
type QueueItem = { url: string; kind: PageKind; lastmod?: string | null };
type SeoRecord = {
  url: string;
  canonical_url: string;
  page_type: PageKind;
  title: string;
  description: string;
  image_urls: string[];
  price: number | null;
  currency: string | null;
  http_status: number | null;
  last_checked_at: string | null;
  last_modified: string | null;
  indexable: boolean;
  sitemap_included: boolean;
  issue_codes: string[];
  category: string | null;
  google_index_status: "unknown";
  last_seen_at: string;
  is_removed: boolean;
  internal_links: string[];
  html_title: string;
  broken_internal_links: string[];
  search_text: string;
};
type ProductSeed = { id?: number | string; title?: string; name?: string; description?: string; price?: number; currency?: string; image_url?: string; category?: string; brand?: string };
type RawSeed = { source_id?: number | string; name?: string; description?: string; price?: number; currency?: string; image_url?: string; category?: string };
type CrawlRun = {
  id: string; status: "running" | "complete" | "partial" | "failed"; started_at: string;
  completed_at: string | null; scheduled: boolean; site_origin: string; pages_discovered: number;
  products_discovered: number; raw_materials_discovered: number; images_discovered: number;
  urls_checked: number; broken_links: number; crawl_errors: string[]; remaining_urls: number;
  sitemap_generated_at: string | null; queue_urls: QueueItem[]; seen_urls: string[];
  lease_token: string | null; lease_until: string | null; limit_reached: boolean;
};

export function normalizeInternalUrl(raw: string, base: string, origin: string): string | null {
  try {
    const url = new URL(raw, base);
    if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) if (ignoredQueryParams.test(key)) url.searchParams.delete(key);
    const keep = new Set(["page", "paged", "p"]);
    for (const key of [...url.searchParams.keys()]) if (!keep.has(key.toLowerCase())) url.searchParams.delete(key);
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return null;
  }
}

function robotsRules(text: string) {
  const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; path: string }> }> = [];
  let group: { agents: string[]; rules: Array<{ allow: boolean; path: string }> } | null = null;
  for (const line of text.split(/\r?\n/)) {
    const clean = line.split("#", 1)[0]?.trim();
    if (!clean) continue;
    const separator = clean.indexOf(":");
    if (separator < 0) continue;
    const key = clean.slice(0, separator).trim().toLowerCase();
    const value = clean.slice(separator + 1).trim();
    if (key === "user-agent") {
      if (!group || group.rules.length) {
        group = { agents: [], rules: [] };
        groups.push(group);
      }
      group.agents.push(value.toLowerCase());
    } else if ((key === "allow" || key === "disallow") && group && value) {
      group.rules.push({ allow: key === "allow", path: value });
    }
  }
  const selected = groups.filter((entry) =>
    entry.agents.includes("*") || entry.agents.some((agent) => agent === "mayacollectionseo" || "mayacollectionseo".startsWith(agent)),
  );
  return {
    allows(url: string) {
      const path = new URL(url).pathname;
      let winner: { allow: boolean; path: string } | null = null;
      for (const entry of selected) for (const rule of entry.rules) {
        if (path.startsWith(rule.path) && (!winner || rule.path.length > winner.path.length || (rule.path.length === winner.path.length && rule.allow))) winner = rule;
      }
      return winner?.allow !== false;
    },
    sitemaps: [...text.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((match) => match[1]).filter((url): url is string => Boolean(url)),
  };
}

function xmlLocs(text: string, base: string, origin: string) {
  const locs: Array<{ url: string; lastmod: string | null }> = [];
  const { document: parsed } = parseHTML(text);
  const document = parsed as unknown as HtmlDocument;
  const root = document.documentElement;
  for (const node of Array.from(root.querySelectorAll("url, sitemap"))) {
    const raw = node.querySelector("loc")?.textContent?.trim();
    const url = raw ? normalizeInternalUrl(raw, base, origin) : null;
    if (url) locs.push({ url, lastmod: node.querySelector("lastmod")?.textContent?.trim() || null });
  }
  return locs;
}

async function safeFetch(url: string, origin: string): Promise<Response> {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    if (new URL(current).origin !== origin) throw new Error("Redirect left the configured site origin.");
    const response = await fetch(current, { redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { "User-Agent": "MayaCollectionSEO/1.0 (+public-page audit)" } });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) return response;
    const next = new URL(location, current);
    if (next.protocol !== "https:" || next.origin !== origin) throw new Error("Redirect left the configured site origin.");
    current = next.toString();
  }
  throw new Error("Too many redirects.");
}

async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel();
    throw new Error("Response exceeded the crawl size limit.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new Error("Response exceeded the crawl size limit.");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function pageExcluded(url: string) {
  const path = new URL(url).pathname;
  return PRIVATE_PATHS.some((rule) => rule.test(path)) || /\.(?:css|js|map|pdf|zip|png|jpe?g|webp|gif|svg|ico|woff2?)$/i.test(path);
}

function validIsoDate(value: string | null) {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function issueCodes(doc: HtmlDocument, status: number, kind: PageKind, robotsNoindex: boolean, canonical: string | null, images: string[]) {
  const issues: string[] = [];
  const title = doc.querySelector("title")?.textContent?.trim() ?? "";
  const description = doc.querySelector('meta[name="description" i]')?.getAttribute("content")?.trim() ?? "";
  if (!title || title === "Maya Collection") issues.push("missing_or_generic_title");
  if (!description || /built on replit|update this description/i.test(description)) issues.push("missing_or_generic_description");
  if (!canonical) issues.push("missing_canonical");
  if (kind === "product" && !doc.querySelector('script[type="application/ld+json"]')) issues.push("missing_product_structured_data");
  if (Array.from(doc.querySelectorAll("img:not([alt]), img[alt='']")).length > 0) issues.push("missing_image_alt");
  if (status < 200 || status >= 300) issues.push("http_error");
  if (robotsNoindex) issues.push("noindex");
  if (images.length === 0 && kind === "product") issues.push("missing_product_image");
  return issues;
}

async function discoverCatalogs(origin: string, robots: ReturnType<typeof robotsRules>, seen: Set<string>) {
  const queue: QueueItem[] = [];
  const errors: string[] = [];
  const products: ProductSeed[] = [];
  const rawMaterials: RawSeed[] = [];
  let limitReached = false;
  for (const [path, kind] of [["/api/products", "product"], ["/api/raw-materials", "raw_material"]] as const) {
    const url = `${origin}${path}`;
    if (!robots.allows(url)) continue;
    try {
      const response = await safeFetch(url, origin);
      if (!response.ok) { errors.push(`${path}: HTTP ${response.status}`); continue; }
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("json")) { errors.push(`${path}: expected JSON catalog data`); continue; }
      const body: unknown = JSON.parse(await readLimitedText(response, MAX_HTML_BYTES));
      if (!Array.isArray(body)) { errors.push(`${path}: unexpected catalog response`); continue; }
      if (body.length > MAX_URLS) {
        limitReached = true;
        errors.push(`${path}: only the first ${MAX_URLS} public catalog records can be stored per crawl.`);
      }
      if (kind === "product") {
        for (const item of body.slice(0, MAX_URLS) as ProductSeed[]) {
          if (!item.id || typeof item.id !== "number" && typeof item.id !== "string") continue;
          products.push(item);
          const productUrl = normalizeInternalUrl(`/product/${encodeURIComponent(String(item.id))}`, origin, origin);
          if (productUrl && !seen.has(productUrl)) {
            if (seen.size >= MAX_URLS) { limitReached = true; continue; }
            seen.add(productUrl);
            queue.push({ url: productUrl, kind: "product" });
          }
        }
      } else {
        for (const item of body.slice(0, MAX_URLS) as RawSeed[]) if (item.source_id != null && item.name) rawMaterials.push(item);
      }
    } catch {
      errors.push(`${path}: catalog could not be read`);
    }
  }
  return { queue, products, rawMaterials, errors, limitReached };
}

function discoveryRecord(item: {
  url: string; canonical_url: string; page_type: PageKind; title: string; description: string;
  image_urls: string[]; price?: number | null; currency?: string | null; http_status: number | null;
  last_modified?: string | null; issues: string[]; category?: string | null; indexable: boolean;
  internal_links?: string[]; html_title?: string;
}, now: string): SeoRecord {
  const canonical = item.canonical_url;
  const sitemap = item.indexable;
  return {
    url: item.url, canonical_url: canonical, page_type: item.page_type, title: item.title,
    description: item.description, image_urls: [...new Set(item.image_urls)].slice(0, 30),
    price: item.price ?? null, currency: item.currency ?? null, http_status: item.http_status,
    last_checked_at: now, last_modified: item.last_modified ?? null, indexable: item.indexable,
    sitemap_included: sitemap, issue_codes: [...new Set(item.issues)], category: item.category ?? null,
    google_index_status: "unknown", last_seen_at: now, is_removed: false,
    html_title: item.html_title ?? "", internal_links: item.internal_links ?? [], broken_internal_links: [],
    search_text: [item.title, item.description, item.category, item.url, item.canonical_url].filter(Boolean).join(" ").toLowerCase(),
  };
}

function toRun(row: CrawlRun): CrawlRun {
  return { ...row, remaining_urls: row.queue_urls?.length ?? 0 };
}

export async function startSeoCrawl(scheduled = false, originOverride?: string): Promise<CrawlRun> {
  const origin = (originOverride ?? process.env.SEO_SITE_ORIGIN ?? "https://mayacolllection.com").trim().replace(/\/+$/, "");
  const parsed = new URL(origin);
  if (parsed.protocol !== "https:" || parsed.origin !== origin) throw new Error("SEO_SITE_ORIGIN must be one HTTPS origin.");
  const supabase = getSupabaseAdmin();
  const { data: running } = await supabase.from("seo_crawl_runs").select("*").eq("status", "running").limit(1).maybeSingle();
  if (running) throw new Error("A crawl is already running. Resume it or wait for the scheduled worker.");
  const now = new Date().toISOString();
  const { data, error } = await supabase.from("seo_crawl_runs").insert({
    status: "running", started_at: now, scheduled, site_origin: origin, queue_urls: [], seen_urls: [],
    pages_discovered: 0, products_discovered: 0, raw_materials_discovered: 0,
    images_discovered: 0, urls_checked: 0, broken_links: 0, crawl_errors: [],
    sitemap_generated_at: null,
  }).select("*").single();
  if (error || !data) throw new Error("The crawl could not be started. Apply the SEO database setup script first.");
  return toRun(data as CrawlRun);
}

export async function processSeoCrawlBatch(runId: string): Promise<CrawlRun> {
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const lease = crypto.randomUUID();
  const { data: run, error: claimError } = await supabase.from("seo_crawl_runs").update({
    lease_token: lease, lease_until: new Date(Date.now() + 90_000).toISOString(),
  }).eq("id", runId).eq("status", "running")
    .or(`lease_until.is.null,lease_until.lt.${now}`)
    .select("*").maybeSingle();
  if (claimError || !run) {
    const { data: current } = await supabase.from("seo_crawl_runs").select("*").eq("id", runId).maybeSingle();
    if (!current) throw new Error("Crawl not found.");
    return toRun(current as CrawlRun);
  }

  const siteOrigin = (run.site_origin || process.env.SEO_SITE_ORIGIN || "https://mayacolllection.com").trim().replace(/\/+$/, "");
  const origin = new URL(siteOrigin).origin;
  const queue = Array.isArray(run.queue_urls) ? [...run.queue_urls as QueueItem[]] : [];
  const seen = new Set(Array.isArray(run.seen_urls) ? run.seen_urls as string[] : []);
  const errors = Array.isArray(run.crawl_errors) ? [...run.crawl_errors as string[]] : [];
  let productsCount = Number(run.products_discovered) || 0;
  let rawCount = Number(run.raw_materials_discovered) || 0;
  let imageCount = Number(run.images_discovered) || 0;
  let checked = Number(run.urls_checked) || 0;
  let broken = Number(run.broken_links) || 0;
  let pageCount = Number(run.pages_discovered) || 0;
  let settingsSeeded = Boolean(run.settings_seeded);
  let limitReached = Boolean(run.limit_reached);
  try {
    const robotsResponse = await safeFetch(`${origin}/robots.txt`, origin);
    if (robotsResponse.status === 401 || robotsResponse.status === 403 || robotsResponse.status >= 500) {
      throw new Error(`robots.txt could not be checked (HTTP ${robotsResponse.status}); crawl stopped.`);
    }
    const robotsText = robotsResponse.ok ? await readLimitedText(robotsResponse, MAX_HTML_BYTES) : "";
    const robots = robotsRules(robotsText);
    if (!robots.allows(`${origin}/`)) throw new Error("robots.txt disallows crawling the homepage.");

    if (!settingsSeeded) {
      const sitemapUrls = robots.sitemaps
        .map((url) => normalizeInternalUrl(url, origin, origin))
        .filter((url): url is string => Boolean(url));
      for (const path of ["/", "/raw-material", "/collection", ...sitemapUrls.map((url) => new URL(url).pathname)]) {
        const url = normalizeInternalUrl(path, origin, origin);
        if (url && !pageExcluded(url) && robots.allows(url) && !seen.has(url)) {
          if (seen.size >= MAX_URLS) { limitReached = true; continue; }
          seen.add(url);
          queue.push({ url, kind: "page" });
        }
      }
      const sitemapQueue = [`${origin}/sitemap.xml`, ...sitemapUrls];
      for (const sitemapUrl of [...new Set(sitemapQueue)].slice(0, 6)) {
        try {
          const response = await safeFetch(sitemapUrl, origin);
          if (!response.ok || !response.headers.get("content-type")?.includes("xml")) continue;
          const xml = await readLimitedText(response, MAX_HTML_BYTES);
          for (const { url, lastmod } of xmlLocs(xml, sitemapUrl, origin)) {
            if (!pageExcluded(url) && robots.allows(url) && !seen.has(url)) {
              if (seen.size >= MAX_URLS) { limitReached = true; continue; }
              seen.add(url);
              queue.push({ url, kind: new URL(url).pathname.startsWith("/product/") ? "product" : "page", lastmod });
            }
          }
        } catch { errors.push("A sitemap could not be read."); }
      }
      const catalogs = await discoverCatalogs(origin, robots, seen);
      for (const item of catalogs.rawMaterials) {
        const rawUrl = normalizeInternalUrl(`/raw-material/${encodeURIComponent(String(item.source_id))}`, origin, origin);
        if (!rawUrl || pageExcluded(rawUrl) || !robots.allows(rawUrl)) continue;
        const queued = queue.find((entry) => entry.url === rawUrl);
        if (queued) {
          queued.kind = "raw_material";
        } else if (!seen.has(rawUrl)) {
          if (seen.size >= MAX_URLS) { limitReached = true; continue; }
          seen.add(rawUrl);
          queue.push({ url: rawUrl, kind: "raw_material" });
        }
      }
      queue.push(...catalogs.queue);
      limitReached ||= catalogs.limitReached;
      productsCount = catalogs.products.length;
      rawCount = catalogs.rawMaterials.length;
      errors.push(...catalogs.errors);
      settingsSeeded = true;
    }

    const batch = queue.splice(0, BATCH_SIZE);
    const records: SeoRecord[] = [];
    const productApi = new Map<string, ProductSeed>();
    const rawMaterialApi = new Map<string, RawSeed>();
    if (batch.some((item) => item.kind === "product") && productsCount > 0) {
      try {
        const response = await safeFetch(`${origin}/api/products`, origin);
        if (response.ok) {
          const products = await response.json() as ProductSeed[];
          for (const product of products) if (product.id != null) productApi.set(`${origin}/product/${encodeURIComponent(String(product.id))}`, product);
        }
      } catch { /* page crawl remains useful without product enrichment */ }
    }
    const rawItems = batch.filter((item) => item.kind === "raw_material");
    await Promise.all(rawItems.map(async (item) => {
      const sourceId = new URL(item.url).pathname.split("/").at(-1);
      if (!sourceId || !/^\d+$/.test(sourceId)) return;
      try {
        const response = await safeFetch(`${origin}/api/raw-materials/${encodeURIComponent(sourceId)}`, origin);
        if (response.ok && response.headers.get("content-type")?.includes("json")) {
          rawMaterialApi.set(item.url, await response.json() as RawSeed);
        }
      } catch { /* A failed catalog detail lookup keeps the page out of the sitemap. */ }
    }));

    for (const item of batch) {
      if (pageExcluded(item.url) || !robots.allows(item.url)) continue;
      try {
        await new Promise((resolve) => setTimeout(resolve, 400));
        const response = await safeFetch(item.url, origin);
        const body = await readLimitedText(response, MAX_HTML_BYTES);
        const { document: parsed } = parseHTML(body);
        const document = parsed as unknown as HtmlDocument;
        const finalUrl = normalizeInternalUrl(response.url || item.url, origin, origin) ?? item.url;
        const explicitCanonicalRaw = document.querySelector('link[rel~="canonical" i]')?.getAttribute("href");
        const explicitCanonical = explicitCanonicalRaw ? normalizeInternalUrl(explicitCanonicalRaw, finalUrl, origin) : null;
        const canonicalOutsideSite = Boolean(explicitCanonicalRaw && !explicitCanonical);
        const canonical = explicitCanonicalRaw ? explicitCanonical ?? finalUrl : finalUrl;
        const noindexMeta = document.querySelector('meta[name="robots" i], meta[name="googlebot" i]')?.getAttribute("content") ?? "";
        const noindex = /noindex|none/i.test(noindexMeta) || /noindex/i.test(response.headers.get("x-robots-tag") ?? "");
        const images = [
          ...Array.from(document.querySelectorAll("img[src], img[data-src]")).map((img) => img.getAttribute("src") ?? img.getAttribute("data-src") ?? ""),
          ...Array.from(document.querySelectorAll('meta[property="og:image" i], meta[name="twitter:image" i]')).map((img) => img.getAttribute("content") ?? ""),
        ].map((src) => normalizeInternalUrl(src, finalUrl, origin) ?? (src.startsWith("https://") ? src : "")).filter(Boolean);
        const links = Array.from(document.querySelectorAll("a[href], link[rel~='next' i][href]"))
          .map((anchor) => normalizeInternalUrl(anchor.getAttribute("href") ?? "", finalUrl, origin))
          .filter((url): url is string => Boolean(url) && !pageExcluded(url!));
        const product = productApi.get(item.url);
        const rawMaterial = rawMaterialApi.get(item.url);
        const actualTitle = document.querySelector("title")?.textContent?.trim() ?? "";
        const productTitle = product?.title ?? product?.name ?? rawMaterial?.name;
        const productImage = product?.image_url ?? rawMaterial?.image_url;
        if (productImage) images.push(productImage);
        const allImages = [...new Set(images)].slice(0, 30);
        const issues = issueCodes(document, response.status, item.kind, noindex, explicitCanonical ?? null, allImages);
        if (canonicalOutsideSite) issues.push("canonical_outside_site");
        if (item.kind === "product" && allImages.length > 0 && Array.from(document.querySelectorAll("img")).length === 0) issues.push("missing_image_alt");
        if (item.kind === "raw_material" && !rawMaterial) issues.push("raw_material_not_found");
        const record = discoveryRecord({
          url: item.url, canonical_url: canonical ?? finalUrl, page_type: item.kind,
          title: productTitle ?? actualTitle, description: product?.description ?? rawMaterial?.description ??
            document.querySelector('meta[name="description" i]')?.getAttribute("content")?.trim() ?? "",
          image_urls: allImages, price: typeof product?.price === "number" ? product.price :
            typeof rawMaterial?.price === "number" ? rawMaterial.price : null,
          currency: product?.currency ?? rawMaterial?.currency ?? null, http_status: response.status,
          last_modified: item.lastmod ?? validIsoDate(response.headers.get("last-modified")),
          issues, category: product?.category ?? rawMaterial?.category ?? null,
          indexable: response.status >= 200 && response.status < 300 && !noindex && !canonicalOutsideSite &&
            !pageExcluded(finalUrl) && (!canonical || new URL(canonical).origin === origin) &&
            (item.kind !== "raw_material" || Boolean(rawMaterial)),
          internal_links: links,
          html_title: actualTitle,
        }, now);
        records.push(record);
        pageCount += 1;
        checked += 1;
        imageCount += allImages.length;
        if (response.status >= 400) broken += 1;
        for (const nextUrl of links) {
          if (!seen.has(nextUrl) && seen.size < MAX_URLS) {
            seen.add(nextUrl);
            queue.push({ url: nextUrl, kind: new URL(nextUrl).pathname.startsWith("/product/") ? "product" : "page" });
          }
        }
      } catch (error) {
        checked += 1;
        broken += 1;
        errors.push(`${new URL(item.url).pathname}: ${error instanceof Error ? error.message : "request failed"}`.slice(0, 240));
        records.push(discoveryRecord({
          url: item.url, canonical_url: item.url, page_type: item.kind, title: "", description: "",
          image_urls: [], http_status: null, issues: ["crawl_error"], indexable: false,
        }, now));
      }
    }

    if (records.length) {
      const { error: saveError } = await supabase.from("seo_discovery_records").upsert(records, { onConflict: "url" });
      if (saveError) throw new Error("Crawl results could not be saved.");
    }
    if (queue.length && seen.size >= MAX_URLS) limitReached = true;
    if (limitReached && !errors.some((entry) => entry.includes("500 URL limit"))) {
      errors.push("The 500 URL crawl limit was reached; additional pages were not checked.");
    }
    const remaining = Math.min(queue.length, MAX_URLS - seen.size);
    const complete = remaining === 0;
    const { data: updated, error: updateError } = await supabase.from("seo_crawl_runs").update({
      queue_urls: queue.slice(0, Math.max(0, MAX_URLS - seen.size)), seen_urls: [...seen].slice(0, MAX_URLS),
      settings_seeded: settingsSeeded, pages_discovered: pageCount, products_discovered: productsCount,
      raw_materials_discovered: rawCount, images_discovered: imageCount, urls_checked: checked,
      limit_reached: limitReached,
      broken_links: broken, crawl_errors: errors.slice(-100),
      status: complete ? errors.length || limitReached ? "partial" : "complete" : "running",
      completed_at: complete ? now : null, sitemap_generated_at: complete ? now : null,
      lease_token: null, lease_until: null,
    }).eq("id", runId).eq("lease_token", lease).select("*").single();
    if (updateError || !updated) throw new Error("Crawl progress could not be saved.");
    if (complete && errors.length === 0 && !limitReached) {
      await supabase.from("seo_discovery_records").update({ is_removed: true, sitemap_included: false, indexable: false })
        .lt("last_seen_at", run.started_at).eq("is_removed", false);
      const { data: checkedRecords } = await supabase.from("seo_discovery_records")
        .select("url,canonical_url,page_type,http_status,indexable,internal_links,issue_codes,html_title")
        .eq("is_removed", false).limit(MAX_URLS);
      const statusByUrl = new Map((checkedRecords ?? []).map((record) => [record.url, Number(record.http_status)]));
      const canonicalOwners = new Map<string, string>();
      const titleCounts = new Map<string, number>();
      for (const record of checkedRecords ?? []) {
        const title = String(record.html_title ?? "").trim().toLowerCase();
        if (title) titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
      }
      let brokenInternalCount = broken;
      for (const record of checkedRecords ?? []) {
        const issues = new Set<string>(record.issue_codes ?? []);
        const links = (record.internal_links ?? []) as string[];
        const brokenLinks = links.filter((link) => {
          const status = statusByUrl.get(link);
          return status != null && (status < 200 || status >= 400);
        });
        if (brokenLinks.length) issues.add("broken_internal_links");
        const title = String(record.html_title ?? "").trim().toLowerCase();
        if (title && (titleCounts.get(title) ?? 0) > 1) issues.add("duplicate_title");
        const canonical = String(record.canonical_url ?? "");
        const owner = canonicalOwners.get(canonical);
        const duplicateCanonical = record.page_type !== "raw_material" && Boolean(owner && owner !== record.url);
        if (duplicateCanonical) issues.add("duplicate_canonical");
        else if (record.page_type !== "raw_material" && canonical) canonicalOwners.set(canonical, record.url);
        const { error: auditError } = await supabase.from("seo_discovery_records").update({
          issue_codes: [...issues], broken_internal_links: brokenLinks,
          sitemap_included: Boolean(record.indexable && record.http_status && record.http_status >= 200 && record.http_status < 300 && !duplicateCanonical),
        }).eq("url", record.url);
        if (auditError) errors.push("Some duplicate-title or broken-link audit results could not be saved.");
        brokenInternalCount += brokenLinks.length;
      }
      await supabase.from("seo_crawl_runs").update({ broken_links: brokenInternalCount }).eq("id", runId);
    }
    return toRun(updated as CrawlRun);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Crawl failed.";
    await supabase.from("seo_crawl_runs").update({
      status: "partial", completed_at: now, crawl_errors: [...errors, message].slice(-100),
      lease_token: null, lease_until: null,
    }).eq("id", runId).eq("lease_token", lease);
    throw error;
  }
}

export async function scheduledSeoTick() {
  const supabase = getSupabaseAdmin();
  const { data: settings } = await supabase.from("seo_crawl_settings").select("*").eq("id", 1).maybeSingle();
  const { data: running } = await supabase.from("seo_crawl_runs").select("id").eq("status", "running").limit(1).maybeSingle();
  if (running?.id) { await processSeoCrawlBatch(running.id); return; }
  if (!settings?.scheduled_enabled) return;
  const { data: last } = await supabase.from("seo_crawl_runs").select("completed_at").order("started_at", { ascending: false }).limit(1).maybeSingle();
  const intervalHours = Math.max(1, Number(settings.interval_hours) || 24);
  if (!last?.completed_at || Date.now() - new Date(last.completed_at).getTime() >= intervalHours * 3_600_000) {
    const run = await startSeoCrawl(true);
    await processSeoCrawlBatch(run.id);
  }
}
