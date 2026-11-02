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

export function matchesRawMaterialSearch(material: RawMaterial, query: string): boolean {
  const normalizedQuery = normalizeRawMaterialSearch(query);
  if (!normalizedQuery) return true;

  const searchable = normalizeRawMaterialSearch([
    material.name,
    material.source_name,
    material.source_sku,
    material.category,
    material.source_category,
    material.description,
    material.source_description,
    material.source_url,
    material.source_id,
    ...material.quantity_options.flatMap((option) => [option.label, option.value, option.unit]),
  ].join(" "));
  const terms = normalizedQuery.split(" ");

  // Token matching allows useful partial searches even when punctuation differs.
  if (terms.every((term) => searchable.includes(term))) return true;

  // Also accept compact spellings such as "IsoESuper" and "Iso-E-Super".
  const compactQuery = normalizedQuery.replaceAll(" ", "");
  const compactText = searchable.replaceAll(" ", "");
  return compactQuery.length >= 3 && compactText.includes(compactQuery);
}
