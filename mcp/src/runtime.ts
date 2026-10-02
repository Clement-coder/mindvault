import {
  networks as registryNetworks,
  normalizeX402Network,
  resolveStellarNetwork,
  X402_NETWORK_IDS,
} from "@mindvault/registry-client";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import {
  createMetricsRecorder,
  metricsEnabledFromEnv,
  resolveToolDurationBudget,
} from "./metrics.js";
import { createMockFetch, mockEnabledFromEnv } from "./mock.js";
import { initAuditLogging } from "./auditLog.js";
import { safeErrorMessage } from "./redaction.js";
import { signMutatingHeaders } from "./requestSignature.js";
import { type ResetScope } from "./resetGuard.js";
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
  fetchWithTimeout,
  resolveTimeouts,
  resolveUserAgent,
  withTimeout,
  type TimeoutService,
} from "./httpTimeout.js";
import { writeAtomically } from "./stateBackup.js";
import {
  formatRetryLog,
  isIdempotentMethod,
  isRetryableStatus,
  retryAfterDelay,
  retryPolicyFromEnv,
  withRetry,
  type RetryAttemptInfo,
} from "./retry.js";
import {
  mapTransportError,
  mcpError,
  type CredentialContext,
  type ErrorSource,
} from "./errorMapping.js";

const STELLAR_NETWORK = resolveStellarNetwork(process.env.STELLAR_NETWORK);
const networkPreset = registryNetworks[STELLAR_NETWORK];

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

const metrics = createMetricsRecorder(
  metricsEnabledFromEnv(process.env),
  resolveToolDurationBudget(process.env),
);

initAuditLogging(process.env);

const MOCK = mockEnabledFromEnv(process.env);

function _isMock(): boolean {
  return mockEnabledFromEnv(process.env);
}

export function _setMockMode(on: boolean): void {
  if (on) process.env.MINDVAULT_MOCK = "1";
  else delete process.env.MINDVAULT_MOCK;
}

function resolveAgentSecret(provided?: string): string | undefined {
  return provided ?? process.env.MINDVAULT_AGENT_SECRET;
}

const httpFetch: typeof fetch = MOCK
  ? createMockFetch(() => currentWallet()?.publicKey)
  : (input, init) => fetch(input as RequestInfo | URL, init);

const TIMEOUTS = resolveTimeouts(process.env);
const RETRY_POLICY = retryPolicyFromEnv(process.env);
const USER_AGENT = resolveUserAgent(process.env);

const logRetry = process.env.VITEST
  ? undefined
  : (info: RetryAttemptInfo) => console.error(`MindVault MCP: ${formatRetryLog(info)}`);

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

function sorobanRpcFetch(init: RequestInit, label: string): Promise<Response> {
  const initWithUA: RequestInit = {
    ...init,
    headers: { "User-Agent": USER_AGENT, ...(init.headers as Record<string, string> | undefined) },
  };
  return withRetry(
    () => fetchWithTimeout(httpFetch, SOROBAN_RPC_URL, initWithUA, "soroban", TIMEOUTS.soroban),
    httpRetryOptions(label),
  );
}

let STATE_DIR = "";
let STATE_FILE = "";

function configureStatePaths(stateDir: string, stateFile: string): void {
  STATE_DIR = stateDir;
  STATE_FILE = stateFile;
}

let profiles: Record<string, WalletProfile> = {};
let activeProfileName: string = DEFAULT_PROFILE;

function activeProfile(): WalletProfile {
  return (profiles[activeProfileName] ??= {});
}

function currentWallet(): AgentWallet | null {
  return profiles[activeProfileName]?.wallet ?? null;
}

function currentApiKey(): string | null {
  return profiles[activeProfileName]?.apiKey ?? null;
}

function resolveProfileName(name: unknown): string {
  if (name === undefined || name === null || name === "") return activeProfileName;
  if (!isValidProfileName(name)) {
    throw new Error(
      `Invalid profile name. Use 1–64 characters from letters, digits, dot, dash, or underscore.`,
    );
  }
  return name;
}

