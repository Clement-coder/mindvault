/**
 * Registry deployment verification report (#1057).
 *
 * `mindvault_verify_deployment` answers one question an operator should ask
 * after every deploy, upgrade, or network switch: **does the deployment this
 * server is configured to talk to still match the deployment manifest we
 * expect?** It compares the configured network and contract ID, the contract
 * version and resource schema version reported by the contract, and the WASM
 * hash of the deployed code against a versioned expected manifest.
 *
 * Design constraints:
 *   - Read-only. Every on-chain value comes from a Soroban RPC read:
 *     `getNetwork`, `getContractWasmByContractId`, and simulated calls to
 *     `registry_info()` / `contract_version()`. Nothing is signed, submitted,
 *     or mutated, and no wallet is required.
 *   - Two layers, so both are testable without RPC:
 *       - {@link buildDeploymentVerificationReport} is a pure builder over
 *         already-collected values. It never throws.
 *       - {@link fetchDeploymentSnapshot} is the only function that touches
 *         the network. It is injectable through
 *         {@link verifyDeployment}'s `fetchSnapshot` option.
 *   - The report is machine-readable (`schema`, `ok`, `status`, `checks`,
 *     `mismatches`, `errors`) and carries a human-readable `summary`.
 *   - The expected manifest is a versioned JSON document. A canonical testnet
 *     manifest ships with the server; operators on other deployments pass a
 *     manifest for their own deployment, or leave it out and get a clear
 *     "no manifest" error instead of a false clean bill of health.
 */

import { createHash } from "node:crypto";
import { rpc } from "@stellar/stellar-sdk";
import {
  createRegistryClient,
  networks as registryNetworks,
  parseStellarNetwork,
  type StellarDeploymentNetwork,
} from "@mindvault/registry-client";
import { buildConfig } from "./config.js";
import { mockEnabledFromEnv } from "./mock.js";
import { safeErrorMessage } from "./redaction.js";

/** Envelope discriminator for the verification report. */
export const DEPLOYMENT_VERIFICATION_SCHEMA = "mindvault.deployment-verification/v1";

/** Envelope discriminator for an expected deployment manifest. */
export const DEPLOYMENT_MANIFEST_SCHEMA = "mindvault.deployment-manifest/v1";

/** StrKey contract ID format: 'C' followed by 55 base32 characters. */
const CONTRACT_ID_PATTERN = /^C[A-Z2-7]{55}$/;

/** Lowercase hex SHA-256 digest. */
const WASM_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The canonical testnet vault-registry deployment documented in
 * `contract/README.md` (Testnet Deployment table) and mirrored by the testnet
 * network preset. Kept here as a manifest so the default report compares
 * against a reviewed value instead of silently trusting whatever is deployed.
 */
export const CANONICAL_TESTNET_WASM_HASH =
  "fa60c0c2086fddf6add8abc7e1b191e1368ed62983f4e967069fc4b4d679c8eb";

/** `CARGO_PKG_VERSION` of the canonical testnet build. */
export const CANONICAL_TESTNET_CRATE_VERSION = "0.0.0";

/** `RESOURCE_SCHEMA_VERSION` of the canonical testnet build. */
export const CANONICAL_TESTNET_RESOURCE_SCHEMA_VERSION = 7;

/** A reviewed, machine-readable deployment manifest. */
export interface DeploymentManifest {
  schema: typeof DEPLOYMENT_MANIFEST_SCHEMA;
  network: StellarDeploymentNetwork;
  contractId: string;
  /** Lowercase hex SHA-256 of the deployed WASM. */
  wasmHash: string;
  /** `contract_version().crate_version` / `CARGO_PKG_VERSION`. */
  crateVersion: string;
  /** `contract_version().resource_schema_version`. */
  resourceSchemaVersion: number;
}

/**
 * Default manifests, keyed by network. Only the canonical testnet deployment
 * has a reviewed manifest in this repository; mainnet operators deploy their
 * own contract and must pass an expected manifest.
 */
export const DEFAULT_DEPLOYMENT_MANIFESTS: Readonly<
  Record<StellarDeploymentNetwork, DeploymentManifest | null>
> = {
  testnet: {
    schema: DEPLOYMENT_MANIFEST_SCHEMA,
    network: "testnet",
    contractId: registryNetworks.testnet.defaultRegistryContractId!,
    wasmHash: CANONICAL_TESTNET_WASM_HASH,
    crateVersion: CANONICAL_TESTNET_CRATE_VERSION,
    resourceSchemaVersion: CANONICAL_TESTNET_RESOURCE_SCHEMA_VERSION,
  },
  mainnet: null,
};

