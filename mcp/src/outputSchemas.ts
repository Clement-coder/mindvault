/**
 * Advertised MCP `outputSchema` values for tools with structured results (#553).
 *
 * Each schema is the contract a client can validate `structuredContent` against.
 * Absent values are explicit `null`s where the handler already uses that
 * convention (receipt export, catalog items, wallet address).
 *
 * Tools that sometimes return prose (publish verification failure, missing tx
 * hash) share `TEXT_RESULT_SCHEMA` as a `oneOf` variant so every success still
 * carries a payload.
 */

/** Non-JSON success (insufficient funds, verification rejected, missing hash). */
export const TEXT_RESULT_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", const: "text" },
    message: { type: "string" },
  },
  required: ["status", "message"],
} as const;

const CATALOG_ITEM_SCHEMA = {
  type: "object",
  properties: {
    id: { type: ["string", "null"] },
    title: { type: ["string", "null"] },
    price: { type: ["string", "number", "null"] },
    description: { type: ["string", "null"] },
    accessUrl: { type: ["string", "null"] },
    tags: { type: "array", items: { type: "string" } },
  },
  required: ["id", "title", "price", "description", "accessUrl", "tags"],
} as const;

export const CATALOG_LIST_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    items: { type: "array", items: CATALOG_ITEM_SCHEMA },
    notice: { type: ["string", "null"] },
    truncated: { type: "boolean" },
  },
  required: ["items", "notice", "truncated"],
} as const;

export const WALLET_SETUP_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    profile: { type: "string" },
    address: { type: "string" },
    persisted: { type: "boolean" },
  },
  required: ["profile", "address", "persisted"],
} as const;

export const WALLET_INFO_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    profile: { type: "string" },
    address: { type: "string" },
    xlmBalance: { type: "string" },
    xlmReserve: { type: "string" },
    xlmAvailable: { type: "string" },
    usdcBalance: { type: "string" },
    usdcStatus: { type: "string" },
    publisherRegistered: { type: "boolean" },
    note: { type: ["string", "null"] },
  },
  required: [
    "profile",
    "address",
    "xlmBalance",
    "xlmReserve",
    "xlmAvailable",
    "usdcBalance",
    "usdcStatus",
    "publisherRegistered",
    "note",
  ],
} as const;

export const USE_PROFILE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    profile: { type: "string" },
    address: { type: ["string", "null"] },
    publisherRegistered: { type: ["boolean", "null"] },
  },
  required: ["profile", "address", "publisherRegistered"],
} as const;

const BALANCE_ROW_SCHEMA = {
  type: "object",
  properties: {
    profile: { type: ["string", "null"] },
    address: { type: "string" },
    active: { type: ["boolean", "null"] },
    publisherRegistered: { type: ["boolean", "null"] },
    xlmBalance: { type: ["string", "null"] },
    xlmReserve: { type: ["string", "null"] },
    xlmAvailable: { type: ["string", "null"] },
    usdcBalance: { type: ["string", "null"] },
    usdcStatus: { type: ["string", "null"] },
    note: { type: ["string", "null"] },
  },
  required: [
    "profile",
    "address",
    "active",
    "publisherRegistered",
    "xlmBalance",
    "xlmReserve",
    "xlmAvailable",
    "usdcBalance",
    "usdcStatus",
    "note",
  ],
} as const;

export const WALLET_BALANCES_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    source: { type: "string" },
    requestedAt: { type: "string" },
    platform: {
      type: ["object", "null"],
      properties: {
        configured: { type: "boolean" },
        ...BALANCE_ROW_SCHEMA.properties,
      },
      required: ["configured", ...BALANCE_ROW_SCHEMA.required],
    },
    agents: { type: "array", items: BALANCE_ROW_SCHEMA },
    count: { type: "integer" },
    statistics: {
      type: "object",
      properties: { totalUsdc: { type: "string" }, totalXlm: { type: "string" } },
      required: ["totalUsdc", "totalXlm"],
    },
    message: { type: "string" },
  },
  required: ["source", "requestedAt", "platform", "agents", "count", "statistics", "message"],
} as const;

