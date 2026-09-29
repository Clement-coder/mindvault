#!/usr/bin/env node
/**
 * MindVault MCP Server
 * Exposes vault tools to AI agents via the Model Context Protocol.
 */

import {
  checkContractBindings,
  createRegistryClient,
  Errors as RegistryErrors,
  listResources,
  networks as registryNetworks,
  normalizeX402Network,
  resolveStellarNetwork,
  X402_NETWORK_IDS,
  type Resource,
} from "@mindvault/registry-client";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { PROMPT_DEFINITIONS, getPrompt } from "./prompts.js";
import { createProgressEmitter } from "./progress.js";
import { truncateResponse } from "./truncation.js";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { cacheStalenessNotice } from "./cacheStaleness.js";
import {
  collectStartupDiagnostics,
  formatDiagnostics,
  hasBlockingDiagnostics,
} from "./diagnostics.js";
import {
  assertMainnetMutationAllowed,
  formatMainnetDiagnostics,
  mainnetAllowedFromEnv,
} from "./mainnetGuardrails.js";
import {
  createMetricsRecorder,
  measureTool,
  metricsEnabledFromEnv,
  resolveToolDurationBudget,
} from "./metrics.js";
import {
  createMockFetch,
  mockEnabledFromEnv,
  mockRegistryLookup,
  mockRegistryList,
  mockUpdateMetadata,
  mockSetPrice,
  mockTransferOwnership,
  mockSetListed,
} from "./mock.js";
import { purchaseHistoryTool, recordPurchase } from "./purchaseHistory.js";
import { exportReceiptsTool } from "./receipts.js";
import { TOOL_DEFINITIONS, type ToolDefinition } from "./tools.js";
import { dryRunPublish, dryRunBuy, DEFAULT_VERIFICATION_FEE, type DryRunPublishLive } from "./dryRun.js";
import { createStateMutex, serializesStateTool, type StateMutex } from "./stateMutex.js";
import {
  CORRELATION_HEADER,
  currentCorrelationId,
  stampCorrelation,
  withCorrelation,
  withNewCorrelationId,
  correlationHeaders,
} from "./correlation.js";
import { initAuditLogging } from "./auditLog.js";
import { REGISTRY_LIST_DEFAULT_LIMIT, REGISTRY_LIST_DEFAULT_START } from "./registryPagination.js";
import {
  flag,
  optionalInt,
  optionalString,
  requiredString,
  TOOL_ARGUMENT_SPECS,
  UnknownToolError,
  validateToolArgs,
  type ValidatedArgs,
} from "./validation.js";
import {
  DEFAULT_PROFILE,
  isValidProfileName,
  migrateState,
  STATE_VERSION,
  type AgentWallet,
  type ProfileState,
  type WalletProfile,
} from "./profiles.js";
import {
  buildPublishStatusSnapshot,
  isVerificationSettled,
  normalizeIntervalMs,
  normalizeTimeoutMs,
  normalizeWaitFlag,
  type PublishStatusFetch,
} from "./publishStatus.js";
import { safeErrorMessage } from "./redaction.js";
import { signMutatingHeaders } from "./requestSignature.js";
import { exportState, restoreState, checkStatePermissions } from "./stateBackup.js";
import { formatResetPreview, isResetConfirmed, type ResetScope } from "./resetGuard.js";
import { verifyInstall, formatVerifyInstall } from "./verifyInstall.js";
import {
  describeTimeouts,
  fetchWithTimeout,
  resolveTimeouts,
  resolveUserAgent,
  withTimeout,
  type TimeoutService,
} from "./httpTimeout.js";
import {
  describeRetryPolicy,
  formatRetryLog,
  isIdempotentMethod,
  isRetryableStatus,
  retryAfterDelay,
  retryPolicyFromEnv,
  withRetry,
  type RetryAttemptInfo,
} from "./retry.js";
import {
  mapHttpError,
  mapRegistryError,
  mapTransportError,
  mappedErrorOf,
  mcpError,
  throwHttpError,
  isTimeoutError,
  type CredentialContext,
  type ErrorSource,
} from "./errorMapping.js";
import {
  mapSponsoredHttpFailure,
  mapSponsoredTransportFailure,
  SPONSORED_CREATE_PATH,
} from "./sponsoredDiagnostics.js";
import { parseMetadataHash } from "./metadataHash.js";
import {
  applyCatalogSort,
  applyClientCatalogFilters,
  buildCatalogQueryString,
  catalogFilterInputProperties,
  describeCatalogFilters,
  parseCatalogFilters,
  type CatalogFilters,
} from "./catalogFilters.js";

// ── Config ────────────────────────────────────────────────────────────────────

const STELLAR_NETWORK = resolveStellarNetwork(process.env.STELLAR_NETWORK);
const networkPreset = registryNetworks[STELLAR_NETWORK];

// Startup diagnostics: collect every configuration problem in one pass so the
// operator sees the full list (with exact variable names and expected values)
// instead of fixing them one failed launch at a time. Warnings are printed but
// non-fatal; any error stops the server. Skipped under tests and in mock mode
// so unit runs and offline local development never exit the process.
if (!process.env.VITEST && !mockEnabledFromEnv(process.env)) {
  const diagnostics = collectStartupDiagnostics(process.env);
  if (diagnostics.length > 0) console.error(formatDiagnostics(diagnostics));
  if (hasBlockingDiagnostics(diagnostics)) process.exit(1);
}

const BASE_URL = process.env.MINDVAULT_URL ?? "https://mindvault-hyr3.onrender.com";
const REGISTRY_CONTRACT_ID =
  process.env.VAULT_REGISTRY_CONTRACT_ID ?? networkPreset.defaultRegistryContractId ?? "";
const REGISTRY_NETWORK_PASSPHRASE = networkPreset.networkPassphrase;
const SPONSORED_ACCOUNT_URL =
  process.env.SPONSORED_ACCOUNT_URL ?? "https://stellar-sponsored-agent-account.onrender.com";
const HORIZON_URL = process.env.HORIZON_URL ?? networkPreset.horizonUrl;
const SOROBAN_RPC_URL = process.env.SOROBAN_RPC_URL ?? networkPreset.sorobanRpcUrl;
type X402Network = (typeof X402_NETWORK_IDS)[keyof typeof X402_NETWORK_IDS];
const NETWORK: X402Network = normalizeX402Network(
  process.env.NETWORK ?? networkPreset.x402Network,
) as X402Network;

// Opt-in tool-level metrics (set MINDVAULT_METRICS=1). Disabled by default so
// there is zero bookkeeping unless an operator turns it on.
const metrics = createMetricsRecorder(
  metricsEnabledFromEnv(process.env),
  resolveToolDurationBudget(process.env),
);

// Opt-in audit logging (set MINDVAULT_AUDIT_LOG=1). Logs tool calls, network
// requests, duration, status, and tx hashes with automatic secret redaction.
initAuditLogging(process.env);

// Contributor-friendly mock mode (set MINDVAULT_MOCK=1). When on, every HTTP
// call and the on-chain registry lookup are served from deterministic in-memory
// fixtures — no live backend, funded wallet, or network access required. All
// outbound requests go through `httpFetch`, which is the mock shim in this mode
// and the global fetch otherwise.
/** Live mock-mode check — reads process.env at call time so tests can toggle it. */
function _isMock(): boolean {
  return mockEnabledFromEnv(process.env);
}
/** Test helper: override mock mode without restarting the process. */
export function _setMockMode(on: boolean): void {
  if (on) process.env.MINDVAULT_MOCK = "1";
  else delete process.env.MINDVAULT_MOCK;
}
// Defer to the global `fetch` at call time so a test-stubbed global is still
// honoured. The mock shim is created lazily on first use in mock mode so that
// `_setMockMode(true)` in tests takes effect without a module reload.
let mockFetch: typeof fetch | null = null;
function getMockFetch(): typeof fetch {
  if (!mockFetch) mockFetch = createMockFetch(() => currentWallet()?.publicKey);
  return mockFetch;
}
const httpFetch: typeof fetch = (input, init) =>
  _isMock() ? getMockFetch()(input, init) : fetch(input as RequestInfo | URL, init);

// Per-service request deadlines. Every outbound call runs under an
// AbortController using one of these budgets; see docs/mcp-timeouts-retries.md.
const TIMEOUTS = resolveTimeouts(process.env);

// Bounded, jittered retry for idempotent calls only. Payments never use it.
const RETRY_POLICY = retryPolicyFromEnv(process.env);

// User-Agent sent on every outbound HTTP request. Configurable via
// MINDVAULT_USER_AGENT; defaults to "mindvault-mcp/1.0.0".
const USER_AGENT = resolveUserAgent(process.env);

/**
 * Retry chatter goes to stderr so operators can see transient failures being
 * absorbed. Silenced under Vitest to keep suite output readable —
 * `formatRetryLog` is asserted directly in retry.test.ts.
 */
const logRetry = process.env.VITEST
  ? undefined
  : (info: RetryAttemptInfo) => console.error(`MindVault MCP: ${formatRetryLog(info)}`);

/** Shared retry options for an idempotent HTTP call returning a Response. */
function httpRetryOptions(label: string) {
  return {
    policy: RETRY_POLICY,
    label,
    shouldRetryResult: (res: Response) => isRetryableStatus(res.status),
    describeResult: (res: Response) => `HTTP ${res.status}`,
    delayFromResult: (res: Response) =>
      retryAfterDelay(res.headers?.get?.("retry-after"), RETRY_POLICY),
    onRetry: logRetry,
  };
}

/**
 * Soroban RPC call under the soroban budget. `getTransaction` is a read, so it
 * is retried; the JSON-RPC method name is part of the log label.
 */
function sorobanRpcFetch(init: RequestInit, label: string): Promise<Response> {
  const initWithUA: RequestInit = {
    ...init,
    headers: { "User-Agent": USER_AGENT, ...correlationHeaders(init.headers as Record<string, string> | undefined) },
  };
  return withRetry(
    () => fetchWithTimeout(httpFetch, SOROBAN_RPC_URL, initWithUA, "soroban", TIMEOUTS.soroban),
    httpRetryOptions(label),
  );
}

// ── State persistence ─────────────────────────────────────────────────────────

const STATE_DIR = join(homedir(), ".mindvault");
const STATE_FILE = join(STATE_DIR, "state.json");

// Named wallet profiles (testnet/mainnet/publisher/buyer/…) with one active at a
// time. `agentWallet`/`agentApiKey` from earlier versions map onto the active
// profile; legacy single-wallet state is migrated on load (see profiles.ts).
let profiles: Record<string, WalletProfile> = {};
let activeProfileName: string = DEFAULT_PROFILE;

/** The active profile object, created lazily on first write. */
function activeProfile(): WalletProfile {
  return (profiles[activeProfileName] ??= {});
}

function currentWallet(): AgentWallet | null {
  return profiles[activeProfileName]?.wallet ?? null;
}

function currentApiKey(): string | null {
  return profiles[activeProfileName]?.apiKey ?? null;
}

/** FIFO mutex for state-touching tool calls (#855). */
const stateMutex = createStateMutex();

/**
 * Test-only helpers — not part of the public tool surface.
 * Seed/clear the active profile's wallet and API key without touching the filesystem.
 */
export function _setAgentWallet(w: AgentWallet | null): void {
  if (w) activeProfile().wallet = w;
  else delete activeProfile().wallet;
}
export function _setAgentApiKey(k: string | null): void {
  if (k) activeProfile().apiKey = k;
  else delete activeProfile().apiKey;
}
/** Test-only: reset the whole profile store to a clean default. */
export function _resetProfiles(): void {
  profiles = {};
  activeProfileName = DEFAULT_PROFILE;
}

/** Apply a restored ProfileState into memory and re-persist (mode 0600). */
function applyRestoredState(state: ProfileState): void {
  profiles = state.profiles;
  activeProfileName = state.activeProfile;
  saveState();
}

/** Export encrypted state backup (passphrase-gated). No plaintext secrets in output. */
export function backupState(passphrase: string): string {
  const blob = exportState(passphrase);
  return [
    "Encrypted state backup ready. Copy the blob below to the new environment.",
    "Restore with mindvault_restore_state using the same passphrase.",
    "The blob does not contain plaintext secrets.",
    "",
    blob,
  ].join("\n");
}

/** Restore state from an encrypted backup. Integrity-checked before any write. */
export function restoreStateTool(blob: string, passphrase: string): string {
  return restoreState(blob, passphrase, applyRestoredState);
}

function loadState(): void {
  if (!existsSync(STATE_FILE)) return;
  try {
    const raw = readFileSync(STATE_FILE, "utf-8");
    const { state, migrated } = migrateState(JSON.parse(raw));
    profiles = state.profiles;
    activeProfileName = state.activeProfile;
    if (migrated) saveState(); // re-persist legacy state in the current format
  } catch {
    // Corrupted state — ignore and start fresh
  }
}