/** JSON Schema for the optional `manifest` tool argument. */
export const DEPLOYMENT_MANIFEST_INPUT_SCHEMA = {
  type: "object",
  description:
    "Expected deployment manifest to compare against. Omit to use the built-in manifest for the configured network (canonical testnet only).",
  properties: {
    schema: { type: "string", const: DEPLOYMENT_MANIFEST_SCHEMA },
    network: { type: "string", enum: ["testnet", "mainnet"] },
    contractId: {
      type: "string",
      description: "Expected vault-registry contract ID (C followed by 55 base32 chars).",
    },
    wasmHash: {
      type: "string",
      description: "Expected deployed WASM hash: 64 lowercase hex characters.",
    },
    crateVersion: {
      type: "string",
      description: "Expected contract crate version (CARGO_PKG_VERSION at build time).",
    },
    resourceSchemaVersion: {
      type: "integer",
      minimum: 0,
      description: "Expected on-chain Resource schema version (RESOURCE_SCHEMA_VERSION).",
    },
  },
  required: ["network", "contractId", "wasmHash", "crateVersion", "resourceSchemaVersion"],
  additionalProperties: false,
} as const;

/** One configured value the server will use. */
export interface DeploymentVerificationConfigured {
  network: string;
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
}

/** The on-chain values read from the configured deployment. */
export interface DeploymentSnapshot {
  contractId: string;
  networkPassphrase: string;
  /** `registry_info().network_id` as lowercase hex. */
  networkId: string;
  registryName: string;
  /** `contract_version().crate_version`. */
  crateVersion: string;
  /** `contract_version().resource_schema_version`. */
  resourceSchemaVersion: number;
  /** Lowercase hex SHA-256 of the deployed WASM. */
  wasmHash: string;
}

/** Query sent to the injectable on-chain reader. */
export interface DeploymentFetchQuery {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
}

/** Status of one compared field. */
export type DeploymentCheckStatus = "pass" | "mismatch" | "unavailable" | "skipped";

/** Overall report status. */
export type DeploymentVerificationStatus =
  | "match"
  | "mismatch"
  | "unreachable"
  | "invalid_manifest";

/** One field comparison, in a stable order. */
export interface DeploymentVerificationCheck {
  /** Stable field id: `network`, `rpc_network`, `network_id`, `contract_id`, … */
  field: string;
  status: DeploymentCheckStatus;
  expected: string | number | null;
  actual: string | number | null;
  detail: string;
  remediation: string;
}

/** One concrete mismatch, with both values for machine consumption. */
export interface DeploymentVerificationMismatch {
  field: string;
  expected: string | number | null;
  actual: string | number | null;
  detail: string;
  remediation: string;
}

/** A manifest problem or a failed on-chain read. */
export interface DeploymentVerificationError {
  code: string;
  message: string;
}

/** The full report — the payload of `mindvault_verify_deployment`. */
export interface DeploymentVerificationReport {
  schema: typeof DEPLOYMENT_VERIFICATION_SCHEMA;
  ok: boolean;
  status: DeploymentVerificationStatus;
  /** Always true: this tool never mutates on-chain or local state. */
  readOnly: true;
  /** Always `"none"`: no transaction is signed or submitted. */
  signing: "none";
  /** `mock` when the server is in mock mode and no RPC was contacted. */
  mode: "live" | "mock";
  configured: DeploymentVerificationConfigured;
  expected: DeploymentManifest | null;
  observed: DeploymentSnapshot | null;
  checks: DeploymentVerificationCheck[];
  mismatches: DeploymentVerificationMismatch[];
  errors: DeploymentVerificationError[];
  summary: string;
}