export const SERVER_ENDPOINTS_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    source: { type: "string" },
    baseUrl: { type: "string" },
    openapi: { type: ["string", "null"] },
    server: { type: ["object", "null"] },
    endpointCount: { type: "integer" },
    operations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          method: { type: "string" },
          path: { type: "string" },
          operationId: { type: ["string", "null"] },
          tags: { type: "array", items: { type: "string" } },
          summary: { type: ["string", "null"] },
        },
        required: ["method", "path", "operationId", "tags", "summary"],
      },
    },
    paths: { type: "array", items: { type: "string" } },
    message: { type: "string" },
  },
  required: [
    "source",
    "baseUrl",
    "openapi",
    "server",
    "endpointCount",
    "operations",
    "paths",
    "message",
  ],
} as const;

export const LIST_PROFILES_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    active: { type: "string" },
    profiles: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          address: { type: ["string", "null"] },
          publisherRegistered: { type: "boolean" },
          active: { type: "boolean" },
        },
        required: ["name", "address", "publisherRegistered", "active"],
      },
    },
  },
  required: ["active", "profiles"],
} as const;

export const PREVIEW_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    id: {},
    title: {},
    description: {},
    price: {},
    type: {},
    verificationStatus: {},
    accessUrl: {},
    offlineCache: { type: "string" },
  },
  required: ["id", "title", "description", "price", "type", "verificationStatus", "accessUrl"],
} as const;

const DRY_RUN_SCHEMA = {
  type: "object",
  properties: {
    mode: { type: "string", const: "dry-run" },
    operation: { type: "string" },
    validation: { type: "object" },
    intentions: { type: "object" },
    steps: { type: "array", items: { type: "string" } },
  },
  required: ["mode", "operation", "validation", "intentions", "steps"],
} as const;

const MUTATION_SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    before: {},
    after: {},
    changedFields: { type: "array", items: { type: "string" } },
    txHash: { type: ["string", "null"] },
    failureGuidance: { type: ["array", "null"] },
  },
  required: ["before", "after", "changedFields", "txHash"],
} as const;

/**
 * The settlement-confirmation block `mindvault_buy` adds to its summary when
 * wait is set (#888): whether the payment transaction was polled, its last
 * status, and whether it reached a terminal status before the deadline.
 */
export const SETTLEMENT_SCHEMA = {
  type: "object",
  properties: {
    polled: { type: "boolean" },
    txHash: { type: ["string", "null"] },
    status: { type: ["string", "null"] },
    settled: { type: "boolean" },
    success: { type: "boolean" },
    timedOut: { type: "boolean" },
    attempts: { type: "integer" },
    skipped: { type: "boolean" },
    message: { type: "string" },
  },
  required: [
    "polled",
    "txHash",
    "status",
    "settled",
    "success",
    "timedOut",
    "attempts",
    "skipped",
    "message",
  ],
} as const;

const BUY_SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    ...MUTATION_SUMMARY_SCHEMA.properties,
    settlement: SETTLEMENT_SCHEMA,
  },
  required: [...MUTATION_SUMMARY_SCHEMA.required, "settlement"],
  description:
    "mindvault_buy result: the purchase diff plus a settlement-confirmation block describing how far the payment transaction got before returning.",
} as const;

export const PUBLISH_BUY_OUTPUT_SCHEMA = {
  type: "object",
  oneOf: [MUTATION_SUMMARY_SCHEMA, DRY_RUN_SCHEMA, TEXT_RESULT_SCHEMA],
} as const;

export const BUY_OUTPUT_SCHEMA = {
  type: "object",
  oneOf: [BUY_SUMMARY_SCHEMA, DRY_RUN_SCHEMA, TEXT_RESULT_SCHEMA],
} as const;

export const REGISTER_ONCHAIN_OUTPUT_SCHEMA = {
  type: "object",
  oneOf: [MUTATION_SUMMARY_SCHEMA, DRY_RUN_SCHEMA, TEXT_RESULT_SCHEMA],
} as const;

