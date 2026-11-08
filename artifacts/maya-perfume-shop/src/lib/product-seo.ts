const productionOrigin = "https://mayacolllection.com";

export function setProductPageMetadata(input: {
  name: string;
  description: string;
  url: string;
  imageUrl?: string | null;
  price: number;
  currency: string;
  sku?: string | null;
  category?: string | null;
  unitCode?: string;
}) {
  const previousTitle = document.title;
  const cleanup: Array<() => void> = [];
  const title = `${input.name} | Maya Beauty`;
  const description = (input.description || `Explore ${input.name} at Maya Beauty.`)
    .replace(/\s+/g, " ").trim().slice(0, 300);
  let imageUrl: string | undefined;
  if (input.imageUrl?.trim()) {
    try {
      const candidate = new URL(input.imageUrl, productionOrigin);
      if (candidate.protocol === "https:") imageUrl = candidate.toString();
    } catch { /* An unavailable image is omitted from SEO metadata. */ }
  }

  document.title = title;
  const setMeta = (attribute: "name" | "property", key: string, content: string) => {
    let element = document.head.querySelector<HTMLMetaElement>(`meta[${attribute}="${key}"]`);
    const wasCreated = !element;
    if (!element) {
      element = document.createElement("meta");
      element.setAttribute(attribute, key);
      document.head.append(element);
    }
    const previousContent = element.getAttribute("content");
    element.setAttribute("content", content);
    cleanup.push(() => {
      if (wasCreated) element?.remove();
      else if (previousContent === null) element?.removeAttribute("content");
      else element?.setAttribute("content", previousContent);
    });
  };

  setMeta("name", "description", description);
  setMeta("property", "og:type", "product");
  setMeta("property", "og:title", title);
  setMeta("property", "og:description", description);
  setMeta("property", "og:url", input.url);
  if (imageUrl) setMeta("property", "og:image", imageUrl);
  setMeta("name", "twitter:card", imageUrl ? "summary_large_image" : "summary");
  setMeta("name", "twitter:title", title);
  setMeta("name", "twitter:description", description);

  let canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  const canonicalWasCreated = !canonical;
  if (!canonical) {
    canonical = document.createElement("link");
    canonical.rel = "canonical";
    document.head.append(canonical);
  }
  const previousCanonical = canonical.href;
  canonical.href = input.url;
  cleanup.push(() => {
    if (canonicalWasCreated) canonical?.remove();
    else canonical?.setAttribute("href", previousCanonical);
  });

  let jsonLd = document.getElementById("maya-product-jsonld") as HTMLScriptElement | null;
  const jsonLdWasCreated = !jsonLd;
  if (!jsonLd) {
    jsonLd = document.createElement("script");
    jsonLd.id = "maya-product-jsonld";
    jsonLd.type = "application/ld+json";
    document.head.append(jsonLd);
  }
  const previousJsonLd = jsonLd.textContent;
  const offer: Record<string, unknown> = {
    "@type": "Offer",
    url: input.url,
    price: input.price,
    priceCurrency: input.currency,
  };
  if (input.unitCode) offer.priceSpecification = {
    "@type": "UnitPriceSpecification",
    price: input.price,
    priceCurrency: input.currency,
    unitCode: input.unitCode,
  };
  jsonLd.textContent = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Product",
    name: input.name,
    description,
    image: imageUrl ? [imageUrl] : undefined,
    sku: input.sku || undefined,
    category: input.category || undefined,
    brand: { "@type": "Brand", name: "Maya Beauty" },
    url: input.url,
    offers: offer,
  }).replaceAll("<", "\\u003c");
  cleanup.push(() => {
    if (jsonLdWasCreated) jsonLd?.remove();
    else jsonLd!.textContent = previousJsonLd;
  });

  return () => {
    document.title = previousTitle;
    cleanup.reverse().forEach((restore) => restore());
  };
}