/** Raw success JSON Schema; wrapped with the error variant when advertised. */
export const DEPLOYMENT_VERIFICATION_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    schema: { type: "string", const: DEPLOYMENT_VERIFICATION_SCHEMA },
    ok: { type: "boolean" },
    status: {
      type: "string",
      enum: ["match", "mismatch", "unreachable", "invalid_manifest"],
    },
    readOnly: { type: "boolean", const: true },
    signing: { type: "string", const: "none" },
    mode: { type: "string", enum: ["live", "mock"] },
    configured: {
      type: "object",
      properties: {
        network: { type: "string" },
        contractId: { type: "string" },
        rpcUrl: { type: "string" },
        networkPassphrase: { type: "string" },
      },
      required: ["network", "contractId", "rpcUrl", "networkPassphrase"],
    },
    expected: {
      type: ["object", "null"],
      properties: {
        schema: { type: "string" },
        network: { type: "string" },
        contractId: { type: "string" },
        wasmHash: { type: "string" },
        crateVersion: { type: "string" },
        resourceSchemaVersion: { type: "integer" },
      },
      required: [
        "schema",
        "network",
        "contractId",
        "wasmHash",
        "crateVersion",
        "resourceSchemaVersion",
      ],
    },
    observed: {
      type: ["object", "null"],
      properties: {
        contractId: { type: "string" },
        networkPassphrase: { type: "string" },
        networkId: { type: "string" },
        registryName: { type: "string" },
        crateVersion: { type: "string" },
        resourceSchemaVersion: { type: "integer" },
        wasmHash: { type: "string" },
      },
      required: [
        "contractId",
        "networkPassphrase",
        "networkId",
        "registryName",
        "crateVersion",
        "resourceSchemaVersion",
        "wasmHash",
      ],
    },
    checks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          field: { type: "string" },
          status: {
            type: "string",
            enum: ["pass", "mismatch", "unavailable", "skipped"],
          },
          expected: { type: ["string", "number", "null"] },
          actual: { type: ["string", "number", "null"] },
          detail: { type: "string" },
          remediation: { type: "string" },
        },
        required: ["field", "status", "expected", "actual", "detail", "remediation"],
      },
    },
    mismatches: {
      type: "array",
      items: {
        type: "object",
        properties: {
          field: { type: "string" },
          expected: { type: ["string", "number", "null"] },
          actual: { type: ["string", "number", "null"] },
          detail: { type: "string" },
          remediation: { type: "string" },
        },
        required: ["field", "expected", "actual", "detail", "remediation"],
      },
    },
    errors: {
      type: "array",
      items: {
        type: "object",
        properties: {
          code: { type: "string" },
          message: { type: "string" },
        },
        required: ["code", "message"],
      },
    },
    summary: { type: "string" },
  },
  required: [
    "schema",
    "ok",
    "status",
    "readOnly",
    "signing",
    "mode",
    "configured",
    "expected",
    "observed",
    "checks",
    "mismatches",
    "errors",
    "summary",
  ],
} as const;

// ── Manifest parsing ─────────────────────────────────────────────────────────

const MANIFEST_FIELDS = new Set([
  "schema",
  "network",
  "contractId",
  "wasmHash",
  "crateVersion",
  "resourceSchemaVersion",
]);

export interface ManifestParseResult {
  manifest: DeploymentManifest | null;
  errors: DeploymentVerificationError[];
}

/**
 * Validate and normalize an expected manifest. Pure and total: it collects
 * every problem instead of throwing, and rejects unknown fields so a typo does
 * not silently leave a comparison unperformed.
 */