export const PUBLISH_STATUS_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    resourceId: { type: "string" },
    title: { type: ["string", "null"] },
    verificationStatus: { type: "string" },
    listed: { type: ["boolean", "null"] },
    onchainStatus: { type: ["string", "null"] },
    onchainTxHash: { type: ["string", "null"] },
    contentHash: { type: ["string", "null"] },
    accessUrl: { type: ["string", "null"] },
    verification: { type: ["object", "null"] },
    polled: { type: "boolean" },
    attempts: { type: "integer" },
    settled: { type: "boolean" },
    timedOut: { type: "boolean" },
    message: { type: "string" },
  },
  required: [
    "resourceId",
    "title",
    "verificationStatus",
    "listed",
    "onchainStatus",
    "onchainTxHash",
    "contentHash",
    "accessUrl",
    "verification",
    "polled",
    "attempts",
    "settled",
    "timedOut",
    "message",
  ],
} as const;

export const PURCHASE_HISTORY_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    count: { type: "integer" },
    purchases: { type: "array" },
    message: { type: "string" },
  },
  required: ["count", "purchases"],
} as const;

export const REGISTRY_LOOKUP_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    source: { type: "string" },
    found: { type: "boolean" },
    id: {},
    resourceId: { type: "string" },
    creator: {},
    price: {},
    metadata: {},
    listed: {},
    tags: {},
    message: { type: "string" },
    next: { type: "string" },
    contract: {},
    network: {},
    rpc: {},
  },
  required: ["source", "found", "contract"],
} as const;

export const REGISTRY_LIST_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    source: { type: "string" },
    start: { type: "integer" },
    limit: { type: "integer" },
    count: { type: "integer" },
    resources: { type: "array" },
    message: { type: "string" },
    contract: {},
    network: {},
    rpc: {},
  },
  required: ["source", "start", "limit", "count", "resources", "contract"],
} as const;

export const REGISTRY_COUNT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    source: { type: "string" },
    count: { type: "integer" },
    listedCount: { type: "integer" },
    creatorCount: { type: "integer" },
    creator: { type: "string" },
    contract: {},
    network: {},
    rpc: {},
  },
  required: ["source", "count", "listedCount", "contract"],
} as const;

export const REGISTRY_INFO_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    contractId: { type: "string" },
    networkPassphrase: { type: "string" },
    rpcUrl: { type: "string" },
    network: { type: "string" },
    x402Network: { type: "string" },
    resourceFields: { type: "array", items: { type: "string" } },
    mainnetDiagnostics: { type: "string" },
  },
  required: [
    "contractId",
    "networkPassphrase",
    "rpcUrl",
    "network",
    "x402Network",
    "resourceFields",
    "mainnetDiagnostics",
  ],
} as const;

export const NETWORK_PROFILE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    stellarNetwork: { type: "string" },
    x402Network: { type: "string" },
    sorobanRpcUrl: { type: "string" },
    horizonUrl: { type: "string" },
    registryContractId: { type: "string" },
    usdcContractId: {},
    timeouts: {},
    retries: {},
    warnings: { type: "array", items: { type: "string" } },
  },
  required: [
    "stellarNetwork",
    "x402Network",
    "sorobanRpcUrl",
    "horizonUrl",
    "registryContractId",
    "usdcContractId",
    "warnings",
  ],
} as const;

export const CONSISTENCY_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    resourceId: { type: "string" },
    apiFound: { type: "boolean" },
    onchainFound: { type: "boolean" },
    onchainError: { type: ["string", "null"] },
    matches: { type: "object" },
    mismatches: { type: "object" },
    missingInApi: { type: "array" },
    missingInOnchain: { type: "array" },
    summary: { type: "string" },
  },
  required: [
    "resourceId",
    "apiFound",
    "onchainFound",
    "onchainError",
    "matches",
    "mismatches",
    "missingInApi",
    "missingInOnchain",
    "summary",
  ],
} as const;

export const ATTESTATION_VERIFICATION_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    source: { type: "string" },
    resourceId: { type: "string" },
    expectedAttestationHash: { type: "string" },
    registeredAttestationHash: { type: ["string", "null"] },
    matches: { type: "boolean" },
    verified: { type: "boolean" },
    summary: { type: "string" },
    contract: { type: "string" },
    network: { type: ["string", "null"] },
    rpc: { type: ["string", "null"] },
  },
  required: [
    "source",
    "resourceId",
    "expectedAttestationHash",
    "registeredAttestationHash",
    "matches",
    "verified",
    "summary",
    "contract",
  ],
} as const;

export const AGENT_STATUS_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
} as const;

