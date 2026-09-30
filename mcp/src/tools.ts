/**
 * MCP tool definitions for the MindVault server.
 *
 * This array is the single source of truth for the tool surface advertised to
 * agent clients (ListTools). It lives outside index.ts so tests and the
 * argument-validation layer can import it without booting the server or its
 * stdio transport. Every tool listed here must have a matching entry in
 * TOOL_ARGUMENT_SPECS (see validation.ts) — enforced by validation.test.ts.
 *
 * `toolSurface.ts` turns this array into the ListTools payload, and
 * `listToolsContract.test.ts` checks the live response against it along with
 * the argument validator and the dispatch switch. Until #596 the handler in
 * index.ts kept its own copy of this list and the two had drifted apart in
 * both directions; the contract test exists so that cannot recur silently.
 */

import { catalogFilterInputProperties } from "./catalogFilters.js";
import {
  AGENT_STATUS_OUTPUT_SCHEMA,
  BATCH_CATALOG_LOOKUP_OUTPUT_SCHEMA,
  CATALOG_LIST_OUTPUT_SCHEMA,
  CONSISTENCY_OUTPUT_SCHEMA,
  FEE_CONFIG_OUTPUT_SCHEMA,
  LIST_PROFILES_OUTPUT_SCHEMA,
  METADATA_HASH_PREVIEW_OUTPUT_SCHEMA,
  METRICS_OUTPUT_SCHEMA,
  NETWORK_PROFILE_OUTPUT_SCHEMA,
  ONCHAIN_MUTATION_OUTPUT_SCHEMA,
  PENDING_TRANSFER_OUTPUT_SCHEMA,
  PREVIEW_OUTPUT_SCHEMA,
  PUBLISH_BUY_OUTPUT_SCHEMA,
  PUBLISH_BATCH_OUTPUT_SCHEMA,
  PUBLISH_STATUS_OUTPUT_SCHEMA,
  PUBLISH_TEMPLATE_OUTPUT_SCHEMA,
  PURCHASE_HISTORY_OUTPUT_SCHEMA,
  BUY_OUTPUT_SCHEMA,
  RECOVER_CACHE_OUTPUT_SCHEMA,
  REGISTER_ONCHAIN_OUTPUT_SCHEMA,
  REGISTRY_COUNT_OUTPUT_SCHEMA,
  REGISTRY_INFO_OUTPUT_SCHEMA,
  REGISTRY_LIST_OUTPUT_SCHEMA,
  REGISTRY_LOOKUP_OUTPUT_SCHEMA,
  RESOURCE_SUBSCRIPTION_OUTPUT_SCHEMA,
  TX_STATUS_OUTPUT_SCHEMA,
  USE_PROFILE_OUTPUT_SCHEMA,
  WALLET_BALANCES_OUTPUT_SCHEMA,
  WALLET_INFO_OUTPUT_SCHEMA,
  WALLET_SETUP_OUTPUT_SCHEMA,
} from "./outputSchemas.js";
import { RECEIPT_EXPORT_MAX_LIMIT, RECEIPT_EXPORT_OUTPUT_SCHEMA } from "./receipts.js";
import {
  DEBUG_BUNDLE_DEFAULT_AUDIT_LINES,
  DEBUG_BUNDLE_MAX_AUDIT_LINES,
  DEBUG_BUNDLE_OUTPUT_SCHEMA,
} from "./debugBundleSchema.js";

/**
 * The `confirmPaid` argument advertised by every tool the paid-operation policy
 * can gate (#594).
 *
 * Declared once and spread into each schema so the wording an agent reads can
 * never drift between two tools that answer to the same guardrail.
 */
const CONFIRM_PAID_PROPERTY = {
  type: "boolean",
  description:
    "Required when the server runs with MINDVAULT_CONFIRM_PAID_OPERATIONS=usdc or =all. Explicitly confirm that this call may spend from the agent wallet. Ignored when the policy is off (the default) and on dry runs.",
} as const;

/** JSON Schema (draft subset) advertised for a tool's arguments. */
export interface ToolInputSchema {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required: string[];
}

/**
 * MCP tool annotations (2025-06-18). These are advisory **hints** only — clients
 * never gate tool use on them, but they let agents know which calls are safe to
 * repeat and which can destroy local state.
 */