export function parseDeploymentManifest(value: unknown): ManifestParseResult {
  const errors: DeploymentVerificationError[] = [];

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      manifest: null,
      errors: [
        {
          code: "manifest_not_object",
          message: "manifest must be a JSON object.",
        },
      ],
    };
  }

  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!MANIFEST_FIELDS.has(key)) {
      errors.push({
        code: "manifest_unknown_field",
        message: `manifest contains an unrecognized field "${key}".`,
      });
    }
  }

  if (raw.schema !== undefined && raw.schema !== DEPLOYMENT_MANIFEST_SCHEMA) {
    errors.push({
      code: "manifest_invalid_schema",
      message: `manifest.schema must be "${DEPLOYMENT_MANIFEST_SCHEMA}".`,
    });
  }

  const network =
    typeof raw.network === "string" ? parseStellarNetwork(raw.network) : undefined;
  if (!network) {
    errors.push({
      code: "manifest_invalid_network",
      message: 'manifest.network must be "testnet" or "mainnet".',
    });
  }

  const contractId = typeof raw.contractId === "string" ? raw.contractId.trim() : "";
  if (!CONTRACT_ID_PATTERN.test(contractId)) {
    errors.push({
      code: "manifest_invalid_contract_id",
      message: "manifest.contractId must be a Stellar contract ID (C followed by 55 base32 chars).",
    });
  }

  const wasmHash = typeof raw.wasmHash === "string" ? raw.wasmHash.trim().toLowerCase() : "";
  if (!WASM_HASH_PATTERN.test(wasmHash)) {
    errors.push({
      code: "manifest_invalid_wasm_hash",
      message: "manifest.wasmHash must be 64 lowercase hex characters.",
    });
  }

  const crateVersion = typeof raw.crateVersion === "string" ? raw.crateVersion.trim() : "";
  if (crateVersion.length === 0) {
    errors.push({
      code: "manifest_invalid_crate_version",
      message: "manifest.crateVersion must be a non-empty string.",
    });
  }

  const resourceSchemaVersion = raw.resourceSchemaVersion;
  if (
    typeof resourceSchemaVersion !== "number" ||
    !Number.isInteger(resourceSchemaVersion) ||
    resourceSchemaVersion < 0
  ) {
    errors.push({
      code: "manifest_invalid_resource_schema_version",
      message: "manifest.resourceSchemaVersion must be a non-negative integer.",
    });
  }

  if (errors.length > 0 || !network) return { manifest: null, errors };

  return {
    manifest: {
      schema: DEPLOYMENT_MANIFEST_SCHEMA,
      network,
      contractId,
      wasmHash,
      crateVersion,
      resourceSchemaVersion: resourceSchemaVersion as number,
    },
    errors: [],
  };
}

// ── Pure report builder ──────────────────────────────────────────────────────

/** Inputs to the pure builder: everything has already been resolved. */
export interface DeploymentVerificationInput {
  configured: DeploymentVerificationConfigured;
  expected: DeploymentManifest | null;
  observed: DeploymentSnapshot | null;
  /** Manifest validation problems, if any. */
  manifestErrors?: DeploymentVerificationError[];
  /** Why the on-chain read failed, if it did. */
  fetchError?: string | null;
  mode?: "live" | "mock";
}

interface Comparison {
  expected: string | number | null;
  actual: string | number | null;
  expectedDetail: string;
  actualDetail: string;
  remediation: string;
  normalize?: (value: string | number) => string;
}

const defaultNormalize = (value: string | number): string =>
  typeof value === "string" ? value.trim() : String(value);

function comparisonCheck(field: string, input: Comparison): {
  check: DeploymentVerificationCheck;
  mismatch: DeploymentVerificationMismatch | null;
} {
  const normalize = input.normalize ?? defaultNormalize;

  if (input.actual === null || input.actual === undefined) {
    return {
      check: {
        field,
        status: "unavailable",
        expected: input.expected,
        actual: null,
        detail: `${input.expectedDetail}; the deployed value could not be read.`,
        remediation: input.remediation,
      },
      mismatch: null,
    };
  }

  if (normalize(input.expected as string | number) === normalize(input.actual)) {
    return {
      check: {
        field,
        status: "pass",
        expected: input.expected,
        actual: input.actual,
        detail: `${input.expectedDetail} matches ${input.actualDetail}.`,
        remediation: "",
      },
      mismatch: null,
    };
  }

  const detail = `Expected ${input.expectedDetail}, found ${input.actualDetail}.`;
  return {
    check: {
      field,
      status: "mismatch",
      expected: input.expected,
      actual: input.actual,
      detail,
      remediation: input.remediation,
    },
    mismatch: {
      field,
      expected: input.expected,
      actual: input.actual,
      detail,
      remediation: input.remediation,
    },
  };
}

function manifestPassphrase(manifest: DeploymentManifest): string {
  return registryNetworks[manifest.network].networkPassphrase;
}

function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Build the verification report from configured values, an expected manifest,
 * and an observed on-chain snapshot. Pure, synchronous, and total: it never
 * throws and never performs I/O.
 */