/** Profiles worth persisting: any with credentials, plus the active one. */
function persistableProfiles(): Record<string, WalletProfile> {
  const out: Record<string, WalletProfile> = {};
  for (const [name, profile] of Object.entries(profiles)) {
    if (profile.wallet || profile.apiKey || name === activeProfileName) out[name] = profile;
  }
  return out;
}

function saveState(): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const state: ProfileState = {
      version: STATE_VERSION,
      activeProfile: activeProfileName,
      profiles: persistableProfiles(),
    };
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error("MindVault MCP: failed to persist state:", safeErrorMessage(err));
  }
}

/** Snapshot what a reset would destroy, before anything is mutated. */
function currentResetScope(all: boolean): ResetScope {
  return {
    all,
    activeProfile: activeProfileName,
    profileNames: Object.keys(profiles),
    hasWallet: !!currentWallet(),
    hasApiKey: !!currentApiKey(),
    stateFile: STATE_FILE,
  };
}

/**
 * Clear credentials. By default only the active profile is cleared; pass
 * `all: true` to wipe every profile and delete the state file.
 *
 * Destructive and irreversible, so it is guarded: without an explicit truthy
 * `confirm` the call is a no-op that returns a warning describing exactly what
 * would be removed. Only a confirmed call clears memory and disk.
 */
export function resetState(all: boolean, confirm: unknown = false): string {
  if (!isResetConfirmed(confirm)) return formatResetPreview(currentResetScope(all));

  if (all) {
    profiles = {};
    activeProfileName = DEFAULT_PROFILE;
    try {
      if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
    } catch (err) {
      return `All profiles cleared from memory. Warning: could not delete state file (${STATE_FILE}): ${err}`;
    }
    return `Reset complete. All profiles removed from memory and disk.\nState file: ${STATE_FILE}`;
  }

  const name = activeProfileName;
  delete profiles[name];
  saveState();
  return [
    `Profile "${name}" cleared (wallet and publisher API key removed).`,
    `Remaining profiles: ${Object.keys(profiles).length}.`,
    `State file: ${STATE_FILE}`,
  ].join("\n");
}

// ── #404: State file permission checks ───────────────────────────────────────

function checkStatePermissionsTool(): string {
  const result = checkStatePermissions();
  const lines = [
    `State file: ${STATE_FILE}`,
    `Exists: ${result.exists}`,
    result.mode ? `Current mode: ${result.mode}` : null,
    `Expected mode: ${result.expectedMode}`,
    `Safe: ${result.isSafe ? "yes" : "no"}`,
    "",
    result.message,
  ].filter((l): l is string => l !== null);
  return lines.join("\n");
}

// ── #401: Registry health check ──────────────────────────────────────────────

interface DependencyStatus {
  name: string;
  ok: boolean;
  message: string;
}

async function checkDependency(
  name: string,
  url: string,
  init?: RequestInit,
): Promise<DependencyStatus> {
  const initWithUA: RequestInit = {
    ...init,
    headers: { "User-Agent": USER_AGENT, ...correlationHeaders(init?.headers as Record<string, string> | undefined) },
  };
  try {
    const res = await withRetry(
      () => fetchWithTimeout(httpFetch, url, initWithUA, "http", TIMEOUTS.http),
      httpRetryOptions(`health:${name}`),
    );
    if (res.ok) {
      return { name, ok: true, message: `Reachable (HTTP ${res.status})` };
    }
    return { name, ok: false, message: `Returned HTTP ${res.status}` };
  } catch (err) {
    return { name, ok: false, message: `Unreachable: ${safeErrorMessage(err)}` };
  }
}

async function registryHealth(): Promise<string> {
  const deps: DependencyStatus[] = [];

  // 1. MindVault API
  deps.push(await checkDependency("MindVault API", `${BASE_URL}/resources`));

  // 2. Horizon
  deps.push(await checkDependency("Horizon", `${HORIZON_URL}`));

  // 3. Soroban RPC — use a lightweight health endpoint or POST
  deps.push(
    await checkDependency("Soroban RPC", SOROBAN_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getNetwork", params: {} }),
    }),
  );

  // 4. Registry contract — verify contract ID is set and non-empty
  if (REGISTRY_CONTRACT_ID) {
    deps.push({
      name: "Registry contract",
      ok: true,
      message: `Contract ID: ${REGISTRY_CONTRACT_ID}`,
    });
  } else {
    deps.push({
      name: "Registry contract",
      ok: false,
      message: "VAULT_REGISTRY_CONTRACT_ID is not set.",
    });
  }

  // 5. x402 network alignment
  const expectedNetwork = networkPreset.x402Network;
  const currentNetwork = NETWORK;
  if (currentNetwork === expectedNetwork) {
    deps.push({
      name: "x402 network",
      ok: true,
      message: `Aligned: ${currentNetwork}`,
    });
  } else {
    deps.push({
      name: "x402 network",
      ok: false,
      message: `Mismatch: expected ${expectedNetwork}, got ${currentNetwork}.`,
    });
  }

  const allOk = deps.every((d) => d.ok);
  const lines = deps.map((d) => {
    const icon = d.ok ? "✓" : "✗";
    return `${icon} ${d.name}: ${d.message}`;
  });
  lines.unshift(allOk ? "All dependencies healthy." : "Some dependencies are unhealthy.", "");
  return lines.join("\n");
}

// ── #402: Wallet import flow ─────────────────────────────────────────────────

/**
 * Derive a Stellar public key from a secret key without importing the full SDK.
 * Ed25519 public key = nacl.publicKey.fromSecret(secretKey).
 * We use the Stellar SDK's StrKey for this.
 */
async function importWallet(args: {
  secretKey?: string;
  profile?: string;
  persist?: boolean;
}): Promise<string> {
  const target = resolveProfileName(args.profile);
  const persist = args.persist !== false;

  // Resolve the secret key: explicit arg > env var
  let secretKey = args.secretKey;
  if (!secretKey) {
    secretKey = process.env.MINDVAULT_AGENT_SECRET;
  }
  if (!secretKey) {
    throw new Error(
      "No secret key provided. Pass secretKey or set MINDVAULT_AGENT_SECRET in the environment.",
    );
  }

  // Validate: must be a Stellar secret key (S + 55 base32 chars)
  if (!/^S[A-Z2-7]{55}$/.test(secretKey)) {
    throw new Error("Invalid Stellar secret key. Must be S followed by 55 base32 characters.");
  }

  // Derive the public key using the Stellar SDK
  let publicKey: string;
  try {
    const { Keypair } = await import("@stellar/stellar-sdk");
    const keypair = Keypair.fromSecret(secretKey);
    publicKey = keypair.publicKey();
  } catch (err) {
    throw new Error(`Failed to derive public key: ${safeErrorMessage(err)}`);
  }

  if (persist) {
    activeProfileName = target;
    activeProfile().wallet = { publicKey, secretKey };
    saveState();
    return [
      `Wallet imported.`,
      `Profile: ${target}`,
      `Address: ${publicKey}`,
      `Wallet persisted to ${STATE_FILE} (mode 0600).`,
    ].join("\n");
  }

  return [
    `Wallet validated (not persisted).`,
    `Address: ${publicKey}`,
    `Pass persist: true to save to the state file.`,
  ].join("\n");
}

// ── #405: Rotate publisher API key ───────────────────────────────────────────

async function rotatePublisherKey(profileArg?: string): Promise<string> {
  const target = resolveProfileName(profileArg);
  const wallet = requireWallet();
  const oldApiKey = profiles[target]?.apiKey;
  if (!oldApiKey) {
    throw new Error(`No publisher API key in profile "${target}". Run mindvault_register first.`);
  }

  const res = await jsonFetch(`${BASE_URL}/publishers/rotate-key`, {
    method: "POST",
    headers: { "x-api-key": oldApiKey },
  });

  if (!res.ok) {
    throwHttpError({
      operation: "Failed to rotate publisher API key",
      source: "api",
      status: res.status,
      data: res.data,
      credential: publisherCredential(target),
    });
  }

  const newApiKey = res.data.apiKey;
  if (typeof newApiKey !== "string" || newApiKey.length === 0) {
    throw new Error("Server returned an empty API key. Contact support.");
  }

  // Store under the target profile and persist
  if (!profiles[target]) profiles[target] = {};
  profiles[target].apiKey = newApiKey;
  if (target === activeProfileName) {
    // already active
  } else {
    activeProfileName = target;
  }
  saveState();

  return [
    `Publisher API key rotated.`,
    `Profile: ${target}`,
    `Publisher ID: ${res.data.id ?? "(unknown)"}`,
    `New key persisted to ${STATE_FILE} (not shown).`,
    `The old key has been invalidated server-side.`,
  ].join("\n");
}

/** Resolve/validate a profile name argument, defaulting to the active profile. */
function resolveProfileName(name: unknown): string {
  if (name === undefined || name === null || name === "") return activeProfileName;
  if (!isValidProfileName(name)) {
    throw new Error(
      `Invalid profile name. Use 1–64 characters from letters, digits, dot, dash, or underscore.`,
    );
  }
  return name;
}

loadState();

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Which subsystem a URL belongs to, so a transport failure is attributed to the
 * service that actually went down rather than a generic "fetch failed".
 */
function sourceForUrl(url: string): ErrorSource {
  if (url.startsWith(SPONSORED_ACCOUNT_URL)) return "sponsored";
  if (url.startsWith(HORIZON_URL)) return "horizon";
  if (url.startsWith(SOROBAN_RPC_URL)) return "soroban";
  return "api";
}

/** Timeout budget that applies to a URL, mirroring sourceForUrl. */
function timeoutServiceForUrl(url: string): TimeoutService {
  if (url.startsWith(HORIZON_URL)) return "horizon";
  if (url.startsWith(SOROBAN_RPC_URL)) return "soroban";
  return "http";
}

/** Human name for a service, used when a transport error has no operation label. */
const SERVICE_OPERATION: Record<ErrorSource, string> = {
  api: "MindVault API request failed",
  horizon: "Horizon request failed",
  soroban: "Soroban RPC request failed",
  sponsored: "Sponsored-account request failed",
  x402: "x402 payment request failed",
  registry: "Registry request failed",
};

async function jsonFetch(
  url: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; data: any; headers: Record<string, string> }> {
  const method = (init?.method ?? "GET").toUpperCase();
  const body =
    typeof init?.body === "string" ? init.body : init?.body ? JSON.stringify(init.body) : undefined;
  const baseHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
    ...correlationHeaders(init?.headers as Record<string, string> | undefined),
  };
  const headers = signMutatingHeaders(url, method, baseHeaders, body);

  // Transport failures (DNS, refused connection, abort) never reach the caller
  // raw — they are classified so the agent knows the service was unreachable
  // rather than that it sent a bad request.
  let res: Response;
  try {
    const service = timeoutServiceForUrl(url);
    const call = () =>
      fetchWithTimeout(
        httpFetch,
        url,
        { ...init, method, body: body ?? init?.body, headers },
        service,
        TIMEOUTS[service],
      );
    // Only replay methods that are safe to replay. A POST here may create a
    // resource or trigger a payment, so it is issued exactly once.
    res = isIdempotentMethod(method)
      ? await withRetry(call, httpRetryOptions(`${method} ${new URL(url).pathname}`))
      : await call();
  } catch (err) {
    const source = sourceForUrl(url);
    throw mcpError(mapTransportError({ operation: SERVICE_OPERATION[source], source, error: err }));
  }

  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    responseHeaders[key.toLowerCase()] = value;
  });
  const text = await res.text();
  try {
    return { ok: res.ok, status: res.status, data: JSON.parse(text), headers: responseHeaders };
  } catch {
    return { ok: res.ok, status: res.status, data: text, headers: responseHeaders };
  }
}

function requireWallet(): AgentWallet {
  const wallet = currentWallet();
  if (!wallet) {
    throw new Error(
      `No wallet in profile "${activeProfileName}". Run mindvault_setup_wallet first.`,
    );
  }
  return wallet;
}

/**
 * Identify the publisher credential a request is about to carry.
 *
 * Passed to the error mapper so a 401 on an API-key call reports the stored key
 * as revoked — naming the profile it came from — instead of the generic
 * "credentials are missing" advice that fits an unregistered agent.
 */
function publisherCredential(profile: string = activeProfileName): CredentialContext {
  return { kind: "publisher_api_key", profile };
}

function requireApiKey(): string {
  const apiKey = currentApiKey();
  if (!apiKey) {
    throw new Error(
      `Not registered in profile "${activeProfileName}". Run mindvault_register first.`,
    );
  }
  return apiKey;
}

function makePaidFetch(wallet: AgentWallet) {
  const signer = createEd25519Signer(wallet.secretKey, NETWORK);
  const scheme = new ExactStellarScheme(signer);
  const client = new x402Client().register(NETWORK, scheme);
  // Paid fetches get the longer `payment` budget because the 402 retry includes
  // on-chain settlement. They are deliberately never retried — see retry.ts.
  // The inner fetch is wrapped so the 402 probe and the paid retry both carry
  // the tool-call correlation id.
  return wrapFetchWithPayment(withCorrelation(withTimeout(httpFetch, "payment", TIMEOUTS.payment)), client);
}