export interface ToolAnnotations {
  /** Human-readable title shown next to the tool in client UIs. */
  title: string;
  /** The tool performs no state changes or side effects. */
  readOnlyHint: boolean;
  /** The tool can irreversibly destroy local state. */
  destructiveHint: boolean;
  /** Repeating the tool with identical arguments is safe and yields the same result. */
  idempotentHint: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  /**
   * Optional JSON Schema for the tool's structured result. Tools that declare
   * one return their result as `structuredContent` as well as text, and MUST
   * conform to it (MCP 2025-06-18, "Structured Content").
   */
  outputSchema?: Record<string, unknown>;
  /** MCP tool annotations advertised in ListTools (title + read/destructive/idempotent hints). */
  annotations: ToolAnnotations;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "mindvault_setup_wallet",
    description:
      "Create a Stellar wallet using the sponsored account protocol. Optionally pass a profile name to create the wallet under a named profile (e.g. testnet, mainnet, publisher, buyer) and make it active; defaults to the active profile. The wallet (public key + secret key) is persisted to ~/.mindvault/state.json (mode 0600) and reloaded automatically on restart.",
    inputSchema: {
      type: "object",
      properties: {
        profile: {
          type: "string",
          description:
            "Optional profile name to create/switch to. Use letters, digits, dot, dash, or underscore (1–64 chars). Examples: 'testnet', 'mainnet-publisher', 'buyer.alice'",
          examples: ["testnet", "mainnet-publisher", "buyer.alice"],
        },
        confirmMainnet: {
          type: "boolean",
          description:
            "Required on mainnet (or set MINDVAULT_ALLOW_MAINNET=1). Explicitly confirm this mutation/payment on the public Stellar network.",
        },
      },
      required: [],
    },
    outputSchema: WALLET_SETUP_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Set Up Wallet",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "mindvault_wallet_info",
    description:
      "Check the active profile name, its agent wallet address, USDC balance, and whether it is registered as a publisher.",
    inputSchema: { type: "object", properties: {}, required: [] },
    outputSchema: WALLET_INFO_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Wallet Info",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "mindvault_repair_sponsored_account",
    description:
      "Repair a half-created sponsored account. Derives the address from a recovered secret key, re-fetches its Horizon balances, and restores the wallet to a local profile only when the on-chain account exists. The secret is never returned.",
    inputSchema: {
      type: "object",
      properties: {
        secretKey: {
          type: "string",
          description: "The recovered Stellar secret key returned during the interrupted setup.",
        },
        profile: {
          type: "string",
          description: "Optional profile to repair; defaults to the active profile.",
          examples: ["default", "publisher"],
        },
        confirmMainnet: {
          type: "boolean",
          description:
            "Required on mainnet (or set MINDVAULT_ALLOW_MAINNET=1). Explicitly confirm restoring credentials for the public Stellar network.",
        },
      },
      required: ["secretKey"],
    },
    annotations: {
      title: "Repair Sponsored Account",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "mindvault_use_profile",
    description:
      "Switch the active wallet profile, creating it if it does not exist. Profiles let one agent keep separate identities (e.g. testnet vs mainnet, publisher vs buyer); each has its own wallet and publisher API key. Subsequent tools operate on the active profile.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Profile name to make active. Use letters, digits, dot, dash, or underscore (1–64 chars). Examples: 'mainnet', 'testnet-buyer', 'publisher.bob'",
          examples: ["mainnet", "testnet-buyer", "publisher.bob"],
        },
      },
      required: ["name"],
    },
    outputSchema: USE_PROFILE_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Use Profile",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "mindvault_list_profiles",
    description:
      "List all named wallet profiles, marking the active one and showing each profile's wallet address and whether it is registered as a publisher. Secret keys are never shown.",
    inputSchema: { type: "object", properties: {}, required: [] },
    outputSchema: LIST_PROFILES_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "List Profiles",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "mindvault_switch_network_profile",
    description:
      "Switch the active wallet profile and Stellar network together, then re-run install verification for the selected network.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Profile name to activate." },
        network: {
          type: "string",
          enum: ["testnet", "mainnet"],
          description: "Stellar network for this profile.",
        },
      },
      required: ["name", "network"],
    },
    annotations: {
      title: "Switch Network Profile",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "mindvault_browse",
    description:
      "List resources in the MindVault catalog with the same optional filters as mindvault_search and GET /resources: keyword, price range, verification status, resource type, owner, sort, pagination, tags, and listed state. Sort accepts newest, price_asc, price_desc, or title; results are ordered client-side too, so the order holds even when the backend ignores the parameter.",
    inputSchema: {
      type: "object",
      properties: { ...catalogFilterInputProperties },
      required: [],
    },
    outputSchema: CATALOG_LIST_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Browse Catalog",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "mindvault_search",
    description:
      "Search the MindVault catalog by keyword and optional filters for price, resource type, verification status, owner, sort, pagination, tags, and listed state. Uses server-side filtering where supported and returns compact resource summaries.",
    inputSchema: {
      type: "object",
      properties: { ...catalogFilterInputProperties },
      required: [],
    },
    outputSchema: CATALOG_LIST_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Search Catalog",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "mindvault_preview",
    description:
      "Get details and price for a specific resource before purchasing. Returns title, description, price, type, verification status, and access URL.",
    inputSchema: {
      type: "object",
      properties: {
        resourceId: {
          type: "string",
          description:
            "The unique resource identifier from mindvault_browse or mindvault_search. Example: 'cm7x8y9z'",
          examples: ["cm7x8y9z", "res-001", "ckx9j2h3f"],
        },
      },
      required: ["resourceId"],
    },
    outputSchema: PREVIEW_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Preview Resource",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "mindvault_register",
    description:
      "Register as a publisher using the agent wallet. The API key is persisted to ~/.mindvault/state.json (mode 0600, key not shown in output) and reloaded on restart so mindvault_publish works across sessions.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Publisher display name shown in the catalog (1–128 characters).",
          examples: ["Agent A", "Research Bot"],
        },
        email: {
          type: "string",
          description:
            "Contact email for the publisher record. Must be a valid address (max 254 chars).",
          examples: ["agent-a@example.com"],
        },
        walletAddress: {
          type: "string",
          description:
            "Optional Stellar public key to receive payouts (G… , 56 chars). Defaults to the active profile's agent wallet.",
          examples: ["GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH"],
        },
        confirmMainnet: {
          type: "boolean",
          description:
            "Required on mainnet (or set MINDVAULT_ALLOW_MAINNET=1). Explicitly confirm this mutation/payment on the public Stellar network.",
        },
      },
      required: ["name", "email"],
    },
    annotations: {
      title: "Register Publisher",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "mindvault_publish",
    description:
      "Publish a link resource to the MindVault catalog. The resource undergoes AI verification (agent wallet pays ~$0.10 USDC via x402) and is automatically registered on-chain if verified. Returns resource ID, access URL, verification result, and on-chain registration status. Pass dryRun: true to validate inputs without submitting payment.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description:
            "Resource title shown in the catalog (concise, descriptive; 1–256 characters).",
          examples: ["Intro to Stellar Consensus", "Soroban Smart Contract Tutorial"],
        },
        description: {
          type: "string",
          description:
            "Optional detailed description of the resource content (max 2048 characters).",
          examples: [
            "A beginner-friendly guide covering Stellar's Federated Byzantine Agreement protocol.",
          ],
        },
        price: {
          type: "string",
          description:
            "Price in USDC as a decimal string. Example: '5.00' charges 5 USDC per access.",
          examples: ["5.00", "0.99", "25.00"],
        },
        externalUrl: {
          type: "string",
          description: "Public http(s) URL buyers receive after payment.",
          examples: ["https://docs.stellar.org/consensus", "https://example.com/data.json"],
        },
        dryRun: {
          type: "boolean",
          description:
            "Optional dry-run flag. When true, validates inputs and shows intended network, endpoint, and required wallet state without submitting payment or transactions.",
        },
        confirmMainnet: {
          type: "boolean",
          description:
            "Required on mainnet (or set MINDVAULT_ALLOW_MAINNET=1). Explicitly confirm this mutation/payment on the public Stellar network.",
        },
        confirmPaid: { ...CONFIRM_PAID_PROPERTY },
      },
      required: ["title", "price", "externalUrl"],
    },
    outputSchema: PUBLISH_BUY_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Publish Resource",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "mindvault_buy",
    description:
      "Pay USDC via x402 and access a resource. Payments above MINDVAULT_MAX_AUTO_PAY_USDC (10 USDC by default) require maxAutoPayUsdc set to at least the resource price. On mainnet, pass confirmMainnet: true (or set MINDVAULT_ALLOW_MAINNET=1). Pass dryRun: true to validate the resource and show intended payment flow without submitting payment. Pass wait: true to poll the payment transaction until it settles on-chain before returning.",
    inputSchema: {
      type: "object",
      properties: {
        resourceId: {
          type: "string",
          description:
            "The resource ID to buy, from mindvault_browse or mindvault_search. Letters, digits, dot, dash, or underscore.",
          examples: ["cm7x8y9z", "swcn98besxpp6t1u8e77fqz3"],
        },
        dryRun: {
          type: "boolean",
          description:
            "Optional dry-run flag. When true, validates the resource ID and shows intended network, endpoint, and required wallet state without submitting payment.",
        },
        maxAutoPayUsdc: {
          type: "string",
          description:
            "Explicit per-call maximum automatic payment in USDC. Required when this resource costs more than MINDVAULT_MAX_AUTO_PAY_USDC; must be at least the advertised price.",
          examples: ["25.00"],
        },
        confirmMainnet: {
          type: "boolean",
          description:
            "Required on mainnet (or set MINDVAULT_ALLOW_MAINNET=1). Explicitly confirm this mutation/payment on the public Stellar network.",
        },
        confirmPaid: { ...CONFIRM_PAID_PROPERTY },
        wait: {
          type: "boolean",
          description:
            "Optional flag. When true, wait and poll the payment transaction on Soroban until it settles (SUCCESS or FAILED) or the timeout elapses, returning a settlement confirmation block. Off by default, in which case the buy returns as soon as the payment response arrives.",
        },
        timeoutMs: {
          type: "integer",
          minimum: 0,
          maximum: 300000,
          description:
            "Optional deadline in milliseconds for settlement confirmation when wait is true. Default 60000, inclusive maximum 300000.",
          default: 60000,
          examples: [30000, 60000],
        },
        intervalMs: {
          type: "integer",
          minimum: 200,
          description:
            "Optional interval in milliseconds between settlement status polls when wait is true. Default 2000, minimum 200.",
          default: 2000,
          examples: [500, 2000],
        },
      },
      required: ["resourceId"],
    },
    outputSchema: BUY_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Buy Resource",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "mindvault_export_receipts",
    description:
      "Export receipts for resources this agent has purchased as a schema-versioned document (JSON, RFC 4180 CSV in the envelope's csv field, or Newline-Delimited JSON in the envelope's ndjson field). Filter by resource, network, and date range. Reports a row count and the summed USDC total, so an agent can reconcile spend without re-reading each purchase.",
    inputSchema: {
      type: "object",
      properties: {
        format: {
          type: "string",
          enum: ["json", "csv", "ndjson"],
          description:
            'Output format. "json" (default) returns the receipts array; "csv" additionally renders the same rows as an RFC 4180 document in the envelope\'s csv field; "ndjson" renders each row as a JSON object on its own line in the envelope\'s ndjson field.',
          examples: ["json", "csv", "ndjson"],
        },
        resourceId: {
          type: "string",
          description: "Export only receipts for this resource id.",
          examples: ["cm7x8y9z", "swcn98besxpp6t1u8e77fqz3"],
        },
        network: {
          type: "string",
          description:
            "Export only receipts settled on this x402 network id. Example: 'stellar:testnet'.",
          examples: ["stellar:testnet", "stellar:pubnet"],
        },
        since: {
          type: "string",
          description:
            "Inclusive lower bound on the purchase time (ISO-8601 date or timestamp; a bare date is read as midnight UTC).",
          examples: ["2026-08-01", "2026-08-01T12:00:00Z"],
        },
        until: {
          type: "string",
          description: "Inclusive upper bound on the purchase time (ISO-8601 date or timestamp).",
          examples: ["2026-08-31", "2026-08-31T23:59:59Z"],
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: RECEIPT_EXPORT_MAX_LIMIT,
          description: `Max receipts to export, newest first (1–${RECEIPT_EXPORT_MAX_LIMIT}).`,
          examples: [50, 100],
        },
        groupBy: {
          type: "string",
          enum: ["month"],
          description:
            'Optional grouping. Use "month" to include per-month receipt counts and USDC totals (UTC) in monthlySummaries.',
          examples: ["month"],
        },
      },
      required: [],
    },
    outputSchema: RECEIPT_EXPORT_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Export Receipts",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "mindvault_register_onchain",
    description:
      "Register an already-published, verified resource on the vault registry contract. Use this to retry on-chain registration after mindvault_publish reports the on-chain step failed. Prepares the unsigned transaction, signs it with the agent wallet (which must be the resource creator), submits it, and returns the registry status and on-chain tx hash.",
    inputSchema: {
      type: "object",
      properties: {
        resourceId: {
          type: "string",
          description:
            "The resource ID to register on-chain (from mindvault_publish output). Must be verified and not already registered. Example: 'cm7x8y9z'",
          examples: ["cm7x8y9z", "res-001", "ckx9j2h3f"],
        },
        confirmMainnet: {
          type: "boolean",
          description:
            "Required on mainnet (or set MINDVAULT_ALLOW_MAINNET=1). Explicitly confirm this mutation/payment on the public Stellar network.",
        },
        confirmPaid: { ...CONFIRM_PAID_PROPERTY },
      },
      required: ["resourceId"],
    },
    outputSchema: REGISTER_ONCHAIN_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Register On-Chain",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "mindvault_agent_status",
    description:
      "Check the verification agent's earnings and activity. Returns total verifications, pass/fail counts, total USDC earned, average confidence score, and recent verification history with resource titles.",
    inputSchema: { type: "object", properties: {}, required: [] },
    outputSchema: AGENT_STATUS_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Agent Status",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "mindvault_registry_info",
    description:
      "Return the on-chain vault-registry contract ID, network passphrase, RPC URL, and the resource fields available for direct Soroban queries. Use this to verify ownership, price, and listing state directly from Stellar without trusting the MindVault API.",
    inputSchema: { type: "object", properties: {}, required: [] },
    outputSchema: REGISTRY_INFO_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Registry Info",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "mindvault_terms",
    description:
      'Get or set the active publisher wallet\'s on-chain licensing terms hash. Use operation "get" with a creator address to inspect terms, or "set" with termsHash to bind the active creator identity to a terms document digest.',
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["get", "set"],
          description: "Whether to read or update the creator terms hash.",
        },
        creator: {
          type: "string",
          description:
            "Creator Stellar address to inspect. Optional for get when a wallet is active; set always uses the active wallet.",
        },
        termsHash: {
          type: "string",
          description:
            "Terms document hash or content-addressed digest to store (maximum 64 bytes). Required for set.",
          examples: ["sha256:0123456789abcdef"],
        },
        confirmMainnet: {
          type: "boolean",
          description: "Required for set on mainnet (or set MINDVAULT_ALLOW_MAINNET=1).",
        },
      },
      required: ["operation"],
    },
    annotations: {
      title: "Publisher Terms",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "mindvault_network_profile",
    description:
      "Report current Stellar/x402 network configuration (testnet/mainnet), RPC URLs, registry contract ID, and warnings for custom overrides. Use this to verify which network the MCP is connected to and diagnose configuration issues.",
    inputSchema: { type: "object", properties: {}, required: [] },
    outputSchema: NETWORK_PROFILE_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Network Profile",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "mindvault_check_bindings",
    description:
      "Verify the installed registry-client bindings match the deployed vault-registry contract interface. Reports a match, or a warning listing the drifting methods with the contract ID, network, client version, and a recommended fix (redeploy the contract or regenerate bindings). Useful after a contract redeploy or client upgrade.",
    inputSchema: { type: "object", properties: {}, required: [] },
    annotations: {
      title: "Check Bindings",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "mindvault_check_consistency",
    description:
      "Compare a resource from the API catalog with the same resource in the vault-registry contract. Reports matching fields, mismatches, missing API records, and missing on-chain records, plus the content digest anchored in the on-chain metadata pointer. Pass expectedMetadataHash to assert the anchor matches a digest you computed yourself. Useful for detecting synchronization issues between the API and on-chain registry.",
    inputSchema: {
      type: "object",
      properties: {
        resourceId: {
          type: "string",
          description: "The resource ID to compare between API and on-chain registry.",
        },
        expectedMetadataHash: {
          type: "string",
          description:
            "Optional content digest to compare against the on-chain metadata anchor. Accepts sha256 (64 hex chars) or sha512 (128 hex chars), bare or prefixed ('sha256:…'), case-insensitive. Compared in canonical '<algorithm>:<hex>' form.",
          examples: [
            "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
            "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
          ],
        },
      },
      required: ["resourceId"],
    },
    outputSchema: CONSISTENCY_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Check Consistency",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "mindvault_verify_attestation",
    description:
      "Verify a resource's verifier attestation hash directly against the vault-registry contract. Pass the attestation hash computed for the content received after purchase; the tool compares it with the value registered on-chain and reports whether verification succeeded.",
    inputSchema: {
      type: "object",
      properties: {
        resourceId: {
          type: "string",
          minLength: 1,
          maxLength: 24,
          pattern: "^[a-z0-9]+$",
          description:
            "The on-chain resource ID whose registered attestation hash should be checked.",
          examples: ["cm7x8y9z"],
        },
        attestationHash: {
          type: "string",
          minLength: 1,
          maxLength: 64,
          description:
            "The attestation hash for the content received, exactly as supplied by the verifier (maximum 64 characters).",
          examples: ["9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"],
        },
      },
      required: ["resourceId", "attestationHash"],
    },
    outputSchema: ATTESTATION_VERIFICATION_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Verify Attestation",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "mindvault_registry_lookup",
    description:
      "Look up a resource directly from the on-chain vault registry by its ID. Returns creator wallet address, price (USDC), metadata (title/description), listed state, tags, contract ID, and network. Data comes from Stellar/Soroban, not the MindVault API. Returns an actionable message when the resource is not registered on-chain.",
    inputSchema: {
      type: "object",
      properties: {
        resourceId: {
          type: "string",
          description:
            "The resource ID to look up on-chain. Must be a registered resource. Example: 'cm7x8y9z'",
          examples: ["cm7x8y9z", "res-001", "ckx9j2h3f"],
        },
      },
      required: ["resourceId"],
    },
    outputSchema: REGISTRY_LOOKUP_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Registry Lookup",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "mindvault_registry_list",
    description:
      "List resources registered in the on-chain vault-registry contract with pagination (Soroban list). Returns compact summaries directly from Stellar, not the MindVault API catalog. Use start/limit to page through insertion order; limit is capped at 20 to match the contract. Empty pages return a clear message and next-step hint.",
    inputSchema: {
      type: "object",
      properties: {
        start: {
          type: "integer",
          minimum: 0,
          description:
            "0-based index into the on-chain registry (default 0). Example: 0 for the first page, 20 for the second page when limit is 20.",
          examples: [0, 20],
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description:
            "Page size (1–20, default 20). The contract silently caps higher values at 20.",
          examples: [20, 10],
        },
      },
      required: [],
    },
    outputSchema: REGISTRY_LIST_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Registry List",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "mindvault_registry_count",
    description:
      "Return on-chain resource counts directly from the vault-registry contract: total registered resources (count), currently listed resources (listed_count), and optionally how many resources a specific creator currently owns (creator_resource_count). Use this to get a quick summary of registry size without paging through all entries.",
    inputSchema: {
      type: "object",
      properties: {
        creator: {
          type: "string",
          description:
            "Optional Stellar public key (G…). When supplied, also returns the number of resources currently owned by that address (creator_resource_count). Omit to return only the global counts.",
          examples: ["GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"],
        },
      },
      required: [],
    },
    outputSchema: REGISTRY_COUNT_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Registry Count",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "mindvault_tx_status",
    description:
      "Look up the status of a Stellar transaction by hash via Soroban RPC. Returns SUCCESS, FAILED, or NOT_FOUND along with ledger number, close time, application order, and XDR envelopes. Useful for debugging on-chain registration failures.",
    inputSchema: {
      type: "object",
      properties: {
        txHash: {
          type: "string",
          description:
            "The 64-character hex transaction hash from Stellar (a sha256 digest; case-insensitive, 'sha256:' prefix accepted). From mindvault_register_onchain or mindvault_publish output.",
          examples: [
            "f47ac10b58cc4372a5670e02b2c3d479c3e5d0a1b2c3d4e5f6a7b8c9d0e1f2a3",
            "3fdba35f04dc8c462986c992bcf875546257113072a909c162f7e470e581e278",
          ],
        },
      },
      required: ["txHash"],
    },
    outputSchema: TX_STATUS_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Transaction Status",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "mindvault_reset",
    description:
      "Clear credentials from memory and disk (~/.mindvault/state.json). By default only the active profile is cleared; pass all=true to remove every profile and delete the state file. After reset, run mindvault_setup_wallet and mindvault_register again.",
    inputSchema: {
      type: "object",
      properties: {
        confirm: {
          type: "boolean",
          description:
            "Required to actually clear anything. Omitted or false returns a warning describing what would be removed and performs no deletion. Example: true clears the credentials.",
          examples: [true, false],
        },
        all: {
          type: "boolean",
          description:
            "Clear every profile and delete the state file (default: false clears active profile only). Example: true removes all profiles.",
          examples: [true, false],
        },
        confirmMainnet: {
          type: "boolean",
          description:
            "Required on mainnet (or set MINDVAULT_ALLOW_MAINNET=1). Explicitly confirm this mutation/payment on the public Stellar network.",
        },
      },
      required: [],
    },
    annotations: {
      title: "Reset State",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    },
  },
  {
    name: "mindvault_backup_state",
    description:
      "Export ~/.mindvault/state.json to a mode-0600 encrypted recovery file after an explicit confirmation step. Requires a passphrase (min 8 chars); wallet secret keys and API keys never appear in plaintext. Restore with mindvault_restore_state using the file contents and same passphrase.",
    inputSchema: {
      type: "object",
      properties: {
        passphrase: {
          type: "string",
          description: "Passphrase used to encrypt the backup (min 8 characters). Keep it offline.",
        },
        confirm: {
          type: "boolean",
          description:
            "Required to write the encrypted recovery file. Omitted or false returns a safety preview.",
        },
      },
      required: ["passphrase"],
    },
    annotations: {
      title: "Back Up State",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "mindvault_resource_provenance",
    description:
      "Return the chronological creator, purchase, and ownership-transfer chain recorded for a resource. Never exposes wallet secrets or API keys.",
    inputSchema: {
      type: "object",
      properties: {
        resourceId: { type: "string", description: "Resource identifier to audit." },
      },
      required: ["resourceId"],
    },
    annotations: {
      title: "Resource Provenance",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "mindvault_resource_change_log",
    description:
      "Return recent price and metadata changes recorded for a resource in chronological order.",
    inputSchema: {
      type: "object",
      properties: {
        resourceId: { type: "string", description: "Resource identifier to inspect." },
      },
      required: ["resourceId"],
    },
    annotations: {
      title: "Resource Change Log",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "mindvault_restore_state",
    description:
      "Restore ~/.mindvault/state.json from an encrypted backup produced by mindvault_backup_state. Validates integrity (wrong passphrase or tampered data fails before any write). Replaces in-memory profiles and re-persists to disk (mode 0600). Existing reset behavior is unchanged.",
    inputSchema: {
      type: "object",
      properties: {
        blob: {
          type: "string",
          description: "Encrypted backup blob from mindvault_backup_state (v1:… format).",
        },
        passphrase: {
          type: "string",
          description: "Passphrase used when the backup was created (min 8 characters).",
        },
      },
      required: ["blob", "passphrase"],
    },
    annotations: {
      title: "Restore State",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    },
  },
  {
    name: "mindvault_metrics",
    description:
      "Return opt-in tool-level metrics: per-tool call/error counts and durations, plus payment attempt/failure totals. Enable by setting MINDVAULT_METRICS=1 on the server. Output contains only tool names, counts, and durations — never arguments, wallets, or API keys. Pass reset=true to clear counters after reading. format=otlp renders the same snapshot as an OTLP/JSON ExportMetricsServiceRequest body for direct submission to an OpenTelemetry collector.",
    inputSchema: {
      type: "object",
      properties: {
        reset: {
          type: "boolean",
          description:
            "Clear all counters after returning the current snapshot (default: false leaves counters intact). Example: true resets metrics after reading.",
          examples: [true, false],
        },
        format: {
          type: "string",
          enum: ["json", "otlp"],
          description:
            "Metrics export format. json (default) returns the snapshot object; otlp returns the same data as an OTLP/JSON ExportMetricsServiceRequest payload (a resourceMetrics envelope ready for an OpenTelemetry collector).",
          default: "json",
          examples: ["json", "otlp"],
        },
      },
      required: [],
    },
    outputSchema: METRICS_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Tool Metrics",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "mindvault_set_tags",
    description:
      "Replace the discovery tags on an on-chain resource. Only the resource creator (the agent wallet) may call this. Tags are normalized to lowercase before the on-chain call — pass them already lowercased to avoid round-trip surprises. Constraints: 0–8 tags, each 1–32 characters, containing only lowercase letters, digits, hyphens, or underscores. Pass an empty array to clear all tags. Requires a funded agent wallet.",
    inputSchema: {
      type: "object",
      properties: {
        resourceId: {
          type: "string",
          description:
            "The on-chain resource ID to update tags for (from mindvault_publish or mindvault_browse).",
          examples: ["cm7x8y9z", "res-001"],
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description:
            "Replacement tag list (0–8 entries, each 1–32 chars). Tags are normalized to lowercase. Use lowercase letters, digits, hyphens, or underscores. Examples: ['dataset', 'research'], [] to clear all tags.",
          examples: [["dataset", "research"], ["finance", "api"], []],
        },
        confirmMainnet: {
          type: "boolean",
          description:
            "Required on mainnet (or set MINDVAULT_ALLOW_MAINNET=1). Explicitly confirm this mutation on the public Stellar network.",
        },
        confirmPaid: { ...CONFIRM_PAID_PROPERTY },
      },
      required: ["resourceId", "tags"],
    },
    annotations: {
      title: "Set Tags",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "mindvault_update_metadata",
    description:
      "Update the on-chain metadata pointer for a registered resource in the vault registry contract. Only the resource creator/owner may call this. Validates the pointer length and format (must start with ipfs://, ar://, http(s)://, sha256:, sha-256:, or 0x and be at most 512 characters) client-side before signing and submitting.",
    inputSchema: {
      type: "object",
      properties: {
        resourceId: {
          type: "string",
          description:
            "The on-chain resource ID to update (from mindvault_publish or mindvault_browse). Letters, digits, dot, dash, or underscore.",
          examples: ["cm7x8y9z", "res-001"],
        },
        metadata: {
          type: "string",
          description:
            "The new metadata pointer string (max 512 characters). Must start with ipfs://, ar://, http(s)://, sha256:, sha-256:, or 0x. Example: 'ipfs://QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco'",
          examples: [
            "ipfs://QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco",
            "https://example.com/metadata.json",
          ],
        },
        confirmMainnet: {
          type: "boolean",
          description:
            "Required on mainnet (or set MINDVAULT_ALLOW_MAINNET=1). Explicitly confirm this mutation/payment on the public Stellar network.",
        },
        confirmPaid: { ...CONFIRM_PAID_PROPERTY },
      },
      required: ["resourceId", "metadata"],
    },
    outputSchema: ONCHAIN_MUTATION_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Update Metadata",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "mindvault_set_price",
    description:
      "Update the on-chain price in USDC for a registered resource in the vault registry contract. Only the resource creator/owner may call this. Prepares, signs, and submits the set_price mutation.",
    inputSchema: {
      type: "object",
      properties: {
        resourceId: {
          type: "string",
          description: "The resource ID to update price for. Example: 'cm7x8y9z'",
          examples: ["cm7x8y9z", "res-001"],
        },
        price: {
          type: "string",
          description:
            "New price in USDC as a decimal string. Example: '10.00' charges 10 USDC per access.",
          examples: ["10.00", "5.50", "0.99"],
        },
        confirmMainnet: {
          type: "boolean",
          description:
            "Required on mainnet (or set MINDVAULT_ALLOW_MAINNET=1). Explicitly confirm this mutation/payment on the public Stellar network.",
        },
        confirmPaid: { ...CONFIRM_PAID_PROPERTY },
      },
      required: ["resourceId", "price"],
    },
    outputSchema: ONCHAIN_MUTATION_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Set Price",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "mindvault_transfer_ownership",
    description:
      "Transfer ownership of a registered resource on the vault registry contract to a new creator wallet address (G… key). Only the current resource owner may call this.",
    inputSchema: {
      type: "object",
      properties: {
        resourceId: {
          type: "string",
          description: "The resource ID to transfer ownership of. Example: 'cm7x8y9z'",
          examples: ["cm7x8y9z", "res-001"],
        },
        newCreator: {
          type: "string",
          description: "The Stellar public key (G… , 56 chars) of the new resource owner.",
          examples: ["GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH"],
        },
        confirmMainnet: {
          type: "boolean",
          description:
            "Required on mainnet (or set MINDVAULT_ALLOW_MAINNET=1). Explicitly confirm this mutation/payment on the public Stellar network.",
        },
        confirmPaid: { ...CONFIRM_PAID_PROPERTY },
      },
      required: ["resourceId", "newCreator"],
    },
    outputSchema: ONCHAIN_MUTATION_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Transfer Ownership",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "mindvault_accept_transfer",
    description:
      "Accept a pending ownership transfer of a registered resource. Only the address that was nominated as the new owner via mindvault_transfer_ownership can call this — the wallet must be the proposed new creator.",
    inputSchema: {
      type: "object",
      properties: {
        resourceId: {
          type: "string",
          description: "The resource ID whose pending transfer to accept. Example: 'cm7x8y9z'",
          examples: ["cm7x8y9z", "res-001"],
        },
        confirmMainnet: {
          type: "boolean",
          description:
            "Required on mainnet (or set MINDVAULT_ALLOW_MAINNET=1). Explicitly confirm this mutation on the public Stellar network.",
        },
      },
      required: ["resourceId"],
    },
    outputSchema: ONCHAIN_MUTATION_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Accept Transfer",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "mindvault_cancel_transfer",
    description:
      "Cancel a pending ownership transfer of a registered resource. Only the current resource owner may call this. After an accepted transfer this will return an error — use this only while the transfer is still pending.",
    inputSchema: {
      type: "object",
      properties: {
        resourceId: {
          type: "string",
          description: "The resource ID whose pending transfer to cancel. Example: 'cm7x8y9z'",
          examples: ["cm7x8y9z", "res-001"],
        },
        confirmMainnet: {
          type: "boolean",
          description:
            "Required on mainnet (or set MINDVAULT_ALLOW_MAINNET=1). Explicitly confirm this mutation on the public Stellar network.",
        },
      },
      required: ["resourceId"],
    },
    outputSchema: ONCHAIN_MUTATION_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Cancel Transfer",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "mindvault_pending_transfer",
    description:
      "Read the open ownership-transfer proposal for a registered resource. Returns the proposed new owner address if a pending transfer exists (created via mindvault_transfer_ownership), or a clear not-found message when no transfer is pending. Read-only — does not require a funded wallet.",
    inputSchema: {
      type: "object",
      properties: {
        resourceId: {
          type: "string",
          description:
            "The resource ID to inspect for a pending ownership transfer. Example: 'cm7x8y9z'",
          examples: ["cm7x8y9z", "res-001"],
        },
      },
      required: ["resourceId"],
    },
    outputSchema: PENDING_TRANSFER_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Pending Transfer",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "mindvault_set_listed",
    description:
      "Manage catalog availability by changing the listed state (listed or delisted) of a resource on the vault registry contract. Only the resource creator/owner may call this.",
    inputSchema: {
      type: "object",
      properties: {
        resourceId: {
          type: "string",
          description: "The resource ID to change listed state for. Example: 'cm7x8y9z'",
          examples: ["cm7x8y9z", "res-001"],
        },
        listed: {
          type: "boolean",
          description:
            "Set to true to list/relist the resource in the catalog, or false to delist it.",
          examples: [true, false],
        },
        confirmMainnet: {
          type: "boolean",
          description:
            "Required on mainnet (or set MINDVAULT_ALLOW_MAINNET=1). Explicitly confirm this mutation on the public Stellar network.",
        },
        confirmPaid: { ...CONFIRM_PAID_PROPERTY },
      },
      required: ["resourceId", "listed"],
    },
    outputSchema: ONCHAIN_MUTATION_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Set Listed",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "mindvault_freeze",
    description:
      'Permanently freeze the on-chain metadata pointer for a resource. Only the resource creator/owner may call this. This is irreversible and requires confirm: "freeze_metadata".',
    inputSchema: {
      type: "object",
      properties: {
        resourceId: {
          type: "string",
          description: "The resource ID whose metadata should be frozen. Example: 'cm7x8y9z'",
          examples: ["cm7x8y9z", "res-001"],
        },
        confirm: {
          type: "string",
          description:
            'Required exact confirmation string. Pass "freeze_metadata" to perform the irreversible freeze.',
          examples: ["freeze_metadata"],
        },
        confirmMainnet: {
          type: "boolean",
          description:
            "Required on mainnet (or set MINDVAULT_ALLOW_MAINNET=1). Explicitly confirm this mutation on the public Stellar network.",
        },
        confirmPaid: { ...CONFIRM_PAID_PROPERTY },
      },
      required: ["resourceId", "confirm"],
    },
    outputSchema: ONCHAIN_MUTATION_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Freeze Metadata",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    },
  },
  {
    name: "mindvault_fee_config",
    description:
      "Read the on-chain registry fee configuration: platform fee, royalty fee, total fee, creator payout basis points, and fee recipient. Use this before quoting creator payout.",
    inputSchema: { type: "object", properties: {}, required: [] },
    outputSchema: FEE_CONFIG_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Fee Config",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "mindvault_royalty",
    description:
      "Set or clear a resource-specific royalty recipient override on the vault registry contract. Only the resource creator/owner may call this.",
    inputSchema: {
      type: "object",
      properties: {
        resourceId: {
          type: "string",
          description: "The resource ID to configure royalties for. Example: 'cm7x8y9z'",
          examples: ["cm7x8y9z", "res-001"],
        },
        royaltyRecipient: {
          type: "string",
          description:
            "The Stellar public key (G... , 56 chars) to receive royalties. Omit when clear is true.",
          examples: ["GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH"],
        },
        clear: {
          type: "boolean",
          description:
            "When true, clear the resource-specific royalty recipient and use the registry default.",
        },
        confirmMainnet: {
          type: "boolean",
          description:
            "Required on mainnet (or set MINDVAULT_ALLOW_MAINNET=1). Explicitly confirm this mutation on the public Stellar network.",
        },
        confirmPaid: { ...CONFIRM_PAID_PROPERTY },
      },
      required: ["resourceId"],
    },
    outputSchema: ONCHAIN_MUTATION_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Set Royalty Recipient",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "mindvault_check_state_permissions",
    description:
      "Verify the state file (~/.mindvault/state.json) has safe permissions (mode 0600). Warns when the file is world-readable or group-readable, which would expose wallet secret keys and API keys to other system users. Safe by default; run after any manual file operations or environment migration.",
    inputSchema: { type: "object", properties: {}, required: [] },
    annotations: {
      title: "Check State Permissions",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "mindvault_registry_health",
    description:
      "Check the health of every dependency the MCP server relies on: MindVault API, Horizon, Soroban RPC, vault-registry contract, and x402 network alignment. Returns per-dependency status (ok/error) with actionable failure messages. Does not leak secrets or environment variables.",
    inputSchema: { type: "object", properties: {}, required: [] },
    annotations: {
      title: "Registry Health",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "mindvault_prewarm_catalog",
    description:
      "Fetch the full catalog once to warm the offline catalog fallback cache (see catalogCache.ts). Useful right after connecting a new agent session, or after a cold boot, so a transport failure on the first real mindvault_browse/mindvault_search call falls back to a fresh snapshot instead of having none available. The MCP server also does this automatically once at startup, best-effort; this tool lets an agent trigger it explicitly and see the result.",
    inputSchema: { type: "object", properties: {}, required: [] },
    annotations: {
      title: "Pre-warm Catalog Cache",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "mindvault_client_config",
    description:
      "Emit a copy-paste MCP client config (mirrors docs/mcp-client-configs.md) pre-filled with this server's actual entrypoint path and detected network profile — no placeholder path or env values to hand-edit. Pass client to target one of claude-code, claude-desktop, codex, cursor, vscode, windsurf; omit it to get every supported client.",
    inputSchema: {
      type: "object",
      properties: {
        client: {
          type: "string",
          enum: ["claude-code", "claude-desktop", "codex", "cursor", "vscode", "windsurf"],
          description:
            "Which client's config to emit. Omit to receive a config block for every supported client.",
          examples: ["claude-code", "cursor", "vscode"],
        },
      },
      required: [],
    },
    annotations: {
      title: "Generate Client Config",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "mindvault_mainnet_banner",
    description:
      "Session-level explanation of the active network, what paid tools (mindvault_publish, mindvault_buy) and on-chain writes actually cost, and exactly how to confirm a mainnet mutation (confirmMainnet: true, or MINDVAULT_ALLOW_MAINNET=1) — plus the current paid-operation confirmation policy (confirmPaid / MINDVAULT_CONFIRM_PAID_OPERATIONS), when the operator has one configured. Call this once at the start of a session, especially before any paid or destructive operation on mainnet.",
    inputSchema: { type: "object", properties: {}, required: [] },
    annotations: {
      title: "Mainnet Session Banner",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "mindvault_import_wallet",
    description:
      "Import an existing Stellar wallet by providing a secret key (or reading MINDVAULT_AGENT_SECRET from the environment). Validates the key, optionally persists it to the active profile (or a named profile), and never logs the secret. Use this to restore a wallet from backup or connect to an existing identity.",
    inputSchema: {
      type: "object",
      properties: {
        secretKey: {
          type: "string",
          description:
            "Stellar secret key (S… , 56 chars) to import. If omitted, reads from MINDVAULT_AGENT_SECRET env var.",
          examples: ["SCHZPJ..."],
        },
        profile: {
          type: "string",
          description: "Optional profile name to import into. Defaults to the active profile.",
          examples: ["testnet", "mainnet-publisher"],
        },
        persist: {
          type: "boolean",
          description:
            "When true (default), save the imported wallet to the state file. When false, validate only and return the public key without writing to disk.",
          examples: [true, false],
        },
        confirmMainnet: {
          type: "boolean",
          description:
            "Required on mainnet (or set MINDVAULT_ALLOW_MAINNET=1). Explicitly confirm this mutation on the public Stellar network.",
        },
      },
      required: [],
    },
    outputSchema: WALLET_SETUP_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Import Wallet",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "mindvault_rotate_publisher_key",
    description:
      "Rotate the publisher API key for the active profile. Calls the MindVault server rotation endpoint (POST /publishers/rotate-key), stores the new key in the state file, and returns the updated publisher ID. The old key is invalidated server-side. Requires an existing registration (mindvault_register).",
    inputSchema: {
      type: "object",
      properties: {
        profile: {
          type: "string",
          description:
            "Optional profile name to rotate the key for. Defaults to the active profile.",
          examples: ["testnet", "mainnet-publisher"],
        },
        confirmMainnet: {
          type: "boolean",
          description:
            "Required on mainnet (or set MINDVAULT_ALLOW_MAINNET=1). Explicitly confirm this mutation on the public Stellar network.",
        },
      },
      required: [],
    },
    annotations: {
      title: "Rotate Publisher Key",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "mindvault_verify_install",
    description:
      "Verify the MindVault MCP server is installed and configured correctly. Checks Node.js version (>=20), network settings, URL variables, vault-registry contract ID, and warns about plaintext secrets in the environment. No network calls are made — all checks are local. Run this first when setting up a new agent or diagnosing a configuration problem.",
    inputSchema: { type: "object", properties: {}, required: [] },
    annotations: {
      title: "Verify Install",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "mindvault_debug_bundle",
    description:
      "Export a sanitized debug bundle to attach to a bug report or support ticket: resolved configuration, startup diagnostics, install checks, a profile summary (addresses only), state-file permissions, metrics, catalog cache status, and the tail of the audit log. Secret keys, API keys, and tokens never enter the bundle; public keys and contract ids are kept so it stays useful. Local and read-only, no network calls.",
    inputSchema: {
      type: "object",
      properties: {
        auditLogLines: {
          type: "integer",
          minimum: 0,
          maximum: DEBUG_BUNDLE_MAX_AUDIT_LINES,
          description: `Audit-log entries to include from the end of MINDVAULT_AUDIT_LOG_FILE (0–${DEBUG_BUNDLE_MAX_AUDIT_LINES}, default ${DEBUG_BUNDLE_DEFAULT_AUDIT_LINES}). 0 omits the section.`,
          examples: [50, 200],
        },
        includeEnvironment: {
          type: "boolean",
          description:
            "Include the MindVault-related environment variables with credential-like values masked. Default true; pass false to omit the section entirely.",
          examples: [true, false],
        },
      },
      required: [],
    },
    outputSchema: DEBUG_BUNDLE_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Export Debug Bundle",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "mindvault_recover_catalog_cache",
    description:
      "Attempt a catalog stale-cache recovery: requests the MCP to refresh or re-fetch catalog index data and provides recovery guidance. Useful when browse results appear stale.",
    inputSchema: { type: "object", properties: {}, required: [] },
    outputSchema: RECOVER_CACHE_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Recover Catalog Cache",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    // Advertised by the ListTools handler in index.ts long before it was
    // defined here, so the generated tool reference never listed it (#596).
    name: "mindvault_publish_status",
    description:
      "Poll a published resource's verification and on-chain sync status. Returns verificationStatus (pending, verified, rejected, skipped), listed, onchainStatus, onchainTxHash, and optional verification details. Pass wait: true to poll until verification settles or timeoutMs elapses. Deterministic errors for missing resourceId and 404s.",
    inputSchema: {
      type: "object",
      properties: {
        resourceId: {
          type: "string",
          description:
            "The resource ID from mindvault_publish (or browse/search). Example: 'cm7x8y9z'",
          examples: ["cm7x8y9z", "res-001", "swcn98besxpp6t1u8e77fqz3"],
        },
        wait: {
          type: "boolean",
          description:
            "When true, poll until verificationStatus is verified, rejected, or skipped (or until timeoutMs). Default false (single fetch).",
        },
        timeoutMs: {
          type: "number",
          description:
            "Max wait time in milliseconds when wait is true (default 60000, max 300000).",
          examples: [30000, 60000, 120000],
        },
        intervalMs: {
          type: "number",
          description:
            "Delay between polls in milliseconds when wait is true (default 2000, min 200).",
          examples: [1000, 2000, 5000],
        },
      },
      required: ["resourceId"],
    },
    outputSchema: PUBLISH_STATUS_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Publish Status",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    // As with mindvault_publish_status: advertised from index.ts only, so it
    // was invisible to the generated docs and the schema snapshots (#596).
    name: "mindvault_purchase_history",
    description:
      "List locally persisted purchase receipts from successful mindvault_buy calls (~/.mindvault/purchases.json). Read-only. Filter by resourceId and network (exact match), or search resource ids and titles with a case-insensitive query. Filters can be combined. Returns newest first.",
    inputSchema: {
      type: "object",
      properties: {
        resourceId: {
          type: "string",
          description: "Optional. Only return receipts for this resource id. Example: 'cm7x8y9z'",
          examples: ["cm7x8y9z", "res-001"],
        },
        network: {
          type: "string",
          description:
            "Optional. Only return receipts recorded on this x402 network id. Example: 'stellar:testnet'",
          examples: ["stellar:testnet", "stellar:pubnet"],
        },
        query: {
          type: "string",
          description:
            "Optional case-insensitive text search across receipt resource ids and titles.",
          examples: ["stellar", "res-001"],
        },
      },
      required: [],
    },
    outputSchema: PURCHASE_HISTORY_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Purchase History",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "mindvault_publish_batch",
    description:
      "Publish up to 10 link resources in a single batch. Each resource is created and verified via x402 payment individually (the agent wallet pays the verification fee per item), then all verified resources are registered on-chain in one `register_batch` Soroban transaction — a single wallet approval covers the entire batch. Returns a summary with per-item verification status, on-chain status, and the batch transaction hash.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description:
            "List of resources to publish (1–10 items). Each item must include title, price, and externalUrl.",
          items: {
            type: "object",
            properties: {
              title: {
                type: "string",
                description: "Resource title (1–256 characters).",
                examples: ["My Dataset", "Research Paper #1"],
              },
              description: {
                type: "string",
                description: "Optional description (max 2048 characters).",
              },
              price: {
                type: "string",
                description: "Price in USDC as a decimal string, e.g. '5.00'.",
                examples: ["1.00", "5.00", "10.00"],
              },
              externalUrl: {
                type: "string",
                description: "Public http(s) URL buyers receive after payment.",
                examples: ["https://example.com/data.json"],
              },
            },
            required: ["title", "price", "externalUrl"],
          },
          minItems: 1,
          maxItems: 10,
        },
        confirmMainnet: {
          type: "boolean",
          description:
            "Required on mainnet (or set MINDVAULT_ALLOW_MAINNET=1). Explicitly confirm this mutation/payment on the public Stellar network.",
        },
        confirmPaid: { ...CONFIRM_PAID_PROPERTY },
      },
      required: ["items"],
    },
    outputSchema: PUBLISH_BATCH_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Publish Batch",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
];
