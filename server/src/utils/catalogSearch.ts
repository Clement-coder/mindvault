/** Canonical search normalization for the public catalog query path. */
export function normalizeCatalogSearchTerm(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("und");
}