export function buildDeploymentVerificationReport(
  input: DeploymentVerificationInput,
): DeploymentVerificationReport {
  const mode = input.mode ?? "live";
  const errors: DeploymentVerificationError[] = [...(input.manifestErrors ?? [])];
  const checks: DeploymentVerificationCheck[] = [];
  const mismatches: DeploymentVerificationMismatch[] = [];

  const base = {
    schema: DEPLOYMENT_VERIFICATION_SCHEMA,
    readOnly: true,
    signing: "none",
    mode,
    configured: input.configured,
  } as const;

  // ── No usable manifest: report the problem, do not pretend to verify ────
  if (!input.expected) {
    if (errors.length === 0) {
      errors.push({
        code: "manifest_missing",
        message:
          "No expected deployment manifest is available for this network. Pass a manifest to verify a custom deployment.",
      });
    }
    const summary = [
      `Deployment verification could not run: ${errors.length} manifest problem(s).`,
      ...errors.map((error) => `  FAIL  ${error.code}: ${error.message}`),
      "Fix the manifest and run the verification again.",
    ].join("\n");
    return {
      ...base,
      ok: false,
      status: "invalid_manifest",
      expected: null,
      observed: null,
      checks,
      mismatches,
      errors,
      summary,
    };
  }

  const expected = input.expected;
  const expectedPassphrase = manifestPassphrase(expected);

  // ── Configured network vs manifest ─────────────────────────────────────
  const network = comparisonCheck("network", {
    expected: expected.network,
    actual: input.configured.network,
    expectedDetail: `network ${expected.network}`,
    actualDetail: `configured network ${input.configured.network}`,
    remediation: `Set STELLAR_NETWORK="${expected.network}" or verify a manifest for "${input.configured.network}".`,
    normalize: (value) => String(value).trim().toLowerCase(),
  });
  checks.push(network.check);
  if (network.mismatch) mismatches.push(network.mismatch);

  // ── Configured contract ID vs manifest ─────────────────────────────────
  const contractId = comparisonCheck("contract_id", {
    expected: expected.contractId,
    actual: input.configured.contractId || null,
    expectedDetail: `contract ${expected.contractId}`,
    actualDetail: `configured contract ${input.configured.contractId || "(unset)"}`,
    remediation:
      "Set VAULT_REGISTRY_CONTRACT_ID to the manifest's contractId, or update the manifest if the new deployment is intentional.",
  });
  checks.push(contractId.check);
  if (contractId.mismatch) mismatches.push(contractId.mismatch);

  // ── On-chain reads ─────────────────────────────────────────────────────
  if (!input.observed) {
    const reason = input.fetchError
      ? safeErrorMessage(input.fetchError)
      : "The on-chain deployment could not be read.";
    errors.push({
      code: "rpc_unreachable",
      message: reason,
    });

    for (const [field, expectedValue, expectedDetail] of [
      ["rpc_network", expectedPassphrase, `RPC passphrase ${JSON.stringify(expectedPassphrase)}`],
      [
        "network_id",
        sha256Hex(expectedPassphrase),
        "registry network id derived from the expected passphrase",
      ],
      ["contract_version", expected.crateVersion, `crate version ${expected.crateVersion}`],
      [
        "resource_schema_version",
        expected.resourceSchemaVersion,
        `resource schema version ${expected.resourceSchemaVersion}`,
      ],
      ["wasm_hash", expected.wasmHash, `WASM hash ${expected.wasmHash}`],
    ] as const) {
      checks.push({
        field,
        status: "unavailable",
        expected: expectedValue,
        actual: null,
        detail: `${expectedDetail}; the deployed value could not be read.`,
        remediation:
          "Confirm SOROBAN_RPC_URL and VAULT_REGISTRY_CONTRACT_ID are reachable, then run the verification again.",
      });
    }
  } else {
    const observed = input.observed;

    const rpcNetwork = comparisonCheck("rpc_network", {
      expected: expectedPassphrase,
      actual: observed.networkPassphrase,
      expectedDetail: `network passphrase ${JSON.stringify(expectedPassphrase)}`,
      actualDetail: `RPC passphrase ${JSON.stringify(observed.networkPassphrase)}`,
      remediation: `Point SOROBAN_RPC_URL at a ${expected.network} RPC endpoint.`,
    });
    checks.push(rpcNetwork.check);
    if (rpcNetwork.mismatch) mismatches.push(rpcNetwork.mismatch);

    const expectedNetworkId = sha256Hex(expectedPassphrase);
    const networkId = comparisonCheck("network_id", {
      expected: expectedNetworkId,
      actual: observed.networkId,
      expectedDetail: `network id ${expectedNetworkId}`,
      actualDetail: `on-chain network id ${observed.networkId}`,
      remediation: `Confirm VAULT_REGISTRY_CONTRACT_ID belongs to ${expected.network} and that SOROBAN_RPC_URL points at ${expected.network}.`,
      normalize: (value) => String(value).trim().toLowerCase(),
    });
    checks.push(networkId.check);
    if (networkId.mismatch) mismatches.push(networkId.mismatch);

    const crateVersion = comparisonCheck("contract_version", {
      expected: expected.crateVersion,
      actual: observed.crateVersion,
      expectedDetail: `contract version ${expected.crateVersion}`,
      actualDetail: `on-chain contract version ${observed.crateVersion}`,
      remediation:
        "Deploy the expected vault-registry build, or update the manifest's crateVersion if the upgrade is intentional.",
    });
    checks.push(crateVersion.check);
    if (crateVersion.mismatch) mismatches.push(crateVersion.mismatch);

    const schemaVersion = comparisonCheck("resource_schema_version", {
      expected: expected.resourceSchemaVersion,
      actual: observed.resourceSchemaVersion,
      expectedDetail: `resource schema version ${expected.resourceSchemaVersion}`,
      actualDetail: `on-chain resource schema version ${observed.resourceSchemaVersion}`,
      remediation:
        "Deploy the expected vault-registry build, or update the manifest's resourceSchemaVersion if the upgrade is intentional.",
    });
    checks.push(schemaVersion.check);
    if (schemaVersion.mismatch) mismatches.push(schemaVersion.mismatch);

    const wasmHash = comparisonCheck("wasm_hash", {
      expected: expected.wasmHash,
      actual: observed.wasmHash,
      expectedDetail: `WASM hash ${expected.wasmHash}`,
      actualDetail: `deployed WASM hash ${observed.wasmHash}`,
      remediation:
        "The deployed code differs from the manifest. Redeploy the expected WASM artifact, or update the manifest's wasmHash if the new build is intentional.",
      normalize: (value) => String(value).trim().toLowerCase(),
    });
    checks.push(wasmHash.check);
    if (wasmHash.mismatch) mismatches.push(wasmHash.mismatch);
  }

  // ── Status + summary ───────────────────────────────────────────────────
  const status: DeploymentVerificationStatus = !input.observed
    ? "unreachable"
    : mismatches.length > 0
      ? "mismatch"
      : "match";
  const ok = status === "match" && errors.length === 0;

  const summaryLines: string[] = [];
  if (ok) {
    summaryLines.push(
      `Deployment verification matched the ${expected.network} manifest (contract ${expected.contractId}, crate ${expected.crateVersion}, resource schema ${expected.resourceSchemaVersion}).`,
    );
  } else if (status === "unreachable") {
    summaryLines.push(
      `Deployment verification could not read the ${expected.network} deployment at ${input.configured.rpcUrl}.`,
    );
  } else {
    summaryLines.push(
      `Deployment verification found ${mismatches.length} mismatch(es) against the ${expected.network} manifest.`,
    );
  }

  for (const check of checks) {
    const marker =
      check.status === "pass"
        ? "ok"
        : check.status === "mismatch"
          ? "FAIL"
          : check.status === "unavailable"
            ? "unread"
            : "skip";
    summaryLines.push(`  ${marker}  ${check.field}: ${check.detail}`);
  }
  for (const error of errors) {
    summaryLines.push(`  ERROR  ${error.code}: ${error.message}`);
  }
  if (!ok) {
    summaryLines.push(
      status === "unreachable"
        ? "Restore RPC access, then run the verification again."
        : "Fix the FAIL items above (with their remediation), then run the verification again.",
    );
  }

  return {
    ...base,
    ok,
    status,
    expected,
    observed: input.observed,
    checks,
    mismatches,
    errors,
    summary: summaryLines.join("\n"),
  };
}

