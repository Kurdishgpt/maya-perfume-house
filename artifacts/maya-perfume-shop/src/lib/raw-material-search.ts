import type { RawMaterial } from "@workspace/api-client-react";

export function normalizeRawMaterialSearch(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function getSearchFields(material: RawMaterial): string[] {
  return [
    material.name,
    material.source_name,
    material.source_sku,
    material.category,
    material.source_category,
    material.description,
    material.source_description,
    material.source_url,
    material.source_id,
    ...(Array.isArray(material.quantity_options)
      ? material.quantity_options.flatMap((option) => [option.label, option.value, option.unit])
      : []),
  ].map(normalizeRawMaterialSearch).filter(Boolean);
}

export function rawMaterialSearchScore(material: RawMaterial, query: string): number {
  const normalizedQuery = normalizeRawMaterialSearch(query);
  if (!normalizedQuery) return 1;

  const fields = getSearchFields(material);
  const normalizedName = normalizeRawMaterialSearch(material.name);
  const terms = normalizedQuery.split(" ");
  const allTermsMatch = (field: string) => terms.every((term) => field.includes(term));

  // Put the intended product-name match ahead of broader description/SKU matches.
  if (normalizedName === normalizedQuery) return 1000;
  if (normalizedName.startsWith(normalizedQuery)) return 900;
  if (allTermsMatch(normalizedName)) return 700;

  // Match partial words across product fields, e.g. "iso" -> "Iso E Super".
  // Keep fields separate so terms cannot accidentally match across field boundaries.
  if (fields.some(allTermsMatch)) return 300;

  // Also accept compact spellings such as "IsoESuper" and "Iso-E-Super".
  const compactQuery = normalizedQuery.replaceAll(" ", "");
  const compactText = fields.join(" ").replaceAll(" ", "");
  return compactQuery.length >= 3 && compactText.includes(compactQuery) ? 100 : 0;
}

export function matchesRawMaterialSearch(material: RawMaterial, query: string): boolean {
  return rawMaterialSearchScore(material, query) > 0;
}