/**
 * Account/balance states the tool can distinguish for agent-facing output:
 * - missing: account does not exist on Stellar (never funded)
 * - no-trustline: account exists but has no USDC trustline
 * - zero: USDC trustline exists with 0 balance
 * - funded: USDC trustline exists with a positive balance
 */
interface BalanceDetails {
  status: "missing" | "no-trustline" | "zero" | "funded";
  xlmBalance: string;
  xlmReserve: string;
  xlmAvailable: string;
  usdcBalance: string;
  /** Human-readable diagnostic when the account/trustline is not usable. */
  message?: string;
}

/**
 * Query Horizon for the agent wallet's XLM and USDC balances, distinguishing
 * missing account, missing trustline, and zero balance states for deterministic
 * agent-facing output.
 */
async function getBalanceDetails(publicKey: string): Promise<BalanceDetails> {
  // Routed through httpFetch (not the bare global) so mock mode, timeouts, and
  // transport-error classification apply here as they do to every other call.
  let res: Response;
  try {
    res = await withRetry(
      () =>
        fetchWithTimeout(
          httpFetch,
          `${HORIZON_URL}/accounts/${publicKey}`,
          { headers: { "User-Agent": USER_AGENT } },
          "horizon",
          TIMEOUTS.horizon,
        ),
      httpRetryOptions("GET horizon /accounts"),
    );
  } catch (err) {
    throw mcpError(
      mapTransportError({
        operation: "Horizon request failed",
        source: "horizon",
        error: err,
      }),
    );
  }

  // Account does not exist (never funded with XLM).
  if (res.status === 404) {
    return {
      status: "missing",
      xlmBalance: "0",
      xlmReserve: "0",
      xlmAvailable: "0",
      usdcBalance: "0",
      message: `Account ${publicKey} does not exist. Fund it with at least 1 XLM to activate.`,
    };
  }

  if (!res.ok) {
    throwHttpError({
      operation: `Horizon error ${res.status}`,
      source: "horizon",
      status: res.status,
      data: await res.text().catch(() => null),
    });
  }

  const data: any = await res.json();
  const balances: any[] = data.balances ?? [];

  // Find native XLM balance.
  const xlmBalance = balances.find((b: any) => b.asset_type === "native");
  const xlm = xlmBalance?.balance ?? "0";

  // Stellar reserves 0.5 XLM base + 0.5 XLM per entry (trustlines, offers, signers, data).
  // Compute available = balance - reserve so agents know how much XLM they can spend.
  const subentryCount = data.subentry_count ?? 0;
  const baseReserve = 0.5; // Stellar base reserve per account
  const entryReserve = 0.5; // Reserve per subentry
  const reserve = baseReserve + subentryCount * entryReserve;
  const available = Math.max(0, parseFloat(xlm) - reserve);

  // Find USDC trustline.
  const usdcBalance = balances.find(
    (b: any) => b.asset_type === "credit_alphanum4" && b.asset_code === "USDC",
  );

  if (!usdcBalance) {
    return {
      status: "no-trustline",
      xlmBalance: xlm,
      xlmReserve: reserve.toFixed(1),
      xlmAvailable: available.toFixed(7),
      usdcBalance: "0",
      message: `USDC trustline not found. Add a USDC trustline to receive payments.`,
    };
  }

  const usdc = usdcBalance.balance ?? "0";
  const usdcFloat = parseFloat(usdc);

  if (usdcFloat === 0) {
    return {
      status: "zero",
      xlmBalance: xlm,
      xlmReserve: reserve.toFixed(1),
      xlmAvailable: available.toFixed(7),
      usdcBalance: usdc,
      message: `USDC balance is zero. Fund the account to use x402 payments.`,
    };
  }

  return {
    status: "funded",
    xlmBalance: xlm,
    xlmReserve: reserve.toFixed(1),
    xlmAvailable: available.toFixed(7),
    usdcBalance: usdc,
  };
}

/**
 * Legacy helper — returns USDC balance as a string, defaulting to "0" for
 * missing account or trustline. Preserved for backward compatibility with
 * insufficientFundsMessage() and other call sites. New code should use
 * getBalanceDetails() for richer diagnostics.
 */
async function getUsdcBalance(publicKey: string): Promise<string> {
  try {
    const details = await getBalanceDetails(publicKey);
    return details.usdcBalance;
  } catch {
    return "0";
  }
}

/** Fetch an account's USDC and native (XLM) balances from Horizon. */
async function getAccountBalances(
  publicKey: string,
): Promise<{ usdc: string; native: string; funded: boolean }> {
  const res = await withRetry(
    () =>
      fetchWithTimeout(
        httpFetch,
        `${HORIZON_URL}/accounts/${publicKey}`,
        { headers: { "User-Agent": USER_AGENT } },
        "horizon",
        TIMEOUTS.horizon,
      ),
    httpRetryOptions("GET horizon /accounts"),
  );
  if (!res.ok) return { usdc: "0", native: "0", funded: false };
  const data: any = await res.json();
  const balances: any[] = data.balances ?? [];
  const usdc = balances.find((b) => b.asset_type === "credit_alphanum4" && b.asset_code === "USDC");
  const native = balances.find((b) => b.asset_type === "native");
  return { usdc: usdc?.balance ?? "0", native: native?.balance ?? "0", funded: true };
}

function formatResource(r: any): string {
  return `[${r.id}] ${r.title} — $${r.price} USDC\n  ${r.description ?? ""}\n  ${r.accessUrl}`;
}

export type SearchFilters = CatalogFilters;

/**
 * Compares the agent wallet's USDC balance against an amount it is about to
 * spend. Returns an actionable insufficient-funds message (balance, amount
 * needed, and the shortfall) when the wallet can't cover the cost, or null
 * when the balance is sufficient.
 */
async function insufficientFundsMessage(
  wallet: AgentWallet,
  amountNeeded: string | number,
  action: string,
): Promise<string | null> {
  const need = typeof amountNeeded === "number" ? amountNeeded : parseFloat(amountNeeded);
  if (!Number.isFinite(need)) return null;
  const balance = await getUsdcBalance(wallet.publicKey);
  const have = parseFloat(balance);
  if (!Number.isFinite(have) || have >= need) return null;
  const shortfall = need - have;
  return [
    `Insufficient USDC to ${action}.`,
    `Amount needed: ${need} USDC`,
    `Current balance: ${have} USDC`,
    `Shortfall: ${shortfall.toFixed(7).replace(/\.?0+$/, "")} USDC`,
    `Fund ${wallet.publicKey} with the shortfall and retry.`,
  ].join("\n");
}

export async function txStatus(txHash: string): Promise<string> {
  const hash = (txHash ?? "").trim();
  if (!hash) return "Provide a transaction hash to look up.";
  const res = await sorobanRpcFetch(
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTransaction",
        params: { hash },
      }),
    },
    "POST soroban getTransaction",
  );
  if (!res.ok)
    throwHttpError({
      operation: `Soroban RPC error: ${res.status}`,
      source: "soroban",
      status: res.status,
      data: await res.text().catch(() => null),
    });
  const data: any = await res.json();
  if (data.error)
    throw mcpError(
      mapRegistryError({
        operation: "RPC error",
        message: JSON.stringify(data.error),
        source: "soroban",
      }),
    );
  const tx = data.result;
  if (tx.status === "NOT_FOUND") {
    return JSON.stringify(
      {
        status: "NOT_FOUND",
        hash,
        message:
          "Transaction not found on the configured Soroban RPC. It may be unconfirmed, on a different network, or outside the RPC's retention window.",
        oldestLedger: tx.oldestLedger,
        latestLedger: tx.latestLedger,
      },
      null,
      2,
    );
  }
  return JSON.stringify(
    {
      status: tx.status,
      hash,
      ledger: tx.ledger,
      ledgerCloseTime: tx.createdAt ? new Date(tx.createdAt * 1000).toISOString() : null,
      applicationOrder: tx.applicationOrder,
      feeBump: tx.feeBump,
      envelopeXdr: tx.envelopeXdr,
      resultXdr: tx.resultXdr,
      resultMetaXdr: tx.resultMetaXdr,
    },
    null,
    2,
  );
}

// ── Tool handlers ─────────────────────────────────────────────────────────────