// ── On-chain reader ──────────────────────────────────────────────────────────

/** The only network-touching function: read the configured deployment. */
export async function fetchDeploymentSnapshot(
  query: DeploymentFetchQuery,
): Promise<DeploymentSnapshot> {
  const server = new rpc.Server(query.rpcUrl, {
    allowHttp: query.rpcUrl.startsWith("http://"),
  });

  const [network, wasm] = await Promise.all([
    server.getNetwork(),
    server.getContractWasmByContractId(query.contractId),
  ]);

  const client = createRegistryClient({
    contractId: query.contractId,
    rpcUrl: query.rpcUrl,
    networkPassphrase: query.networkPassphrase,
  });

  const [infoTransaction, versionTransaction] = await Promise.all([
    client.registry_info(),
    client.contract_version(),
  ]);
  const info = infoTransaction.result;
  const version = versionTransaction.result;

  return {
    contractId: query.contractId,
    networkPassphrase: network.passphrase,
    networkId: Buffer.from(info.network_id).toString("hex"),
    registryName: info.name,
    crateVersion: version.crate_version,
    resourceSchemaVersion: Number(version.resource_schema_version),
    wasmHash: sha256Hex(wasm),
  };
}

// ── Orchestration ────────────────────────────────────────────────────────────

export interface DeploymentVerificationOptions {
  configured: DeploymentVerificationConfigured;
  /**
   * Expected manifest. When omitted, the default manifest for the configured
   * network is used (canonical testnet only).
   */
  manifest?: unknown;
  mode?: "live" | "mock";
  /** Injectable on-chain reader, for tests and for callers with their own RPC. */
  fetchSnapshot?: (query: DeploymentFetchQuery) => Promise<DeploymentSnapshot>;
}