export const METRICS_OUTPUT_SCHEMA = {
  type: "object",
  oneOf: [
    {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        since: { type: ["string", "null"] },
        toolDurationBudgetMs: { type: ["integer", "null"] },
        totals: { type: "object" },
        payments: { type: "object" },
        tools: { type: "object" },
        message: { type: "string" },
      },
      required: ["enabled"],
    },
    {
      type: "object",
      description:
        "The same snapshot rendered as an OTLP/JSON ExportMetricsServiceRequest body when format=otlp.",
      required: ["resourceMetrics"],
    },
  ],
} as const;

const TX_FOUND_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string" },
    hash: { type: "string" },
    ledger: {},
    ledgerCloseTime: { type: ["string", "null"] },
    applicationOrder: {},
    feeBump: {},
    envelopeXdr: {},
    resultXdr: {},
    resultMetaXdr: {},
    message: { type: "string" },
    oldestLedger: {},
    latestLedger: {},
  },
  required: ["status", "hash"],
} as const;

export const TX_STATUS_OUTPUT_SCHEMA = {
  type: "object",
  oneOf: [TX_FOUND_SCHEMA, TEXT_RESULT_SCHEMA],
} as const;

const ONCHAIN_MUTATION_SUCCESS = {
  type: "object",
  properties: {
    status: { type: "string" },
    resourceId: { type: "string" },
    txHash: { type: ["string", "null"] },
    metadata: { type: "string" },
    price: { type: "string" },
    newCreator: { type: "string" },
    listed: { type: "boolean" },
  },
  required: ["status", "resourceId", "txHash"],
} as const;

export const ONCHAIN_MUTATION_OUTPUT_SCHEMA = {
  type: "object",
  oneOf: [ONCHAIN_MUTATION_SUCCESS, DRY_RUN_SCHEMA, TEXT_RESULT_SCHEMA],
} as const;

export const FEE_CONFIG_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    source: { type: "string" },
    configured: { type: "boolean" },
    platformFeeBps: { type: "integer" },
    royaltyBps: { type: "integer" },
    totalFeeBps: { type: "integer" },
    creatorPayoutBps: { type: "integer" },
    creatorPayoutPercent: { type: "string" },
    feeRecipient: { type: ["string", "null"] },
    message: { type: "string" },
    contract: {},
    network: {},
    rpc: {},
  },
  required: ["source", "configured", "contract"],
} as const;

export const RECOVER_CACHE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    source: { type: "string" },
    action: { type: "string" },
    message: { type: "string" },
  },
  required: ["source", "action", "message"],
} as const;

const BATCH_PUBLISH_ITEM_SCHEMA = {
  type: "object",
  properties: {
    index: { type: "number" },
    title: { type: "string" },
    id: { type: ["string", "null"] },
    verificationStatus: { type: "string", enum: ["approved", "rejected", "error"] },
    onchainStatus: { type: ["string", "null"] },
    flags: { type: "array", items: { type: "string" } },
    error: { type: "string" },
  },
  required: ["index", "title", "id", "verificationStatus", "onchainStatus"],
} as const;

export const PUBLISH_BATCH_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    requested: { type: "number" },
    verified: { type: "number" },
    rejected: { type: "number" },
    errored: { type: "number" },
    onchainStatus: { type: "string" },
    txHash: { type: ["string", "null"] },
    items: { type: "array", items: BATCH_PUBLISH_ITEM_SCHEMA },
  },
  required: ["requested", "verified", "rejected", "errored", "onchainStatus", "txHash", "items"],
} as const;

/** Tools that must stay text-only (no schema, no structuredContent). */
export const TEXT_ONLY_TOOLS = [
  "mindvault_repair_sponsored_account",
  "mindvault_terms",
  "mindvault_check_bindings",
  "mindvault_reset",
  "mindvault_backup_state",
  "mindvault_restore_state",
  "mindvault_verify_install",
  "mindvault_registry_health",
  "mindvault_check_state_permissions",
  "mindvault_register",
  "mindvault_rotate_publisher_key",
  "mindvault_set_tags",
  "mindvault_prewarm_catalog",
  "mindvault_client_config",
  "mindvault_mainnet_banner",
  "mindvault_switch_network_profile",
  "mindvault_resource_provenance",
  "mindvault_resource_change_log",
] as const;
