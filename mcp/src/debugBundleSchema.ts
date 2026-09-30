/**
 * Constants and the advertised output schema for `mindvault_debug_bundle`
 * (#675), kept import-free so `tools.ts` and `validation.ts` can read them
 * without pulling in the runtime (which itself depends on `tools.ts`).
 */

export const DEBUG_BUNDLE_SCHEMA = "mindvault.debug-bundle/v1";

/** Default and ceiling for the audit-log tail. */
export const DEBUG_BUNDLE_DEFAULT_AUDIT_LINES = 50;
export const DEBUG_BUNDLE_MAX_AUDIT_LINES = 500;

/** Mirrors the version the server announces in its MCP handshake. */
export const SERVER_VERSION = "1.0.0";

/** JSON Schema for the bundle, advertised as the tool's `outputSchema`. */
export const DEBUG_BUNDLE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    schema: { type: "string", const: DEBUG_BUNDLE_SCHEMA },
    generatedAt: { type: "string", description: "ISO-8601 instant the bundle was produced." },
    sanitized: {
      type: "object",
      description: "What was withheld and the rules that decided it.",
      properties: {
        maskedEnvironment: { type: "array", items: { type: "string" } },
        rules: { type: "array", items: { type: "string" } },
      },
      required: ["maskedEnvironment", "rules"],
    },
    runtime: {
      type: "object",
      properties: {
        serverVersion: { type: "string" },
        nodeVersion: { type: "string" },
        platform: { type: "string" },
        arch: { type: "string" },
        mockMode: { type: "boolean" },
        readOnlyMode: { type: "boolean" },
      },
      required: ["serverVersion", "nodeVersion", "platform", "arch", "mockMode", "readOnlyMode"],
    },
    config: {
      type: "object",
      description: "The fully resolved configuration (env var, network preset, or default).",
      properties: {
        stellarNetwork: { type: "string" },
        x402Network: { type: "string" },
        baseUrl: { type: "string" },
        registryContractId: { type: "string" },
        registryNetworkPassphrase: { type: "string" },
        sponsoredAccountUrl: { type: "string" },
        horizonUrl: { type: "string" },
        sorobanRpcUrl: { type: "string" },
      },
      required: ["stellarNetwork", "x402Network", "baseUrl", "registryContractId"],
    },
    environment: {
      type: ["object", "null"],
      description:
        'MindVault-related environment variables; credential-like names carry "[REDACTED]". Null when includeEnvironment is false.',
      additionalProperties: { type: "string" },
    },
    diagnostics: {
      type: "array",
      items: {
        type: "object",
        properties: {
          variable: { type: "string" },
          severity: { type: "string", enum: ["error", "warning"] },
          message: { type: "string" },
          expected: { type: "string" },
        },
        required: ["variable", "severity", "message"],
      },
    },
    install: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        checks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              ok: { type: "boolean" },
              detail: { type: "string" },
            },
            required: ["name", "ok", "detail"],
          },
        },
      },
      required: ["ok", "checks"],
    },
    profiles: {
      type: "object",
      properties: {
        active: { type: "string" },
        entries: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              active: { type: "boolean" },
              hasWallet: { type: "boolean" },
              publicKey: { type: ["string", "null"] },
              hasApiKey: { type: "boolean" },
            },
            required: ["name", "active", "hasWallet", "publicKey", "hasApiKey"],
          },
        },
      },
      required: ["active", "entries"],
    },
    state: {
      type: "object",
      properties: {
        dir: { type: "string" },
        file: { type: "string" },
        permissions: {
          type: "object",
          properties: {
            exists: { type: "boolean" },
            mode: { type: ["string", "null"] },
            expectedMode: { type: "string" },
            isSafe: { type: "boolean" },
            message: { type: "string" },
          },
          required: ["exists", "mode", "expectedMode", "isSafe", "message"],
        },
      },
      required: ["dir", "file", "permissions"],
    },
    metrics: {
      type: "object",
      description: "The mindvault_metrics snapshot; enabled=false when metrics are off.",
    },
    catalogCache: {
      type: "object",
      properties: {
        ttlMs: { type: "integer" },
        maxAgeMs: { type: "integer" },
        snapshot: {
          type: "object",
          properties: {
            present: { type: "boolean" },
            savedAt: { type: ["string", "null"] },
            resourceCount: { type: "integer" },
            label: { type: ["string", "null"] },
          },
          required: ["present", "savedAt", "resourceCount", "label"],
        },
      },
      required: ["ttlMs", "maxAgeMs", "snapshot"],
    },
    auditLog: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        filePath: { type: ["string", "null"] },
        exists: { type: "boolean" },
        requested: { type: "integer" },
        entries: { type: "array", items: { type: "object" } },
      },
      required: ["enabled", "filePath", "exists", "requested", "entries"],
    },
  },
  required: [
    "schema",
    "generatedAt",
    "sanitized",
    "runtime",
    "config",
    "environment",
    "diagnostics",
    "install",
    "profiles",
    "state",
    "metrics",
    "catalogCache",
    "auditLog",
  ],
} as const;
