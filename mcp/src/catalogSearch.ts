/** Canonical search normalization shared by every MCP-side catalog filter. */
export function normalizeCatalogSearchTerm(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("und");
}