/** A deterministic snapshot in mock mode, so offline runs do not touch RPC. */
function mockSnapshot(expected: DeploymentManifest): DeploymentSnapshot {
  const passphrase = manifestPassphrase(expected);
  return {
    contractId: expected.contractId,
    networkPassphrase: passphrase,
    networkId: sha256Hex(passphrase),
    registryName: "mindvault-vault-registry",
    crateVersion: expected.crateVersion,
    resourceSchemaVersion: expected.resourceSchemaVersion,
    wasmHash: expected.wasmHash,
  };
}

/**
 * Resolve the expected manifest, read the configured deployment, and return
 * the verification report. Network and RPC failures become report errors, not
 * thrown exceptions, so an agent always gets a readable result.
 */
export async function verifyDeployment(
  options: DeploymentVerificationOptions,
): Promise<DeploymentVerificationReport> {
  const mode = options.mode ?? "live";
  let expected: DeploymentManifest | null = null;
  let manifestErrors: DeploymentVerificationError[] = [];

  if (options.manifest !== undefined && options.manifest !== null) {
    const parsed = parseDeploymentManifest(options.manifest);
    expected = parsed.manifest;
    manifestErrors = parsed.errors;
  } else {
    const network = parseStellarNetwork(options.configured.network);
    expected = network ? DEFAULT_DEPLOYMENT_MANIFESTS[network] : null;
    if (!expected) {
      manifestErrors = [
        {
          code: "manifest_missing",
          message: `No built-in deployment manifest for ${JSON.stringify(options.configured.network)}. Pass an explicit manifest to verify this deployment.`,
        },
      ];
    }
  }

  if (!expected) {
    return buildDeploymentVerificationReport({
      configured: options.configured,
      expected: null,
      observed: null,
      manifestErrors,
      mode,
    });
  }

  if (mode === "mock") {
    return buildDeploymentVerificationReport({
      configured: options.configured,
      expected,
      observed: mockSnapshot(expected),
      mode,
    });
  }

  try {
    const observed = await (options.fetchSnapshot ?? fetchDeploymentSnapshot)({
      contractId: options.configured.contractId,
      rpcUrl: options.configured.rpcUrl,
      networkPassphrase: options.configured.networkPassphrase,
    });
    return buildDeploymentVerificationReport({
      configured: options.configured,
      expected,
      observed,
      mode,
    });
  } catch (error) {
    return buildDeploymentVerificationReport({
      configured: options.configured,
      expected,
      observed: null,
      fetchError: safeErrorMessage(error),
      mode,
    });
  }
}

// ── Tool handler ─────────────────────────────────────────────────────────────

/**
 * Handler for `mindvault_verify_deployment`. Reads the current config from the
 * environment (via `buildConfig`), accepts an optional `manifest` argument,
 * and returns the report as pretty-printed JSON.
 *
 * In mock mode no RPC call is made; the report is built from the expected
 * manifest so offline clients still get a schema-valid answer.
 */
export async function deploymentVerificationTool(
  args: Record<string, unknown>,
): Promise<string> {
  const config = buildConfig(process.env);
  const report = await verifyDeployment({
    configured: {
      network: config.stellarNetwork,
      contractId: config.registryContractId,
      rpcUrl: config.sorobanRpcUrl,
      networkPassphrase: config.registryNetworkPassphrase,
    },
    manifest: args.manifest,
    mode: mockEnabledFromEnv(process.env) ? "mock" : "live",
  });
  return JSON.stringify(report, null, 2);
}
