import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const configuredOrigin = process.env.SEO_SITE_ORIGIN || "https://mayacolllection.com";
const siteOrigin = new URL(configuredOrigin).origin;
if (!siteOrigin.startsWith("https://")) {
  throw new Error("SEO_SITE_ORIGIN must be an HTTPS origin.");
}

const publicDirectory = join(import.meta.dirname, "..", "public");
const sitemapFiles = [
  { output: "sitemap.xml", source: "/api/seo/sitemap.xml", root: "urlset" },
  { output: "sitemap-index.xml", source: "/api/seo/sitemap-index.xml", root: "sitemapindex" },
  { output: "pages-sitemap.xml", source: "/api/seo/pages-sitemap.xml", root: "urlset" },
  { output: "products-sitemap.xml", source: "/api/seo/products-sitemap.xml", root: "urlset" },
  { output: "images-sitemap.xml", source: "/api/seo/images-sitemap.xml", root: "urlset" },
];

function decodeXml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

function sitemapLocs(xml) {
  return [...xml.matchAll(/<loc>([\s\S]*?)<\/loc>/g)].map((match) => decodeXml(match[1]));
}

function validateSitemap(xml, expectedRoot, output) {
  const root = xml.match(/<([A-Za-z][\w:]*)(?=\s|>)/)?.[1];
  if (root !== expectedRoot) {
    throw new Error(`${output} has an unexpected XML root element.`);
  }

  const locs = sitemapLocs(xml);
  if (locs.length === 0) {
    throw new Error(`${output} contains no loc entries; refusing to publish an empty sitemap.`);
  }

  const uniqueLocs = new Set(locs);
  if (uniqueLocs.size !== locs.length) {
    throw new Error(`${output} contains duplicate loc entries.`);
  }

  for (const loc of locs) {
    let url;
    try {
      url = new URL(loc);
    } catch {
      throw new Error(`${output} contains a non-absolute URL.`);
    }
    if (url.origin !== siteOrigin || url.protocol !== "https:") {
      throw new Error(`${output} contains a URL outside ${siteOrigin}.`);
    }
    if (/^\/(admin|bag|wishlist|checkout)(\/|$)/i.test(url.pathname)) {
      throw new Error(`${output} contains a private or non-indexable URL.`);
    }
  }

  return locs;
}

async function fetchSitemap({ output, source, root }) {
  const url = new URL(source, siteOrigin);
  const response = await fetch(url, {
    headers: { accept: "application/xml, text/xml;q=0.9" },
    signal: AbortSignal.timeout(25_000),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Could not refresh ${output}: source returned HTTP ${response.status}.`);
  }
  if (!/^(application|text)\/xml\b/i.test(response.headers.get("content-type") ?? "")) {
    throw new Error(`Could not refresh ${output}: source did not return XML.`);
  }

  const xml = await response.text();
  const locs = validateSitemap(xml, root, output);
  return { output, xml, locs };
}

const sitemaps = await Promise.all(sitemapFiles.map(fetchSitemap));
const sitemapByName = new Map(sitemaps.map((sitemap) => [sitemap.output, sitemap]));
const pageLocs = sitemapByName.get("pages-sitemap.xml").locs;
const productLocs = sitemapByName.get("products-sitemap.xml").locs;
const allLocs = new Set(sitemapByName.get("sitemap.xml").locs);
for (const loc of [...pageLocs, ...productLocs]) {
  if (!allLocs.has(loc)) {
    throw new Error(`sitemap.xml is stale: it does not include ${loc}.`);
  }
}

const productPaths = productLocs.map((loc) => new URL(loc).pathname);
const rawMaterialCount = productPaths.filter((path) => /^\/raw-material\/\d+$/.test(path)).length;
const perfumeCount = productPaths.filter((path) => /^\/product\/\d+$/.test(path)).length;
if (rawMaterialCount === 0 || perfumeCount === 0) {
  throw new Error("The product sitemap is missing raw-material or perfume product routes.");
}

await mkdir(publicDirectory, { recursive: true });
await Promise.all(sitemaps.map(({ output, xml }) =>
  writeFile(join(publicDirectory, output), `${xml.trim()}\n`, "utf8"),
));

console.log(
  `Refreshed XML sitemaps from ${siteOrigin}: ${pageLocs.length} pages, ` +
  `${rawMaterialCount} raw materials, ${perfumeCount} perfumes.`,
);
