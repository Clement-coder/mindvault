import {
  pgTable,
  text,
  real,
  integer,
  boolean,
  timestamp,
  pgEnum,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { createId } from "@paralleldrive/cuid2";

export const resourceTypeEnum = pgEnum("resource_type", ["file", "link"]);

export const verificationStatusEnum = pgEnum("verification_status", [
  "pending",
  "verified",
  "rejected",
  "skipped",
]);

export const onchainStatusEnum = pgEnum("onchain_status_enum", [
  "none",
  "pending",
  "registered",
  "failed",
]);

// Publishers — humans or AI agents that publish resources
export const publishers = pgTable("publishers", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId()),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  walletAddress: text("wallet_address").notNull(),
  apiKeyHash: text("api_key_hash").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Resources — digital assets published on the marketplace
export const resources = pgTable(
  "resources",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    publisherId: text("publisher_id")
      .notNull()
      .references(() => publishers.id),
    title: text("title").notNull(),
    description: text("description"),
    price: text("price").notNull(),
    walletAddress: text("wallet_address").notNull(),
    resourceType: resourceTypeEnum("resource_type").notNull(),
    storagePath: text("storage_path"),
    thumbnailPath: text("thumbnail_path"),
    contentHash: text("content_hash"),
    externalUrl: text("external_url"),
    mimeType: text("mime_type"),
    verificationStatus: verificationStatusEnum("verification_status").notNull().default("pending"),
    verificationId: text("verification_id"),
    listed: boolean("listed").notNull().default(false),
    onchainStatus: onchainStatusEnum("onchain_status").notNull().default("none"),
    onchainTxHash: text("onchain_tx_hash"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    catalogFilterSortIdx: index("idx_resources_catalog_filter_sort").on(
      table.listed,
      table.verificationStatus,
      table.createdAt,
    ),
    // Publisher dashboards list a single publisher's resources (#285).
    publisherIdx: index("idx_resources_publisher_id").on(table.publisherId),
    // Verification-status filters that aren't anchored to `listed` can't use the
    // composite catalog index, so they get their own (#285).
    verificationStatusIdx: index("idx_resources_verification_status").on(table.verificationStatus),
  }),
);

// Verifications — AI originality check results
export const verifications = pgTable("verifications", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId()),
  resourceId: text("resource_id")
    .notNull()
    .references(() => resources.id),
  isOriginal: boolean("is_original").notNull(),
  confidence: real("confidence").notNull(), // 0.0 - 1.0
  flags: text("flags"), // JSON stringified array of issues
  // Token usage + estimated spend for the verification model call (#283).
  // Nullable so historical rows predating usage tracking remain valid.
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
  totalTokens: integer("total_tokens"),
  estimatedCost: text("estimated_cost"), // USD, stringified for precision
  checkedAt: timestamp("checked_at").defaultNow().notNull(),
});

// Payments — tracks x402 payments for resources
export const payments = pgTable(
  "payments",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    resourceId: text("resource_id")
      .notNull()
      .references(() => resources.id),
    payerAddress: text("payer_address").notNull(),
    recipientAddress: text("recipient_address").notNull(),
    amount: text("amount").notNull(), // USDC amount
    paidAt: timestamp("paid_at").defaultNow().notNull(),
  },
  (table) => ({
    // Payment history is queried per payer wallet (#285).
    payerAddressIdx: index("idx_payments_payer_address").on(table.payerAddress),
  }),
);