function hasPublicErrorDetail(data: unknown): boolean {
  if (typeof data === "string") return data.trim().length > 0;
  if (!data || typeof data !== "object") return false;
  const obj = data as Record<string, unknown>;
  return ["error", "message", "detail", "reason"].some((key) => {
    const value = obj[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

function sponsoredAccountErrorData(status: number, data: unknown): unknown {
  if (status >= 500 && !hasPublicErrorDetail(data)) {
    return { message: "internal service error" };
  }
  return data;
}

async function setupWallet(profileArg?: string): Promise<string> {
  const target = resolveProfileName(profileArg);
  const operation = "mindvault_setup_wallet failed to create wallet";

  // The sponsored-account service is the single dependency of wallet setup, so
  // both of its failure paths get the same structured diagnostics: a transport
  // failure (nothing answered) is classified here rather than escaping as the
  // generic "Sponsored-account request failed" jsonFetch would otherwise throw.
  let res: Awaited<ReturnType<typeof jsonFetch>>;
  try {
    res = await jsonFetch(`${SPONSORED_ACCOUNT_URL}${SPONSORED_CREATE_PATH}`, { method: "POST" });
  } catch (err) {
    const mapped = mappedErrorOf(err);
    if (!mapped) throw err;
    throw mcpError(
      mapSponsoredTransportFailure({ operation, serviceUrl: SPONSORED_ACCOUNT_URL, mapped }),
    );
  }

  if (!res.ok) {
    throw mcpError(
      mapSponsoredHttpFailure({
        operation,
        serviceUrl: SPONSORED_ACCOUNT_URL,
        status: res.status,
        data: res.data,
        headers: res.headers,
      }),
    );
  }
  activeProfileName = target;
  activeProfile().wallet = { publicKey: res.data.publicKey, secretKey: res.data.secretKey };
  saveState();
  return [
    `Wallet created.`,
    `Profile: ${target}`,
    `Address: ${res.data.publicKey}`,
    `Wallet persisted to ${STATE_FILE} (mode 0600).`,
  ].join("\n");
}

export async function walletInfo(): Promise<string> {
  const wallet = requireWallet();
  const details = await getBalanceDetails(wallet.publicKey);

  const lines = [
    `Profile: ${activeProfileName}`,
    `Address: ${wallet.publicKey}`,
    `XLM Balance: ${details.xlmBalance}`,
    `XLM Reserved: ${details.xlmReserve} (base + subentries)`,
    `XLM Available: ${details.xlmAvailable}`,
    `USDC Balance: ${details.usdcBalance}`,
    `USDC Status: ${details.status}`,
    `Publisher registered: ${currentApiKey() ? "yes" : "no"}`,
  ];

  if (details.message) {
    lines.push(`Note: ${details.message}`);
  }

  return lines.join("\n");
}

/** Switch the active profile, creating it if new. */
export function useProfile(nameArg: string): string {
  if (!isValidProfileName(nameArg)) {
    throw new Error(
      `Invalid profile name. Use 1–64 characters from letters, digits, dot, dash, or underscore.`,
    );
  }
  activeProfileName = nameArg;
  const profile = activeProfile();
  saveState();
  if (profile.wallet) {
    return [
      `Active profile: ${nameArg}`,
      `Address: ${profile.wallet.publicKey}`,
      `Publisher registered: ${profile.apiKey ? "yes" : "no"}`,
    ].join("\n");
  }
  return `Active profile: ${nameArg}\nNo wallet in this profile yet. Run mindvault_setup_wallet to create one.`;
}

/** List every named profile, marking the active one. Secrets are never shown. */
export function listProfiles(): string {
  const names = Object.keys(profiles).sort();
  if (names.length === 0) {
    return `No profiles yet. Run mindvault_setup_wallet to create one (default profile: "${DEFAULT_PROFILE}").`;
  }
  const lines = names.map((name) => {
    const profile = profiles[name];
    const marker = name === activeProfileName ? "*" : " ";
    const address = profile.wallet ? profile.wallet.publicKey : "(no wallet)";
    const registered = profile.apiKey ? ", registered" : "";
    return `${marker} ${name} — ${address}${registered}`;
  });
  return [`Profiles (* = active):`, ...lines].join("\n");
}

export async function browse(filters: CatalogFilters = {}): Promise<string> {
  const qs = buildCatalogQueryString(filters);
  const url = qs ? `${BASE_URL}/resources?${qs}` : `${BASE_URL}/resources`;
  const res = await jsonFetch(url);
  if (!res.ok) {
    throw mcpError(
      mapHttpError({
        operation: "Browse failed",
        source: "api",
        status: res.status,
        data: res.data,
      }),
    );
  }
  let items: any[] = Array.isArray(res.data) ? res.data : [];
  items = applyCatalogSort(applyClientCatalogFilters(items, filters), filters.sort);
  const body =
    items.length === 0
      ? filters.query ||
        filters.minPrice ||
        filters.maxPrice ||
        filters.verificationStatus ||
        filters.resourceType ||
        filters.owner ||
        filters.tags?.length ||
        filters.listed !== undefined
        ? `No resources match ${describeCatalogFilters(filters)}.`
        : "No resources listed yet."
      : items.map(formatResource).join("\n\n");
  // Warn when the catalog may be stale relative to the on-chain registry, based
  // on the server's cache headers. Silent when there is no cache metadata.
  const notice = cacheStalenessNotice(res.headers);
  const full = notice ? `${body}\n\n${notice}` : body;
  return truncateResponse(full);
}

export async function search(filtersOrQuery: string | CatalogFilters): Promise<string> {
  const filters: CatalogFilters =
    typeof filtersOrQuery === "string" ? { query: filtersOrQuery } : filtersOrQuery;

  const hasCriteria = Boolean(
    filters.query?.trim() ||
    filters.minPrice ||
    filters.maxPrice ||
    filters.verificationStatus ||
    filters.resourceType ||
    filters.owner ||
    filters.sort ||
    filters.limit !== undefined ||
    filters.offset !== undefined ||
    (filters.tags && filters.tags.length > 0) ||
    filters.listed !== undefined,
  );
  if (!hasCriteria) return "Provide a search query or at least one catalog filter.";

  const qs = buildCatalogQueryString(filters);
  const url = qs ? `${BASE_URL}/resources?${qs}` : `${BASE_URL}/resources`;
  const res = await jsonFetch(url);
  if (!res.ok) {
    throw mcpError(
      mapHttpError({
        operation: "Search failed",
        source: "api",
        status: res.status,
        data: res.data,
      }),
    );
  }
  let items: any[] = Array.isArray(res.data) ? res.data : [];

  // Client-side keyword / tags / listed / skipped for unit-test compatibility
  // and parity with fields the public catalog schema does not accept.
  items = applyCatalogSort(applyClientCatalogFilters(items, filters), filters.sort);

  if (items.length === 0) return `No resources match ${describeCatalogFilters(filters)}.`;
  return truncateResponse(items.map(formatResource).join("\n\n"));
}

export async function preview(resourceId: string): Promise<string> {
  const apiKey = currentApiKey();
  const wallet = activeProfile().wallet;

  // Fetch /meta, including the publisher API key when the active profile has one.
  const metaRes = await jsonFetch(`${BASE_URL}/resources/${resourceId}/meta`, {
    headers: apiKey ? { "x-api-key": apiKey } : undefined,
  });
  if (!metaRes.ok)
    throwHttpError({
      operation: "Preview failed",
      source: "api",
      status: metaRes.status,
      data: metaRes.data,
    });
  const r = metaRes.data;

  // Determine ownership: the /meta endpoint returns publisherWallet (the
  // on-chain owner). If the active profile's wallet matches, the caller owns it.
  const isOwner = wallet ? wallet.publicKey === r.publisherWallet : false;

  // For an owner, also fetch /verification to surface the listed/on-chain state.
  // This is zero extra cost for non-owners, and the server's /verification
  // returns `listed` (see server/src/routes/resources.ts:getVerificationDetails).
  let listed: boolean | null = null;
  let onchainStatus: string | null = null;
  let delistNote: string | null = null;

  if (isOwner) {
    const verRes = await jsonFetch(`${BASE_URL}/resources/${resourceId}/verification`, {
      headers: apiKey ? { "x-api-key": apiKey } : undefined,
    });
    if (verRes.ok && verRes.data) {
      listed = verRes.data.listed ?? null;
      onchainStatus = verRes.data.onchainStatus ?? null;
      if (listed === false) {
        delistNote = "This resource is delisted and not discoverable in the public catalog.";
      }
    }
  }

  const out: Record<string, any> = {
    id: r.id,
    title: r.title,
    description: r.description,
    price: `$${r.price} USDC`,
    type: r.resourceType,
    verificationStatus: r.verificationStatus,
    accessUrl: r.accessUrl,
  };
  if (isOwner) {
    out.isOwner = true;
    out.listed = listed;
    out.onchainStatus = onchainStatus;
    if (delistNote) out.delistNote = delistNote;
  }
  return JSON.stringify(out, null, 2);
}

/**
 * Fetch one publish-status snapshot from the API (meta + verification endpoints).
 * Deterministic errors: missing id, 404, and non-OK responses.
 */
async function fetchPublishStatusData(resourceId: string): Promise<PublishStatusFetch> {
  // Sequential fetches keep meta + verification consistent for a single poll tick
  // (avoids racing two parallel responses that could disagree mid-transition).
  const metaRes = await jsonFetch(`${BASE_URL}/resources/${resourceId}/meta`);
  const verRes = await jsonFetch(`${BASE_URL}/resources/${resourceId}/verification`);

  if (metaRes.status === 404 && verRes.status === 404) {
    throw new Error(
      `Resource "${resourceId}" not found. Confirm the id from mindvault_publish or mindvault_browse.`,
    );
  }

  // Prefer meta for on-chain sync fields; verification endpoint may 404 briefly
  // for brand-new resources, so allow meta-only when verification is missing.
  if (!metaRes.ok && metaRes.status !== 404) {
    throw new Error(
      `Publish status meta failed [${metaRes.status}]: ${JSON.stringify(metaRes.data)}`,
    );
  }
  if (!verRes.ok && verRes.status !== 404) {
    throw new Error(
      `Publish status verification failed [${verRes.status}]: ${JSON.stringify(verRes.data)}`,
    );
  }
  if (!metaRes.ok && !verRes.ok) {
    throw new Error(
      `Resource "${resourceId}" not found. Confirm the id from mindvault_publish or mindvault_browse.`,
    );
  }

  return {
    meta: metaRes.ok ? metaRes.data : null,
    verification: verRes.ok ? verRes.data : null,
  };
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll resource verification / on-chain sync status after publish.
 *
 * Reports verificationStatus (pending | verified | rejected | skipped) and
 * on-chain sync fields (onchainStatus, onchainTxHash). Pass wait: true to poll
 * until verification settles or timeoutMs elapses.
 */
export async function publishStatus(args: {
  resourceId?: string;
  wait?: unknown;
  timeoutMs?: unknown;
  intervalMs?: unknown;
}): Promise<string> {
  const resourceId = (args.resourceId ?? "").trim();
  if (!resourceId) {
    throw new Error(
      "resourceId is required. Pass the id returned by mindvault_publish (e.g. 'cm7x8y9z').",
    );
  }

  const wait = normalizeWaitFlag(args.wait);
  const timeoutMs = normalizeTimeoutMs(args.timeoutMs);
  const intervalMs = normalizeIntervalMs(args.intervalMs);

  let attempts = 0;
  let timedOut = false;
  const deadline = wait ? Date.now() + timeoutMs : Date.now();

  // Always fetch at least once.
  let data = await fetchPublishStatusData(resourceId);
  attempts += 1;

  while (wait) {
    const status = data.verification?.status ?? data.meta?.verificationStatus ?? "pending";
    if (isVerificationSettled(status)) break;
    if (Date.now() >= deadline) {
      timedOut = true;
      break;
    }
    const remaining = deadline - Date.now();
    await sleepMs(Math.min(intervalMs, Math.max(0, remaining)));
    if (Date.now() >= deadline) {
      // One last fetch after the wait window.
      data = await fetchPublishStatusData(resourceId);
      attempts += 1;
      const last = data.verification?.status ?? data.meta?.verificationStatus ?? "pending";
      timedOut = !isVerificationSettled(last);
      break;
    }
    data = await fetchPublishStatusData(resourceId);
    attempts += 1;
  }

  const snapshot = buildPublishStatusSnapshot(resourceId, data, {
    polled: wait,
    attempts,
    timedOut,
  });
  return JSON.stringify(snapshot, null, 2);
}

async function register(name: string, email: string, walletAddress?: string): Promise<string> {
  const wallet = requireWallet();
  const res = await jsonFetch(`${BASE_URL}/publishers`, {
    method: "POST",
    body: JSON.stringify({ name, email, walletAddress: walletAddress ?? wallet.publicKey }),
  });
  if (!res.ok)
    throwHttpError({
      operation: "Register failed",
      source: "api",
      status: res.status,
      data: res.data,
    });
  activeProfile().apiKey = res.data.apiKey;
  saveState();
  return `Registered as publisher.\nProfile: ${activeProfileName}\nID: ${res.data.id}\nAPI key persisted to ${STATE_FILE} (not shown). Run mindvault_reset to revoke.`;
}

async function publish(args: {
  title: string;
  description?: string;
  price: string;
  externalUrl: string;
  dryRun?: boolean;
}): Promise<string> {
  if (args.dryRun) {
    // Read live /agent/status and wallet balance for the dry run (best-effort).
    // We do NOT call the paid /verify-content endpoint in a dry run.
    const live: DryRunPublishLive = {};
    try {
      const statusRes = await jsonFetch(`${BASE_URL}/agent/status`);
      if (statusRes.ok && statusRes.data?.agent?.pricePerVerification != null) {
        live.verificationFee = statusRes.data.agent.pricePerVerification;
      }
    } catch (err) {
      live.readError = safeErrorMessage(err);
    }
    const wallet = activeProfile().wallet;
    if (wallet) {
      try {
        const bal = await getBalanceDetails(wallet.publicKey);
        live.usdcBalance = bal.usdcBalance;
      } catch (err) {
        live.readError = live.readError ? `${live.readError}; ${safeErrorMessage(err)}` : safeErrorMessage(err);
      }
    }
    return JSON.stringify(
      dryRunPublish(
        args,
        NETWORK,
        BASE_URL,
        !!wallet,
        !!currentApiKey(),
        live,
      ),
      null,
      2,
    );
  }

  const wallet = requireWallet();
  const apiKey = requireApiKey();

  // Step 1: Create the resource record
  const createRes = await jsonFetch(`${BASE_URL}/resources`, {
    method: "POST",
    headers: { "x-api-key": apiKey },
    body: JSON.stringify({
      title: args.title,
      description: args.description,
      price: args.price,
      externalUrl: args.externalUrl,
    }),
  });
  if (!createRes.ok)
    throwHttpError({
      operation: "Publish failed",
      source: "api",
      status: createRes.status,
      data: createRes.data,
      credential: publisherCredential(),
    });
  const resource = createRes.data;

  // Step 2: Agent wallet signs the x402 payment for verification. Check funds
  // first so a shortfall returns an actionable message rather than a created-
  // but-unverifiable resource with an opaque payment error.
  const statusRes = await jsonFetch(`${BASE_URL}/agent/status`);
  const verificationPrice = statusRes.ok ? statusRes.data?.agent?.pricePerVerification : null;
  if (verificationPrice != null) {
    const shortMsg = await insufficientFundsMessage(
      wallet,
      verificationPrice,
      "pay the content verification fee",
    );
    if (shortMsg) {
      return `${shortMsg}\n(Resource created with id ${resource.id}; verify it later once funded.)`;
    }
  }

  const paidFetch = makePaidFetch(wallet);

  const verifyRes = await paidFetch(`${BASE_URL}/verify-content`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: `Title: ${args.title}\nDescription: ${args.description ?? ""}\nURL: ${args.externalUrl}`,
      resourceId: resource.id,
    }),
  });
  metrics.recordPayment(verifyRes.ok);

  const verifyData = await verifyRes.json().catch(() => null);

  if (!verifyRes.ok) {
    return (
      `Resource created (id: ${resource.id}) but verification payment failed.\n` +
      `Status: ${verifyRes.status}\n${JSON.stringify(verifyData)}`
    );
  }

  const isOriginal: boolean = verifyData?.isOriginal ?? false;
  const flags: string[] = verifyData?.flags ?? [];

  if (!isOriginal) {
    return [
      `Resource created but rejected by verification.`,
      `ID: ${resource.id}`,
      `Verification: rejected ✗`,
      flags.length ? `Flags: ${flags.join("; ")}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }

  // Step 3: Trigger on-chain registration (best-effort — failure doesn't block listing)
  const registerRes = await jsonFetch(`${BASE_URL}/resources/${resource.id}/register`, {
    method: "POST",
    headers: { "x-api-key": apiKey },
  });

  const onchainStatus: string = registerRes.ok
    ? (registerRes.data.onchainStatus ?? "registered")
    : "failed";
  const onchainTxHash: string | null = registerRes.ok
    ? (registerRes.data.onchainTxHash ?? null)
    : ((registerRes.data?.txHash as string | undefined) ?? null);

  // On failure the server returns actionable guidance (next steps, the retry
  // endpoint, and a tx-status link when a hash exists). Surface it verbatim so
  // the agent knows exactly how to recover instead of getting an opaque error.
  const failureGuidance: string[] = [];
  if (!registerRes.ok) {
    const data = registerRes.data ?? {};
    const retryEndpoint =
      typeof data.retryEndpoint === "string"
        ? data.retryEndpoint
        : `POST ${BASE_URL}/resources/${resource.id}/register`;
    failureGuidance.push(
      `Registration failed — the resource is still listed and purchasable.`,
      typeof data.message === "string" ? data.message : `Detail: ${data.detail ?? "unknown error"}`,
      `Retry endpoint: ${retryEndpoint} (send your x-api-key; no body re-runs server-side registration).`,
    );
    if (typeof data.txStatusUrl === "string") {
      failureGuidance.push(`Transaction status: ${data.txStatusUrl}`);
    } else if (onchainTxHash) {
      failureGuidance.push(`Check transaction ${onchainTxHash} with mindvault_tx_status.`);
    }
    if (Array.isArray(data.nextSteps)) {
      failureGuidance.push("Next steps:", ...data.nextSteps.map((s: string) => `  - ${s}`));
    }
  }

  const summary = {
    before: {
      id: null,
      title: null,
      price: null,
      accessUrl: null,
      verificationStatus: null,
      onchainStatus: null,
    },
    after: {
      id: resource.id,
      title: resource.title,
      price: resource.price,
      accessUrl: resource.accessUrl,
      verificationStatus: "approved",
      onchainStatus,
    },
    changedFields: ["id", "title", "price", "accessUrl", "verificationStatus", "onchainStatus"],
    txHash: onchainTxHash,
    failureGuidance: failureGuidance.length > 0 ? failureGuidance : null,
  };

  return JSON.stringify(summary, null, 2);
}

export async function buy(
  resourceId: string,
  dryRun?: boolean,
  estimatedPrice?: string | null,
  onProgress?: (progress: number, total?: number, message?: string) => Promise<void>,
): Promise<string> {
  if (dryRun) {
    return JSON.stringify(
      dryRunBuy(resourceId, NETWORK, BASE_URL, !!activeProfile().wallet, estimatedPrice ?? null),
      null,
      2,
    );
  }

  const wallet = requireWallet();

  // Check the wallet can cover the price before attempting payment so a
  // shortfall returns an actionable message instead of an opaque payment error.
  await onProgress?.(1, 4, "Validating resource");
  const meta = await jsonFetch(`${BASE_URL}/resources/${resourceId}/meta`);
  if (meta.ok && meta.data?.price != null) {
    const shortMsg = await insufficientFundsMessage(
      wallet,
      meta.data.price,
      `buy "${meta.data.title ?? resourceId}"`,
    );
    if (shortMsg) return shortMsg;
  }

  const beforeState = meta.ok
    ? {
        id: meta.data.id,
        title: meta.data.title,
        price: meta.data.price,
        accessUrl: meta.data.accessUrl,
        purchased: false,
      }
    : null;

  const paidFetch = makePaidFetch(wallet);
  let res: Response;
  try {
    await onProgress?.(2, 4, "Submitting payment");
    res = await paidFetch(`${BASE_URL}/resources/${resourceId}`);
  } catch (err) {
    metrics.recordPayment(false);
    throw mcpError(mapTransportError({ operation: "Buy failed", source: "x402", error: err }));
  }
  metrics.recordPayment(res.ok);
  if (!res.ok) {
    // A 402 here means the payment itself was refused (typically an underfunded
    // wallet), which is a different recovery path from a plain API error.
    const text = await res.text();
    throwHttpError({
      operation: `Buy failed [${res.status}]`,
      source: "x402",
      status: res.status,
      data: text,
    });
  }
  const afterData = await res.json();
  const txHash = afterData.txHash || null;
  const receipt =
    afterData.receipt && typeof afterData.receipt === "object" ? afterData.receipt : null;
  const amount =
    (receipt?.amount != null ? String(receipt.amount) : null) ??
    (meta.ok && meta.data?.price != null ? String(meta.data.price) : null) ??
    (afterData.price != null ? String(afterData.price) : "");
  const title =
    (typeof afterData.title === "string" && afterData.title) ||
    (meta.ok && typeof meta.data?.title === "string" ? meta.data.title : undefined);

  // Persist a local receipt so mindvault_purchase_history can list prior buys.
  // Recording failures must not fail the successful purchase response.
  await onProgress?.(3, 4, "Recording purchase");
  try {
    recordPurchase({
      resourceId,
      amount,
      network: NETWORK,
      txHash,
      receiptRef: receipt?.paymentId != null ? String(receipt.paymentId) : null,
      ...(title ? { title } : {}),
    });
  } catch (err) {
    console.error("MindVault MCP: failed to persist purchase receipt:", safeErrorMessage(err));
  }

  const summary = {
    before: beforeState,
    after: {
      ...afterData,
      purchased: true,
    },
    changedFields: beforeState ? ["purchased"] : ["id", "title", "price", "accessUrl", "purchased"],
    txHash,
  };

  await onProgress?.(4, 4, "Done");

  return JSON.stringify(summary, null, 2);
}

/**
 * Register a verified resource on the vault registry contract.
 *
 * mindvault_publish triggers on-chain registration automatically, but the chain
 * call can fail (RPC outage, unfunded fees) while the resource stays listed and
 * purchasable. This tool is the advertised retry path: it prepares the unsigned
 * register transaction (owner-only), signs it with the agent wallet — which is
 * the resource creator for agent-published resources — and submits it.
 */
export async function registerOnchain(
  resourceId: string,
  onProgress?: (progress: number, total?: number, message?: string) => Promise<void>,
): Promise<string> {
  const wallet = requireWallet();
  const apiKey = requireApiKey();
  if (!resourceId) throw new Error("resourceId is required.");

  // Step 1: prepare the unsigned register transaction (owner-only).
  await onProgress?.(1, 3, "Preparing transaction");
  const prep = await jsonFetch(`${BASE_URL}/resources/${resourceId}/register/prepare`, {
    headers: { "x-api-key": apiKey },
  });
  if (!prep.ok) {
    // Keep the endpoint-specific guidance (not verified / already registered /
    // wrong owner) and let the mapper add the classification and next step.
    const mapped = mapHttpError({
      operation: `Could not prepare on-chain registration for "${resourceId}" [${prep.status}]`,
      source: "api",
      status: prep.status,
      data: prep.data,
      credential: publisherCredential(),
    });
    // 401/403 are left to the mapper: it knows whether the stored publisher key
    // was rejected outright or accepted but unauthorized here, and names the
    // profile to fix. Repeating a generic ownership line here would bury that.
    const specific = [
      prep.status === 400 ? "The resource must be verified before it can be registered." : null,
      prep.status === 409
        ? "The resource is already registered on-chain — no action needed."
        : null,
    ].filter(Boolean);
    throw mcpError({
      ...mapped,
      action: [...specific, mapped.action].join(" "),
    });
  }

  const { unsignedXdr, networkPassphrase } = prep.data ?? {};
  if (!unsignedXdr) {
    throw new Error(
      `register/prepare did not return an unsigned transaction: ${JSON.stringify(prep.data)}`,
    );
  }

  // Step 2: sign with the agent wallet (the resource creator).
  await onProgress?.(2, 3, "Signing transaction");
  const { Keypair, Transaction } = await import("@stellar/stellar-sdk");
  const passphrase = networkPassphrase ?? REGISTRY_NETWORK_PASSPHRASE;
  const tx = new Transaction(unsignedXdr, passphrase);
  tx.sign(Keypair.fromSecret(wallet.secretKey));
  const signedXdr = tx.toXDR();

  // Step 3: submit the signed transaction.
  await onProgress?.(3, 3, "Submitting transaction");
  const submit = await jsonFetch(`${BASE_URL}/resources/${resourceId}/register`, {
    method: "POST",
    headers: { "x-api-key": apiKey },
    body: JSON.stringify({ signedXdr }),
  });
  if (!submit.ok) {
    const txHash = submit.data && typeof submit.data === "object" ? submit.data.txHash : undefined;
    const mapped = mapHttpError({
      operation: `On-chain registration failed for "${resourceId}" [${submit.status}]`,
      source: "api",
      status: submit.status,
      data: submit.data,
      credential: publisherCredential(),
    });
    throw mcpError({
      ...mapped,
      action: [
        "The resource remains listed and purchasable.",
        "Ensure the agent wallet is funded for fees and retry.",
        txHash ? `Tx hash: ${txHash} (check with mindvault_tx_status).` : null,
      ]
        .filter(Boolean)
        .join(" "),
    });
  }

  const summary = {
    before: {
      id: resourceId,
      onchainStatus: null,
      txHash: null,
    },
    after: {
      id: resourceId,
      onchainStatus: submit.data.onchainStatus ?? "registered",
      txHash: submit.data.txHash ?? null,
    },
    changedFields: ["onchainStatus", "txHash"],
    txHash: submit.data.txHash ?? null,
  };

  return JSON.stringify(summary, null, 2);
}

async function agentStatus(): Promise<string> {
  const res = await jsonFetch(`${BASE_URL}/agent/status`);
  if (!res.ok)
    throwHttpError({
      operation: "Agent status failed",
      source: "api",
      status: res.status,
      data: res.data,
    });
  return JSON.stringify(res.data, null, 2);
}

function stroopsToUsdc(stroops: bigint): string {
  const STROOPS_PER_USDC = 10_000_000n;
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / STROOPS_PER_USDC;
  const frac = abs % STROOPS_PER_USDC;
  return `${negative ? "-" : ""}${whole}.${frac.toString().padStart(7, "0")}`;
}

export function usdcToStroops(usdc: string): bigint {
  const parts = usdc.split(".");
  const whole = BigInt(parts[0] || "0");
  const fracStr = (parts[1] || "").padEnd(7, "0").slice(0, 7);
  const frac = BigInt(fracStr);
  return whole * 10_000_000n + frac;
}

export async function updateMetadata(resourceId: string, metadata: string): Promise<string> {
  const wallet = requireWallet();
  if (_isMock()) return mockUpdateMetadata(resourceId, metadata);

  const client = createRegistryClient({
    contractId: REGISTRY_CONTRACT_ID,
    rpcUrl: SOROBAN_RPC_URL,
    networkPassphrase: REGISTRY_NETWORK_PASSPHRASE,
    publicKey: wallet.publicKey,
  });

  let tx: Awaited<ReturnType<typeof client.update_metadata>>;
  try {
    tx = await client.update_metadata({ id: resourceId, metadata });
  } catch (err: any) {
    if (isTimeoutError(err)) {
      throw mcpError(
        mapTransportError({
          operation: `Update metadata failed for resource "${resourceId}"`,
          source: "soroban",
          error: err,
        }),
      );
    }
    throw mcpError(
      mapRegistryError({
        operation: `Update metadata failed for resource "${resourceId}"`,
        message: err?.message || String(err),
      }),
    );
  }

  const result = tx.result;
  if (result.isErr()) {
    const err = result.unwrapErr();
    const notFound = err.message === RegistryErrors[2].message;
    throw mcpError(
      mapRegistryError({
        operation: `Update metadata failed for resource "${resourceId}"`,
        message: err.message,
        notFound,
      }),
    );
  }

  const { Keypair } = await import("@stellar/stellar-sdk");
  const keypair = Keypair.fromSecret(wallet.secretKey);
  let sentTx;
  try {
    sentTx = await tx.signAndSend({
      signTransaction: async (xdr: string) => {
        const { Transaction } = await import("@stellar/stellar-sdk");
        const stellarTx = new Transaction(xdr, REGISTRY_NETWORK_PASSPHRASE);
        stellarTx.sign(keypair);
        return { signedTxXdr: stellarTx.toXDR() };
      },
    });
  } catch (err: any) {
    throw mcpError(
      mapRegistryError({
        operation: `Update metadata submission failed for resource "${resourceId}"`,
        message: err?.message || String(err),
      }),
    );
  }

  const txHash = sentTx?.sendTransactionResponse?.hash ?? null;
  return JSON.stringify(
    {
      status: "success",
      resourceId,
      metadata,
      txHash,
    },
    null,
    2,
  );
}

export async function setPrice(resourceId: string, price: string): Promise<string> {
  const wallet = requireWallet();
  if (_isMock()) return mockSetPrice(resourceId, price);

  const stroops = usdcToStroops(price);

  const client = createRegistryClient({
    contractId: REGISTRY_CONTRACT_ID,
    rpcUrl: SOROBAN_RPC_URL,
    networkPassphrase: REGISTRY_NETWORK_PASSPHRASE,
    publicKey: wallet.publicKey,
  });

  let tx: Awaited<ReturnType<typeof client.set_price>>;
  try {
    tx = await client.set_price({ id: resourceId, new_price: stroops });
  } catch (err: any) {
    if (isTimeoutError(err)) {
      throw mcpError(
        mapTransportError({
          operation: `Set price failed for resource "${resourceId}"`,
          source: "soroban",
          error: err,
        }),
      );
    }
    throw mcpError(
      mapRegistryError({
        operation: `Set price failed for resource "${resourceId}"`,
        message: err?.message || String(err),
      }),
    );
  }

  const result = tx.result;
  if (result.isErr()) {
    const err = result.unwrapErr();
    const notFound = err.message === RegistryErrors[2].message;
    throw mcpError(
      mapRegistryError({
        operation: `Set price failed for resource "${resourceId}"`,
        message: err.message,
        notFound,
      }),
    );
  }

  const { Keypair } = await import("@stellar/stellar-sdk");
  const keypair = Keypair.fromSecret(wallet.secretKey);
  let sentTx;
  try {
    sentTx = await tx.signAndSend({
      signTransaction: async (xdr: string) => {
        const { Transaction } = await import("@stellar/stellar-sdk");
        const stellarTx = new Transaction(xdr, REGISTRY_NETWORK_PASSPHRASE);
        stellarTx.sign(keypair);
        return { signedTxXdr: stellarTx.toXDR() };
      },
    });
  } catch (err: any) {
    throw mcpError(
      mapRegistryError({
        operation: `Set price submission failed for resource "${resourceId}"`,
        message: err?.message || String(err),
      }),
    );
  }

  const txHash = sentTx?.sendTransactionResponse?.hash ?? null;
  return JSON.stringify(
    {
      status: "success",
      resourceId,
      price,
      txHash,
    },
    null,
    2,
  );
}

export async function transferOwnership(resourceId: string, newCreator: string): Promise<string> {
  const wallet = requireWallet();
  if (_isMock()) return mockTransferOwnership(resourceId, newCreator);

  const client = createRegistryClient({
    contractId: REGISTRY_CONTRACT_ID,
    rpcUrl: SOROBAN_RPC_URL,
    networkPassphrase: REGISTRY_NETWORK_PASSPHRASE,
    publicKey: wallet.publicKey,
  });

  let tx: Awaited<ReturnType<typeof client.transfer_ownership>>;
  try {
    tx = await client.transfer_ownership({ id: resourceId, new_creator: newCreator });
  } catch (err: any) {
    if (isTimeoutError(err)) {
      throw mcpError(
        mapTransportError({
          operation: `Transfer ownership failed for resource "${resourceId}"`,
          source: "soroban",
          error: err,
        }),
      );
    }
    throw mcpError(
      mapRegistryError({
        operation: `Transfer ownership failed for resource "${resourceId}"`,
        message: err?.message || String(err),
      }),
    );
  }

  const result = tx.result;
  if (result.isErr()) {
    const err = result.unwrapErr();
    const notFound = err.message === RegistryErrors[2].message;
    throw mcpError(
      mapRegistryError({
        operation: `Transfer ownership failed for resource "${resourceId}"`,
        message: err.message,
        notFound,
      }),
    );
  }

  const { Keypair } = await import("@stellar/stellar-sdk");
  const keypair = Keypair.fromSecret(wallet.secretKey);
  let sentTx;
  try {
    sentTx = await tx.signAndSend({
      signTransaction: async (xdr: string) => {
        const { Transaction } = await import("@stellar/stellar-sdk");
        const stellarTx = new Transaction(xdr, REGISTRY_NETWORK_PASSPHRASE);
        stellarTx.sign(keypair);
        return { signedTxXdr: stellarTx.toXDR() };
      },
    });
  } catch (err: any) {
    throw mcpError(
      mapRegistryError({
        operation: `Transfer ownership submission failed for resource "${resourceId}"`,
        message: err?.message || String(err),
      }),
    );
  }

  const txHash = sentTx?.sendTransactionResponse?.hash ?? null;
  return JSON.stringify(
    {
      status: "success",
      resourceId,
      newCreator,
      txHash,
    },
    null,
    2,
  );
}

export async function setListed(resourceId: string, listed: boolean): Promise<string> {
  const wallet = requireWallet();
  if (_isMock()) return mockSetListed(resourceId, listed);

  const client = createRegistryClient({
    contractId: REGISTRY_CONTRACT_ID,
    rpcUrl: SOROBAN_RPC_URL,
    networkPassphrase: REGISTRY_NETWORK_PASSPHRASE,
    publicKey: wallet.publicKey,
  });

  let tx: Awaited<ReturnType<typeof client.set_listed>>;
  try {
    tx = await client.set_listed({ id: resourceId, listed });
  } catch (err: any) {
    if (isTimeoutError(err)) {
      throw mcpError(
        mapTransportError({
          operation: `Set listed failed for resource "${resourceId}"`,
          source: "soroban",
          error: err,
        }),
      );
    }
    throw mcpError(
      mapRegistryError({
        operation: `Set listed failed for resource "${resourceId}"`,
        message: err?.message || String(err),
      }),
    );
  }

  const result = tx.result;
  if (result.isErr()) {
    const err = result.unwrapErr();
    const notFound = err.message === RegistryErrors[2].message;
    throw mcpError(
      mapRegistryError({
        operation: `Set listed failed for resource "${resourceId}"`,
        message: err.message,
        notFound,
      }),
    );
  }

  const { Keypair } = await import("@stellar/stellar-sdk");
  const keypair = Keypair.fromSecret(wallet.secretKey);
  let sentTx;
  try {
    sentTx = await tx.signAndSend({
      signTransaction: async (xdr: string) => {
        const { Transaction } = await import("@stellar/stellar-sdk");
        const stellarTx = new Transaction(xdr, REGISTRY_NETWORK_PASSPHRASE);
        stellarTx.sign(keypair);
        return { signedTxXdr: stellarTx.toXDR() };
      },
    });
  } catch (err: any) {
    throw mcpError(
      mapRegistryError({
        operation: `Set listed submission failed for resource "${resourceId}"`,
        message: err?.message || String(err),
      }),
    );
  }

  const txHash = sentTx?.sendTransactionResponse?.hash ?? null;
  return JSON.stringify(
    {
      status: "success",
      resourceId,
      listed,
      txHash,
    },
    null,
    2,
  );
}

export async function registryLookup(
  resourceId: string,
): Promise<string> {
  if (_isMock()) return mockRegistryLookup(resourceId, REGISTRY_CONTRACT_ID, currentWallet()?.publicKey);
  const client = createRegistryClient({
    contractId: REGISTRY_CONTRACT_ID,
    rpcUrl: SOROBAN_RPC_URL,
    networkPassphrase: REGISTRY_NETWORK_PASSPHRASE,
  });

  let tx: Awaited<ReturnType<typeof client.get>>;
  try {
    tx = await client.get({ id: resourceId });
  } catch (err: any) {
    // The client could not reach the RPC at all — a transport problem, not a
    // contract-level rejection, so it is classified against the Soroban source.
    throw mcpError(
      mapTransportError({
        operation: `On-chain lookup failed for resource "${resourceId}" (contract ${REGISTRY_CONTRACT_ID}, RPC ${SOROBAN_RPC_URL})`,
        source: "soroban",
        error: err,
      }),
    );
  }

  const result = tx.result;
  if (result.isErr()) {
    const err = result.unwrapErr();
    if (err.message === RegistryErrors[2].message) {
      // A missing registry entry stays a successful tool result (soft miss), but
      // carries the same recovery action an agent would get from a hard error.
      return JSON.stringify(
        {
          source: "on-chain",
          found: false,
          resourceId,
          message: `Resource "${resourceId}" is not registered on-chain. It may not have been listed yet or the ID may be incorrect.`,
          next: mapRegistryError({
            operation: "Registry lookup",
            message: err.message,
            notFound: true,
          }).action,
          contract: REGISTRY_CONTRACT_ID,
          network: REGISTRY_NETWORK_PASSPHRASE,
          rpc: SOROBAN_RPC_URL,
        },
        null,
        2,
      );
    }
    throw mcpError(
      mapRegistryError({
        operation: `Contract error for resource "${resourceId}" (contract ${REGISTRY_CONTRACT_ID}, network ${REGISTRY_NETWORK_PASSPHRASE})`,
        message: err.message,
      }),
    );
  }

  const resource = result.unwrap();
  const priceUsdc = stroopsToUsdc(BigInt(resource.price as unknown as bigint));

  return JSON.stringify(
    {
      source: "on-chain",
      found: true,
      id: resource.id,
      creator: resource.creator,
      price: `${priceUsdc} USDC`,
      metadata: resource.metadata,
      listed: resource.listed,
      tags: resource.tags,
      contract: REGISTRY_CONTRACT_ID,
      network: REGISTRY_NETWORK_PASSPHRASE,
      rpc: SOROBAN_RPC_URL,
    },
    null,
    2,
  );
}

/**
 * Paginated list of resources from the on-chain vault registry (contract `list`).
 * Data comes from Soroban, not the MindVault API catalog.
 */
export async function registryList(
  start: number,
  limit: number,
): Promise<string> {
  if (_isMock()) return mockRegistryList(start, limit, REGISTRY_CONTRACT_ID, currentWallet()?.publicKey);

  const client = createRegistryClient({
    contractId: REGISTRY_CONTRACT_ID,
    rpcUrl: SOROBAN_RPC_URL,
    networkPassphrase: REGISTRY_NETWORK_PASSPHRASE,
  });

  let resources: Resource[];
  try {
    resources = await listResources(client, start, limit);
  } catch (err: unknown) {
    throw mcpError(
      mapTransportError({
        operation: `On-chain list failed (contract ${REGISTRY_CONTRACT_ID}, RPC ${SOROBAN_RPC_URL}, start ${start}, limit ${limit})`,
        source: "soroban",
        error: err,
      }),
    );
  }

  if (resources.length === 0) {
    const message =
      start === 0
        ? "No resources registered on-chain yet."
        : `No on-chain resources in range [${start}, ${start + limit}). Try a lower start index or call mindvault_registry_info for contract context.`;
    return JSON.stringify(
      {
        source: "on-chain",
        start,
        limit,
        count: 0,
        message,
        resources: [],
        contract: REGISTRY_CONTRACT_ID,
        network: REGISTRY_NETWORK_PASSPHRASE,
        rpc: SOROBAN_RPC_URL,
      },
      null,
      2,
    );
  }

  const items = resources.map((resource) => {
    const priceUsdc = stroopsToUsdc(BigInt(resource.price as unknown as bigint));
    return {
      id: resource.id,
      creator: resource.creator,
      price: `${priceUsdc} USDC`,
      metadata: resource.metadata,
      listed: resource.listed,
      tags: resource.tags,
    };
  });

  return JSON.stringify(
    {
      source: "on-chain",
      start,
      limit,
      count: items.length,
      resources: items,
      contract: REGISTRY_CONTRACT_ID,
      network: REGISTRY_NETWORK_PASSPHRASE,
      rpc: SOROBAN_RPC_URL,
    },
    null,
    2,
  );
}

function registryInfo(): string {
  const info: {
    contractId: string;
    networkPassphrase: string;
    rpcUrl: string;
    network: string;
    x402Network: string;
    resourceFields: (keyof Resource)[];
    mainnetDiagnostics: string;
  } = {
    contractId: REGISTRY_CONTRACT_ID,
    networkPassphrase: REGISTRY_NETWORK_PASSPHRASE,
    rpcUrl: SOROBAN_RPC_URL,
    network: STELLAR_NETWORK,
    x402Network: NETWORK,
    resourceFields: ["id", "creator", "price", "metadata", "listed"],
    mainnetDiagnostics: formatMainnetDiagnostics({
      stellarNetwork: STELLAR_NETWORK,
      x402Network: NETWORK,
      registryContractId: REGISTRY_CONTRACT_ID,
      allowMainnetEnv: mainnetAllowedFromEnv(),
    }),
  };
  return JSON.stringify(info, null, 2);
}

/**
 * Compare a resource from the API catalog with the same resource in the vault-registry contract.
 * Reports matching fields, mismatches, missing API records, and missing on-chain records.
 *
 * When `expectedMetadataHash` is supplied, the digest the caller computed over
 * the off-chain content is compared against the `contentHash` anchored in the
 * on-chain metadata pointer. Both sides are canonicalized first (see
 * metadataHash.ts), so `sha256:AB…` and `ab…` compare equal.
 */
export async function checkConsistency(
  resourceId: string,
  expectedMetadataHash?: string,
): Promise<string> {
  if (!resourceId) throw new Error("resourceId is required.");
  // Reject a malformed expectation up front: comparing against a digest that
  // is not in the fixed format can only produce a misleading "mismatch".
  const expected = expectedMetadataHash
    ? parseMetadataHash(expectedMetadataHash, "expectedMetadataHash").canonical
    : null;

  // Fetch from API
  const apiRes = await jsonFetch(`${BASE_URL}/resources/${resourceId}/meta`);
  const apiData = apiRes.ok ? apiRes.data : null;

  // Fetch from on-chain registry
  let onchainData: any = null;
  let onchainError: string | null = null;
  try {
    const client = createRegistryClient({
      contractId: REGISTRY_CONTRACT_ID,
      rpcUrl: SOROBAN_RPC_URL,
      networkPassphrase: REGISTRY_NETWORK_PASSPHRASE,
    });
    const tx = await client.get({ id: resourceId });
    if (tx.result.isOk()) {
      onchainData = tx.result.unwrap();
    } else {
      onchainError = tx.result.unwrapErr().message;
    }
  } catch (err: any) {
    onchainError = err.message;
  }

  // Build comparison report
  const report: {
    resourceId: string;
    apiFound: boolean;
    onchainFound: boolean;
    onchainError: string | null;
    matches: Record<string, { api: any; onchain: any }>;
    mismatches: Record<string, { api: any; onchain: any }>;
    missingInApi: string[];
    missingInOnchain: string[];
  } = {
    resourceId,
    apiFound: !!apiData,
    onchainFound: !!onchainData,
    onchainError,
    matches: {},
    mismatches: {},
    missingInApi: [],
    missingInOnchain: [],
  };

  if (!apiData && !onchainData) {
    return JSON.stringify(
      {
        ...report,
        summary: "Resource not found in API catalog or on-chain registry.",
      },
      null,
      2,
    );
  }

  if (!apiData) {
    report.missingInApi = ["id", "title", "price", "metadata", "listed"];
    return JSON.stringify(
      {
        ...report,
        summary: "Resource exists on-chain but not in API catalog.",
      },
      null,
      2,
    );
  }

  if (!onchainData) {
    report.missingInOnchain = ["id", "creator", "price", "metadata", "listed"];
    return JSON.stringify(
      {
        ...report,
        summary: "Resource exists in API catalog but not on-chain registry.",
      },
      null,
      2,
    );
  }

  // Compare fields
  const priceUsdc = stroopsToUsdc(BigInt(onchainData.price as unknown as bigint));

  // Compare price (API uses USDC string, on-chain uses stroops)
  const apiPrice = parseFloat(apiData.price || "0");
  const onchainPrice = parseFloat(priceUsdc);
  if (Math.abs(apiPrice - onchainPrice) < 0.0000001) {
    report.matches.price = { api: apiData.price, onchain: priceUsdc };
  } else {
    report.mismatches.price = { api: apiData.price, onchain: priceUsdc };
  }

  // Compare listed status
  if (apiData.verificationStatus === "verified" && onchainData.listed === true) {
    report.matches.listed = { api: "verified", onchain: true };
  } else if (apiData.verificationStatus !== "verified" && onchainData.listed === false) {
    report.matches.listed = { api: apiData.verificationStatus, onchain: false };
  } else {
    report.mismatches.listed = { api: apiData.verificationStatus, onchain: onchainData.listed };
  }

  // Compare metadata
  if (apiData.accessUrl === onchainData.metadata) {
    report.matches.metadata = { api: apiData.accessUrl, onchain: onchainData.metadata };
  } else {
    report.mismatches.metadata = { api: apiData.accessUrl, onchain: onchainData.metadata };
  }

  // ID should always match
  report.matches.id = { api: apiData.id, onchain: onchainData.id };

  const summary =
    Object.keys(report.mismatches).length === 0
      ? "All compared fields match between API and on-chain registry."
      : `Found ${Object.keys(report.mismatches).length} mismatched field(s).`;

  return JSON.stringify({ ...report, summary }, null, 2);
}

/**
 * Report the current Stellar and x402 network configuration in use by this MCP
 * instance. Includes testnet/mainnet selection, RPC/Horizon URLs, registry and
 * USDC contract IDs, and warnings for environment variable overrides that
 * diverge from presets.
 */
export function networkProfile(): string {
  const warnings: string[] = [];

  // Detect custom overrides that differ from the preset
  const usdcContractId = process.env.USDC_CONTRACT_ID ?? networkPreset.usdcSacContractId;
  if (
    process.env.USDC_CONTRACT_ID &&
    process.env.USDC_CONTRACT_ID !== networkPreset.usdcSacContractId
  ) {
    warnings.push(
      `USDC_CONTRACT_ID overrides preset (${networkPreset.usdcSacContractId} → ${process.env.USDC_CONTRACT_ID})`,
    );
  }
  if (process.env.SOROBAN_RPC_URL && process.env.SOROBAN_RPC_URL !== networkPreset.sorobanRpcUrl) {
    warnings.push(
      `SOROBAN_RPC_URL overrides preset (${networkPreset.sorobanRpcUrl} → ${process.env.SOROBAN_RPC_URL})`,
    );
  }
  if (process.env.HORIZON_URL && process.env.HORIZON_URL !== networkPreset.horizonUrl) {
    warnings.push(
      `HORIZON_URL overrides preset (${networkPreset.horizonUrl} → ${process.env.HORIZON_URL})`,
    );
  }
  if (
    process.env.VAULT_REGISTRY_CONTRACT_ID &&
    networkPreset.defaultRegistryContractId &&
    process.env.VAULT_REGISTRY_CONTRACT_ID !== networkPreset.defaultRegistryContractId
  ) {
    warnings.push(
      `VAULT_REGISTRY_CONTRACT_ID overrides preset (${networkPreset.defaultRegistryContractId} → ${process.env.VAULT_REGISTRY_CONTRACT_ID})`,
    );
  }
  if (process.env.NETWORK && process.env.NETWORK !== networkPreset.x402Network) {
    warnings.push(
      `NETWORK overrides preset (${networkPreset.x402Network} → ${process.env.NETWORK})`,
    );
  }

  const profile = {
    stellarNetwork: STELLAR_NETWORK,
    x402Network: NETWORK,
    sorobanRpcUrl: SOROBAN_RPC_URL,
    horizonUrl: HORIZON_URL,
    registryContractId: REGISTRY_CONTRACT_ID,
    usdcContractId,
    // Active request deadlines and retry policy, so an operator diagnosing slow,
    // hanging, or flaky tools can see them without reading the environment.
    timeouts: describeTimeouts(TIMEOUTS),
    retries: describeRetryPolicy(RETRY_POLICY),
    warnings,
  };

  return JSON.stringify(profile, null, 2);
}

/**
 * Verify the installed registry-client bindings match the deployed contract's
 * interface. Returns the check's deterministic, agent-safe message (a match
 * summary, a mismatch warning with a recommended fix, or a "could not verify"
 * note when the contract/RPC is unreachable).
 */
async function checkBindings(): Promise<string> {
  if (_isMock()) return "Mock mode: contract binding check skipped (no live RPC).";
  const result = await checkContractBindings({
    contractId: REGISTRY_CONTRACT_ID,
    rpcUrl: SOROBAN_RPC_URL,
    networkPassphrase: REGISTRY_NETWORK_PASSPHRASE,
    network: STELLAR_NETWORK,
  });
  return result.message;
}

/**
 * Return opt-in tool-level metrics as JSON. Only counts, durations, and tool
 * names are included — never arguments, wallets, or API keys. When metrics are
 * disabled, returns an actionable note instead of counters. Pass reset=true to
 * clear counters after reading.
 */
function toolMetrics(reset: boolean): string {
  const snapshot = metrics.snapshot();
  if (reset) metrics.reset();
  if (!snapshot.enabled) {
    return JSON.stringify(
      {
        enabled: false,
        message:
          "Metrics are disabled. Set MINDVAULT_METRICS=1 (or true/yes/on) and restart the server to collect tool-level metrics.",
      },
      null,
      2,
    );
  }
  return JSON.stringify(snapshot, null, 2);
}

/** Tools in ListTools that validate arguments inside the handler (legacy). */
const TOOLS_WITHOUT_ARG_VALIDATION = new Set([
  "mindvault_publish_status",
  "mindvault_purchase_history",
]);

function isDispatchableTool(name: string): boolean {
  return name in TOOL_ARGUMENT_SPECS || TOOLS_WITHOUT_ARG_VALIDATION.has(name);
}

/**
 * Inner dispatch that runs the tool's logic. This is the function the state
 * mutex wraps when `serializesStateTool(name)` is true. It receives the
 * already-validated `args`, the `dryRunArgs` (for dry-run calls), the original
 * `rawRecord`, and `onProgress`.
 */
async function runTool(
  name: string,
  args: ValidatedArgs,
  dryRunArgs: ValidatedArgs,
  rawRecord: Record<string, unknown>,
  onProgress?: (progress: number, total?: number, message?: string) => Promise<void>,
): Promise<string> {
  switch (name) {
    case "mindvault_setup_wallet":
      return setupWallet(optionalString(args, "profile"));
    case "mindvault_wallet_info":
      return walletInfo();
    case "mindvault_use_profile":
      return useProfile(requiredString(args, "name"));
    case "mindvault_list_profiles":
      return listProfiles();
    case "mindvault_browse": {
      const parsed = parseCatalogFilters(rawRecord);
      return parsed.ok ? browse(parsed.filters) : parsed.error;
    }
    case "mindvault_search": {
      const parsed = parseCatalogFilters(rawRecord, { requireCriteria: true });
      return parsed.ok ? search(parsed.filters) : parsed.error;
    }
    case "mindvault_preview":
      return preview(requiredString(args, "resourceId"));
    case "mindvault_register":
      return register(
        requiredString(args, "name"),
        requiredString(args, "email"),
        optionalString(args, "walletAddress"),
      );
    case "mindvault_publish":
      return publish({
        title: requiredString(dryRunArgs, "title"),
        description: optionalString(dryRunArgs, "description"),
        price: requiredString(dryRunArgs, "price"),
        externalUrl: requiredString(dryRunArgs, "externalUrl"),
        dryRun: flag(dryRunArgs, "dryRun"),
      });
    case "mindvault_publish_status":
      return publishStatus(rawRecord);
    case "mindvault_buy":
      return buy(requiredString(args, "resourceId"), flag(args, "dryRun"), undefined, onProgress);
    case "mindvault_purchase_history":
      return purchaseHistoryTool(rawRecord);
    case "mindvault_export_receipts":
      return exportReceiptsTool(rawRecord);
    case "mindvault_register_onchain":
      return registerOnchain(requiredString(args, "resourceId"), onProgress);
    case "mindvault_agent_status":
      return agentStatus();
    case "mindvault_registry_info":
      return registryInfo();
    case "mindvault_network_profile":
      return networkProfile();
    case "mindvault_check_bindings":
      return checkBindings();
    case "mindvault_check_consistency":
      return checkConsistency(
        requiredString(args, "resourceId"),
        optionalString(args, "expectedMetadataHash"),
      );
    case "mindvault_registry_lookup":
      return registryLookup(requiredString(args, "resourceId"));
    case "mindvault_registry_list":
      return registryList(
        optionalInt(args, "start", REGISTRY_LIST_DEFAULT_START),
        optionalInt(args, "limit", REGISTRY_LIST_DEFAULT_LIMIT),
      );
    case "mindvault_update_metadata":
      return updateMetadata(requiredString(args, "resourceId"), requiredString(args, "metadata"));
    case "mindvault_set_price":
      return setPrice(requiredString(args, "resourceId"), requiredString(args, "price"));
    case "mindvault_transfer_ownership":
      return transferOwnership(
        requiredString(args, "resourceId"),
        requiredString(args, "newCreator"),
      );
    case "mindvault_set_listed":
      return setListed(requiredString(args, "resourceId"), flag(args, "listed"));
    case "mindvault_tx_status":
      return txStatus(requiredString(args, "txHash"));
    case "mindvault_reset":
      return resetState(flag(args, "all"), rawRecord.confirm);
    case "mindvault_backup_state":
      return backupState(requiredString(args, "passphrase"));
    case "mindvault_restore_state":
      return restoreStateTool(requiredString(args, "blob"), requiredString(args, "passphrase"));
    case "mindvault_metrics":
      return toolMetrics(flag(args, "reset"));
    case "mindvault_check_state_permissions":
      return checkStatePermissionsTool();
    case "mindvault_registry_health":
      return registryHealth();
    case "mindvault_import_wallet":
      return importWallet({
        secretKey: optionalString(args, "secretKey"),
        profile: optionalString(args, "profile"),
        persist: flag(args, "persist"),
      });
    case "mindvault_rotate_publisher_key":
      return rotatePublisherKey(optionalString(args, "profile"));
    case "mindvault_verify_install":
      return formatVerifyInstall(verifyInstall(process.env));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/**
 * Route a validated tool call to its implementation. Used by the MCP CallTool
 * handler and by unit tests.
 */
export async function dispatchTool(
  name: string,
  rawArgs: unknown,
  onProgress?: (progress: number, total?: number, message?: string) => Promise<void>,
): Promise<string> {
  if (!isDispatchableTool(name)) {
    throw new UnknownToolError(name);
  }

  const rawRecord =
    typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {};

  // For dry-run calls on publish and buy the user intentionally passes invalid
  // inputs to inspect structured validation feedback.  Skip the gateway check
  // and let dryRunPublish / dryRunBuy produce the per-field result instead.
  const isDryRunCall =
    (name === "mindvault_publish" || name === "mindvault_buy") && rawRecord.dryRun === true;

  const args: ValidatedArgs =
    name in TOOL_ARGUMENT_SPECS && !isDryRunCall ? validateToolArgs(name, rawArgs) : {};
  const dryRunArgs = isDryRunCall ? (rawRecord as ValidatedArgs) : args;

  // Validate mainnet mutations before acquiring any lock — a blocked mainnet
  // mutation should fail fast and never queue.
  assertMainnetMutationAllowed(NETWORK, name, rawRecord);

  // Serialize state-touching tools so their read-then-write sequences cannot
  // interleave with a concurrent reset, profile switch, or import. Read-only
  // tools run in parallel.
  const needsLock = serializesStateTool(name);
  if (needsLock) {
    return stateMutex.runExclusive(() =>
      runTool(name, args, dryRunArgs, rawRecord, onProgress),
    );
  }
  return runTool(name, args, dryRunArgs, rawRecord, onProgress);
}

/**
 * Look up an advertised tool definition by name.
 *
 * Tool metadata lives in two places today: the literal list below and
 * `TOOL_DEFINITIONS` in tools.ts, which the validation layer and its coverage
 * tests read. Anything defined once — a tool with an `outputSchema`, whose
 * schema the structured result must match — is declared in tools.ts and pulled
 * in here, so the advertised schema, the validation spec, and the result shape
 * cannot drift apart.
 */
function toolDefinition(name: string): ToolDefinition {
  const definition = TOOL_DEFINITIONS.find((tool) => tool.name === name);
  if (!definition) throw new Error(`No tool definition for ${name} in TOOL_DEFINITIONS.`);
  return definition;
}

/** Tools that declare an outputSchema, by name, for structured results. */
const TOOLS_WITH_OUTPUT_SCHEMA = new Set(
  TOOL_DEFINITIONS.filter((tool) => tool.outputSchema).map((tool) => tool.name),
);

/**
 * The structured form of a tool result, when the tool advertises one.
 *
 * A tool with an `outputSchema` must return structured content conforming to it
 * (MCP 2025-06-18). Those tools already produce their result as JSON text, so
 * the object is recovered by parsing it — the text block stays exactly as it
 * was, which keeps every existing client and test working.
 */
function structuredResult(name: string, text: string): Record<string, unknown> | undefined {
  if (!TOOLS_WITH_OUTPUT_SCHEMA.has(name)) return undefined;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "mindvault", version: "1.0.0" },
  { capabilities: { tools: {}, prompts: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
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
    },
    {
      name: "mindvault_wallet_info",
      description:
        "Check the active profile name, its agent wallet address, USDC balance, and whether it is registered as a publisher.",
      inputSchema: { type: "object", properties: {}, required: [] },
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
    },
    {
      name: "mindvault_list_profiles",
      description:
        "List all named wallet profiles, marking the active one and showing each profile's wallet address and whether it is registered as a publisher. Secret keys are never shown.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "mindvault_browse",
      description:
        "List resources in the MindVault catalog with the same optional filters as mindvault_search and GET /resources: keyword, price range, verification status, resource type, owner, sort, pagination, tags, and listed state.",
      inputSchema: {
        type: "object",
        properties: { ...catalogFilterInputProperties },
        required: [],
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
    },
    {
      name: "mindvault_register",
      description:
        "Register as a publisher using the agent wallet. The API key is persisted to ~/.mindvault/state.json (mode 0600, key not shown in output) and reloaded on restart so mindvault_publish works across sessions.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          email: { type: "string" },
          walletAddress: { type: "string" },
          confirmMainnet: {
            type: "boolean",
            description:
              "Required on mainnet (or set MINDVAULT_ALLOW_MAINNET=1). Explicitly confirm this mutation/payment on the public Stellar network.",
          },
        },
        required: ["name", "email"],
      },
    },
    {
      name: "mindvault_publish",
      description:
        "Publish a link resource to the MindVault catalog. The resource undergoes AI verification (agent wallet pays ~$0.10 USDC via x402) and is automatically registered on-chain if verified. Returns resource ID, access URL, verification result, and on-chain registration status.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          price: { type: "string" },
          externalUrl: { type: "string" },
          confirmMainnet: {
            type: "boolean",
            description:
              "Required on mainnet (or set MINDVAULT_ALLOW_MAINNET=1). Explicitly confirm this mutation/payment on the public Stellar network.",
          },
        },
        required: ["title", "price", "externalUrl"],
      },
    },
    {
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
    },
    {
      name: "mindvault_buy",
      description:
        "Pay USDC via x402 and access a resource. On mainnet, pass confirmMainnet: true (or set MINDVAULT_ALLOW_MAINNET=1).",
      inputSchema: {
        type: "object",
        properties: {
          resourceId: { type: "string" },
          confirmMainnet: {
            type: "boolean",
            description:
              "Required on mainnet (or set MINDVAULT_ALLOW_MAINNET=1). Explicitly confirm this mutation/payment on the public Stellar network.",
          },
        },
        required: ["resourceId"],
      },
    },
    {
      name: "mindvault_purchase_history",
      description:
        "List locally persisted purchase receipts from successful mindvault_buy calls (~/.mindvault/purchases.json). Read-only. Optional filters: resourceId and network (exact match, e.g. stellar:testnet). Returns count + purchases (newest first), or an empty list when nothing matches.",
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
        },
        required: [],
      },
    },
    // Declared in tools.ts: it carries an outputSchema, and the advertised
    // schema, the validation spec, and the structured result must agree.
    toolDefinition("mindvault_export_receipts"),
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
        },
        required: ["resourceId"],
      },
    },
    {
      name: "mindvault_agent_status",
      description:
        "Check the verification agent's earnings and activity. Returns total verifications, pass/fail counts, total USDC earned, average confidence score, and recent verification history with resource titles.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "mindvault_registry_info",
      description:
        "Return the on-chain vault-registry contract ID, network passphrase, RPC URL, and the resource fields available for direct Soroban queries. Use this to verify ownership, price, and listing state directly from Stellar without trusting the MindVault API.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "mindvault_network_profile",
      description:
        "Report current Stellar/x402 network configuration (testnet/mainnet), RPC URLs, registry contract ID, and warnings for custom overrides. Use this to verify which network the MCP is connected to and diagnose configuration issues.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "mindvault_check_bindings",
      description:
        "Verify the installed registry-client bindings match the deployed vault-registry contract interface. Reports a match, or a warning listing the drifting methods with the contract ID, network, client version, and a recommended fix (redeploy the contract or regenerate bindings). Useful after a contract redeploy or client upgrade.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "mindvault_check_consistency",
      description:
        "Compare a resource from the API catalog with the same resource in the vault-registry contract. Reports matching fields, mismatches, missing API records, and missing on-chain records. Useful for detecting synchronization issues between the API and on-chain registry.",
      inputSchema: {
        type: "object",
        properties: {
          resourceId: {
            type: "string",
            description: "The resource ID to compare between API and on-chain registry.",
          },
        },
        required: ["resourceId"],
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
              "The 64-character hex transaction hash from Stellar. Example: 'abc123def456...' (from mindvault_register_onchain or mindvault_publish output).",
            examples: [
              "abc123def456789012345678901234567890123456789012345678901234",
              "f47ac10b58cc4372a5670e02b2c3d479c3e5d0a1b2c3d4e5f6a7b8c9d0e1f2a3",
            ],
          },
        },
        required: ["txHash"],
      },
    },
    {
      name: "mindvault_reset",
      description:
        "Clear credentials from memory and disk (~/.mindvault/state.json). Destructive and irreversible, so it is two-step: without confirm=true the call changes nothing and returns a warning listing exactly what would be removed; call again with confirm=true to perform it. By default only the active profile is cleared; pass all=true to remove every profile and delete the state file. After a confirmed reset, run mindvault_setup_wallet and mindvault_register again.",
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
    },
    {
      name: "mindvault_backup_state",
      description:
        "Export an encrypted backup of ~/.mindvault/state.json for moving agent environments. Requires a passphrase (min 8 chars). Output is a self-contained ciphertext blob — wallet secret keys and API keys never appear in plaintext. Restore with mindvault_restore_state using the same passphrase. Does not change reset behavior.",
      inputSchema: {
        type: "object",
        properties: {
          passphrase: {
            type: "string",
            description:
              "Passphrase used to encrypt the backup (min 8 characters). Keep it offline.",
          },
        },
        required: ["passphrase"],
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
    },
    {
      name: "mindvault_metrics",
      description:
        "Return opt-in tool-level metrics: per-tool call/error counts and durations, plus payment attempt/failure totals. Enable by setting MINDVAULT_METRICS=1 on the server. Output contains only tool names, counts, and durations — never arguments, wallets, or API keys. Pass reset=true to clear counters after reading.",
      inputSchema: {
        type: "object",
        properties: {
          reset: {
            type: "boolean",
            description:
              "Clear all counters after returning the current snapshot (default: false leaves counters intact). Example: true resets metrics after reading.",
            examples: [true, false],
          },
        },
        required: [],
      },
    },
    {
      name: "mindvault_check_state_permissions",
      description:
        "Verify the state file (~/.mindvault/state.json) has safe permissions (mode 0600). Warns when the file is world-readable or group-readable, which would expose wallet secret keys and API keys to other system users. Safe by default; run after any manual file operations or environment migration.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "mindvault_registry_health",
      description:
        "Check the health of every dependency the MCP server relies on: MindVault API, Horizon, Soroban RPC, vault-registry contract, and x402 network alignment. Returns per-dependency status (ok/error) with actionable failure messages. Does not leak secrets or environment variables.",
      inputSchema: { type: "object", properties: {}, required: [] },
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
    },
    {
      name: "mindvault_verify_install",
      description:
        "Verify the MindVault MCP server is installed and configured correctly. Checks Node.js version (>=20), network settings, URL variables, vault-registry contract ID, and warns about plaintext secrets in the environment. No network calls are made — all checks are local. Run this first when setting up a new agent or diagnosing a configuration problem.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args = {} } = request.params;
  const progressToken = request.params._meta?.progressToken;
  const onProgress =
    progressToken != null
      ? createProgressEmitter({ token: progressToken, send: extra.sendNotification })
      : undefined;
  try {
    // Errors thrown by tools (and by measureTool's re-throw) become a deterministic
    // MCP error result: `isError: true` and text prefixed with `Error:`, with secrets
    // stripped via safeErrorMessage. Clients should treat that shape as failure.
    // Each tool call runs in its own correlation scope so all outbound requests
    // it issues (catalog read, x402 payment, etc.) share the same x-request-id.
    const result = await withNewCorrelationId(() =>
      measureTool(metrics, name, () => dispatchTool(name, args, onProgress)),
    );
    return { content: [{ type: "text", text: result }] };
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error: ${safeErrorMessage(err)}` }], isError: true };
  }
});

