export const catalogFilterParityRows = [
  {
    id: "price-padded",
    title: "AI Dataset",
    description: "Training data",
    price: "0.50",
    currency: "USDC",
    tags: ["AI", "Data"],
    listed: true,
    verificationStatus: "verified",
    resourceType: "link",
    publisherName: "Alice",
    walletAddress: "alice-wallet",
  },
  {
    id: "price-short",
    title: "ai dataset mirror",
    description: "Training data",
    price: "0.5",
    currency: "USDC",
    tags: ["ai"],
    listed: true,
    verificationStatus: "verified",
    resourceType: "link",
    publisherName: "Alice",
    walletAddress: "alice-wallet",
  },
  {
    id: "unlisted",
    title: "AI Notes",
    description: "Private notes",
    price: "1.00",
    currency: "USDC",
    tags: ["Ai"],
    listed: false,
    verificationStatus: "verified",
    resourceType: "file",
    publisherName: "Bob",
    walletAddress: "bob-wallet",
  },
  {
    id: "higher-price",
    title: "Research Archive",
    description: "Long-form research",
    price: "10.00",
    currency: "USDC",
    tags: ["research"],
    listed: true,
    verificationStatus: "pending",
    resourceType: "file",
    publisherName: "Carol",
    walletAddress: "carol-wallet",
  },
] as const;

/** GET /resources starts from listed rows before applying catalog filters. */
export const publicCatalogFilterParityRows = catalogFilterParityRows.filter((row) => row.listed);

export const catalogFilterParityServerFilters = {
  minPrice: "0.50",
  maxPrice: "0.50",
  verificationStatus: "verified" as const,
  resourceType: "link" as const,
};

export const catalogFilterParityMcpFilters = {
  ...catalogFilterParityServerFilters,
  tags: ["ai"],
  listed: true,
};