export function _setAgentWallet(w: AgentWallet | null): void {
  if (w) {
    activeProfile().wallet = w;
    activeProfile().network ??= NETWORK;
  }
  else delete activeProfile().wallet;
}
export function _setAgentApiKey(k: string | null): void {
  if (k) activeProfile().apiKey = k;
  else delete activeProfile().apiKey;
}
export function _resetProfiles(): void {
  profiles = {};
  activeProfileName = DEFAULT_PROFILE;
}

export function setProfiles(value: Record<string, WalletProfile>): void {
  profiles = value;
}

export function setActiveProfileName(name: string): void {
  activeProfileName = name;
}

function applyRestoredState(state: ProfileState): void {
  profiles = state.profiles;
  activeProfileName = state.activeProfile;
  saveState();
}

function loadState(): void {
  if (!existsSync(STATE_FILE)) return;
  try {
    const raw = readFileSync(STATE_FILE, "utf-8");
    const { state, migrated } = migrateState(JSON.parse(raw));
    profiles = state.profiles;
    activeProfileName = state.activeProfile;
    if (migrated) saveState();
  } catch {
    void 0;
  }
}

function persistableProfiles(): Record<string, WalletProfile> {
  const out: Record<string, WalletProfile> = {};
  for (const [name, profile] of Object.entries(profiles)) {
    if (profile.wallet || profile.apiKey || name === activeProfileName) out[name] = profile;
  }
  return out;
}

function saveState(): void {
  try {
    const state: ProfileState = {
      version: STATE_VERSION,
      activeProfile: activeProfileName,
      profiles: persistableProfiles(),
    };
    writeAtomically(STATE_FILE, JSON.stringify(state, null, 2), 0o600);
  } catch (err) {
    console.error("MindVault MCP: failed to persist state:", safeErrorMessage(err));
  }
}

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

function sourceForUrl(url: string): ErrorSource {
  if (url.startsWith(SPONSORED_ACCOUNT_URL)) return "sponsored";
  if (url.startsWith(HORIZON_URL)) return "horizon";
  if (url.startsWith(SOROBAN_RPC_URL)) return "soroban";
  return "api";
}

function timeoutServiceForUrl(url: string): TimeoutService {
  if (url.startsWith(HORIZON_URL)) return "horizon";
  if (url.startsWith(SOROBAN_RPC_URL)) return "soroban";
  return "http";
}

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
    ...(init?.headers as Record<string, string> | undefined),
  };
  const headers = signMutatingHeaders(url, method, baseHeaders, body);

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
  return wrapFetchWithPayment(withTimeout(httpFetch, "payment", TIMEOUTS.payment), client);
}

export {
  STELLAR_NETWORK,
  networkPreset,
  BASE_URL,
  REGISTRY_CONTRACT_ID,
  REGISTRY_NETWORK_PASSPHRASE,
  SPONSORED_ACCOUNT_URL,
  HORIZON_URL,
  SOROBAN_RPC_URL,
  type X402Network,
  NETWORK,
  MOCK,
  metrics,
  TIMEOUTS,
  RETRY_POLICY,
  USER_AGENT,
  logRetry,
  httpFetch,
  STATE_DIR,
  STATE_FILE,
  configureStatePaths,
  resolveAgentSecret,
  profiles,
  activeProfileName,
  activeProfile,
  currentWallet,
  currentApiKey,
  resolveProfileName,
  applyRestoredState,
  loadState,
  persistableProfiles,
  saveState,
  currentResetScope,
  httpRetryOptions,
  sorobanRpcFetch,
  sourceForUrl,
  timeoutServiceForUrl,
  SERVICE_OPERATION,
  jsonFetch,
  requireWallet,
  requireApiKey,
  publisherCredential,
  makePaidFetch,
  _isMock,
};