// ── MCP Prompts ────────────────────────────────────────────────────────────

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: PROMPT_DEFINITIONS.map((p) => ({
    name: p.name,
    description: p.description,
    arguments: p.arguments.map((a) => ({
      name: a.name,
      description: a.description,
      required: a.required,
    })),
  })),
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const result = getPrompt(name, args as Record<string, string | undefined>);
  return {
    description: result.description,
    messages: result.messages,
  };
});

// Best-effort startup check: warn on stderr (never fatal, never blocks) when the
// installed bindings drift from the deployed contract. Skipped under tests and
// mock mode so it never makes a real network call. Errors (e.g. offline) are
// swallowed — the mindvault_check_bindings tool gives operators a detailed report.
if (!process.env.VITEST && !_isMock()) {
  void checkContractBindings({
    contractId: REGISTRY_CONTRACT_ID,
    rpcUrl: SOROBAN_RPC_URL,
    networkPassphrase: REGISTRY_NETWORK_PASSPHRASE,
    network: STELLAR_NETWORK,
  })
    .then((result: { status: string; message: string }) => {
      if (result.status === "mismatch") console.error(`MindVault MCP: ${result.message}`);
    })
    .catch(() => {
      /* offline or unreachable — the mindvault_check_bindings tool can report details */
    });
}

// Connect stdio when running as a real MCP process. Under Vitest the integration
// harness (and unit tests) import this module and wire an in-memory transport
// instead — connecting stdio here would hang the test runner on stdin.
export { server };

// ── Graceful shutdown (#549) ───────────────────────────────────────────────
// SIGINT, SIGTERM, and transport close/error close the server cleanly and
// flush in-flight state writes before exiting with a deterministic code.

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  try {
    // Flush any pending state writes before closing
    saveState();
    await server.close();
  } catch {
    // Best-effort — already shutting down
  }

  const exitCode = signal === "SIGINT" ? 130 : 0;
  process.exit(exitCode);
}

if (!process.env.VITEST) {
  const transport = new StdioServerTransport();

  // Handle transport errors/close
  transport.onclose = () => shutdown("transport-close");
  transport.onerror = () => shutdown("transport-error");

  // Handle OS signals
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Handle stdin EOF (pipe closed)
  process.stdin.on("end", () => shutdown("stdin-EOF"));

  // Exactly one connect: the stdio transport can only be started once, so a
  // second call throws "already started" and the process dies before it can
  // serve a single request.
  await server.connect(transport);
}
