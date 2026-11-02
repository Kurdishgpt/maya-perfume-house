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

type MaterialSearchIndex = {
  fields: string[];
  normalizedName: string;
  compactText: string;
};

const materialSearchIndexes = new WeakMap<RawMaterial, MaterialSearchIndex>();

function getSearchIndex(material: RawMaterial): MaterialSearchIndex {
  const cached = materialSearchIndexes.get(material);
  if (cached) return cached;

  const fields = [
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
  const index = {
    fields,
    normalizedName: normalizeRawMaterialSearch(material.name),
    compactText: fields.join("").replaceAll(" ", ""),
  };
  materialSearchIndexes.set(material, index);
  return index;
}

export function createRawMaterialSearch(query: string) {
  const normalizedQuery = normalizeRawMaterialSearch(query);
  const terms = normalizedQuery.split(" ");
  const allTermsMatch = (field: string) => terms.every((term) => field.includes(term));
  const compactQuery = normalizedQuery.replaceAll(" ", "");
  const scores = new WeakMap<RawMaterial, number>();

  const score = (material: RawMaterial) => {
    const cachedScore = scores.get(material);
    if (cachedScore !== undefined) return cachedScore;
    if (!normalizedQuery) return 1;

    const index = getSearchIndex(material);
    let result = 0;
    // Put the intended product-name match ahead of broader description/SKU matches.
    if (index.normalizedName === normalizedQuery) result = 1000;
    else if (index.normalizedName.startsWith(normalizedQuery)) result = 900;
    else if (allTermsMatch(index.normalizedName)) result = 700;
    // Match partial words across fields, without matching across field boundaries.
    else if (index.fields.some(allTermsMatch)) result = 300;
    // Also accept compact spellings such as "IsoESuper" and "Iso-E-Super".
    else if (compactQuery.length >= 3 && index.compactText.includes(compactQuery)) result = 100;

    scores.set(material, result);
    return result;
  };

  return { matches: (material: RawMaterial) => score(material) > 0, score };
}

export function rawMaterialSearchScore(material: RawMaterial, query: string): number {
  return createRawMaterialSearch(query).score(material);
}

export function matchesRawMaterialSearch(material: RawMaterial, query: string): boolean {
  return createRawMaterialSearch(query).matches(material);
}
