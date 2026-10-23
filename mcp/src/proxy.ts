/**
 * Standard proxy configuration for MindVault MCP outbound HTTP (#1075).
 *
 * Enterprise deployments rarely let an agent reach the internet directly;
 * traffic must traverse an egress proxy. Node's built-in `fetch` (undici) has
 * no automatic proxy support, so before this module every outbound call —
 * the MindVault API, Horizon, Soroban RPC, the sponsored-account service, and
 * x402 paid fetches — ignored `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` entirely.
 *
 * This module reads the conventional proxy environment variables, decides
 * per-URL whether a proxy applies (honouring `NO_PROXY`), builds an undici
 * dispatcher for the requests that need one, and exposes a redacted view of
 * the configuration so credentials embedded in a proxy URL never reach a log,
 * a diagnostic, or the debug bundle.
 *
 * Two invariants motivate the shape of this module:
 *
 *   1. Direct-connect stays the default. With no proxy variable set,
 *      `resolveProxyConfig` reports `enabled: false` and `proxyForUrl` returns
 *      `null`, so behaviour is byte-for-byte what it was before.
 *   2. Credentials never leak. Proxy URLs frequently carry `user:password@`
 *      userinfo. `redactProxyUrl` strips it, and every operator-facing string
 *      this module produces is derived from the redacted form.
 *
 * The resolution and matching functions are pure and take an injected
 * environment and URL so they are unit-testable without a real proxy.
 */

import { ProxyAgent } from "undici";

// ── Environment variables ─────────────────────────────────────────────────────

/**
 * Standard proxy environment variables.
 *
 * The lowercase spellings are honoured too, matching the de-facto convention
 * (curl, wget, most CI systems): the uppercase form wins when both are set,
 * except that an empty uppercase value does not mask a populated lowercase
 * one.
 */
export const PROXY_ENV_VARS = {
  http: "HTTP_PROXY",
  https: "HTTPS_PROXY",
  noProxy: "NO_PROXY",
} as const;

// ── Resolved configuration ────────────────────────────────────────────────────

/** The proxy configuration resolved from an environment. */
export interface ProxyConfig {
  /** Proxy URL applied to `http:` requests, or `null` when none is configured. */
  httpProxy: string | null;
  /** Proxy URL applied to `https:` requests, or `null` when none is configured. */
  httpsProxy: string | null;
  /** Raw `NO_PROXY` bypass list, or `null` when unset. */
  noProxy: string | null;
  /** True when at least one of `httpProxy`/`httpsProxy` is set. */
  enabled: boolean;
}

/** Read a value, treating unset, empty, and whitespace-only as "not configured". */
function proxyValue(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Resolve the proxy configuration from an environment.
 *
 * Pure and total: an unset, empty, or whitespace-only value counts as "not
 * configured", and no value is validated here — a malformed proxy URL is
 * reported at dispatch time so a typo degrades to a clear error rather than
 * crashing startup. With nothing set, `enabled` is `false` and the server
 * keeps its direct connection.
 *
 * The uppercase and lowercase spellings are read explicitly (dot access) so
 * the environment-variable scanners in `envReference.test.ts` and
 * `clientConfigDocs.test.ts` see every name the server honours.
 */
export function resolveProxyConfig(env: NodeJS.ProcessEnv = process.env): ProxyConfig {
  const httpProxy = proxyValue(env.HTTP_PROXY) ?? proxyValue(env.http_proxy);
  const httpsProxy = proxyValue(env.HTTPS_PROXY) ?? proxyValue(env.https_proxy);
  const noProxy = proxyValue(env.NO_PROXY) ?? proxyValue(env.no_proxy);

  return {
    httpProxy,
    httpsProxy,
    noProxy,
    enabled: httpProxy !== null || httpsProxy !== null,
  };
}

// ── NO_PROXY matching ─────────────────────────────────────────────────────────

/**
 * Whether a host is covered by a `NO_PROXY` entry.
 *
 * Follows the conventional semantics:
 *
 *   - `*` bypasses everything.
 *   - An entry matches the host exactly, or as a domain suffix when the entry
 *     starts with `.` (`.example.com` matches `api.example.com` but not
 *     `example.com`), or as a suffix on a DNS label boundary (`example.com`
 *     matches `api.example.com` but not `notexample.com`).
 *   - An `host:port` entry additionally requires the port to match.
 *   - A leading-dot entry without a port ignores the port.
 */
export function matchesNoProxyEntry(host: string, port: string | null, entry: string): boolean {
  const trimmed = entry.trim();
  if (trimmed === "") return false;
  if (trimmed === "*") return true;

  const lastColon = trimmed.lastIndexOf(":");
  const hasPort = lastColon > 0 && !trimmed.slice(lastColon + 1).includes("]");
  const entryHost = hasPort ? trimmed.slice(0, lastColon) : trimmed;
  const entryPort = hasPort ? trimmed.slice(lastColon + 1) : null;

  if (entryPort !== null && port !== null && entryPort !== port) return false;
  if (entryPort !== null && port === null) return false;

  const normalizedHost = host.toLowerCase().replace(/\.$/, "");
  const normalizedEntry = entryHost.toLowerCase().replace(/\.$/, "");

  if (normalizedEntry.startsWith(".")) {
    const domain = normalizedEntry.slice(1);
    return normalizedHost === domain || normalizedHost.endsWith(`.${domain}`);
  }

  return normalizedHost === normalizedEntry || normalizedHost.endsWith(`.${normalizedEntry}`);
}

/**
 * Whether a parsed URL should bypass the proxy according to `NO_PROXY`.
 *
 * An empty or unset list never bypasses. Entries are comma-separated; blank
 * entries are ignored.
 */
export function isProxyBypassed(url: URL, noProxy: string | null | undefined): boolean {
  if (noProxy == null) return false;
  const port = url.port === "" ? null : url.port;
  return noProxy.split(",").some((entry) => matchesNoProxyEntry(url.hostname, port, entry));
}

// ── Per-URL proxy selection ───────────────────────────────────────────────────

/**
 * The proxy URL to use for an outgoing request, or `null` for a direct
 * connection.
 *
 * `https:` requests use `HTTPS_PROXY`, everything else (including plain
 * `http:`) uses `HTTP_PROXY` — the convention every mainstream tool follows.
 * A request whose host matches `NO_PROXY` always connects directly. An
 * unparseable input is treated as direct: this function only decides routing,
 * and fetch will surface the real parse error.
 */
export function proxyForUrl(
  input: string | URL,
  config: ProxyConfig = resolveProxyConfig(),
): string | null {
  if (!config.enabled) return null;

  let url: URL;
  try {
    url = input instanceof URL ? input : new URL(input);
  } catch {
    return null;
  }

  if (isProxyBypassed(url, config.noProxy)) return null;

  return url.protocol === "https:"
    ? (config.httpsProxy ?? config.httpProxy)
    : (config.httpProxy ?? config.httpsProxy);
}

// ── Credential redaction ──────────────────────────────────────────────────────

/**
 * Strip credentials from a proxy URL, keeping only scheme, host, and port.
 *
 * A proxy URL commonly looks like `http://user:secret@proxy.corp:8080`. The
 * userinfo is removed entirely — `http://proxy.corp:8080` — so the result is
 * safe to log, show in diagnostics, or include in a debug bundle. A value that
 * cannot be parsed as a URL has any `user:pass@` userinfo removed textually,
 * so redaction never fails open.
 */
export function redactProxyUrl(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  try {
    const url = new URL(trimmed);
    if (url.username === "" && url.password === "") return trimmed;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    // Not a parseable URL: remove any userinfo segment defensively.
    return trimmed.replace(/\/\/[^/@]*@/, "//");
  }
}

/** A redacted, operator-facing view of the proxy configuration. */
export interface ProxySummary {
  enabled: boolean;
  httpProxy: string | null;
  httpsProxy: string | null;
  noProxy: string | null;
}

/**
 * Redacted summary of the proxy configuration for logs and diagnostics.
 *
 * Both proxy URLs are passed through `redactProxyUrl`, so a password embedded
 * in one is never included. `noProxy` is a list of hostnames and carries no
 * credentials, so it is reported verbatim.
 */
export function describeProxyConfig(config: ProxyConfig = resolveProxyConfig()): ProxySummary {
  return {
    enabled: config.enabled,
    httpProxy: redactProxyUrl(config.httpProxy),
    httpsProxy: redactProxyUrl(config.httpsProxy),
    noProxy: config.noProxy,
  };
}

// ── Undici dispatcher ─────────────────────────────────────────────────────────

/**
 * Build a fetch `dispatcher` for a proxy URL, or `null` when there is none.
 *
 * The dispatcher is an undici `ProxyAgent`, which tunnels the request through
 * the proxy via CONNECT. A malformed proxy URL throws here rather than
 * silently connecting directly — an operator who set a proxy expects their
 * traffic to use it, and failing loudly is safer than leaking it around the
 * proxy.
 */
export function createProxyDispatcher(proxyUrl: string | null): ProxyAgent | null {
  if (proxyUrl == null) return null;
  return new ProxyAgent(proxyUrl);
}

/**
 * Wrap a fetch implementation so each request is routed through the proxy
 * configured for its URL, or connected directly when none applies.
 *
 * The dispatcher is resolved (and cached) per proxy URL, so a request that
 * `NO_PROXY` exempts pays nothing and the common single-proxy case reuses one
 * agent. The wrapper is deliberately the outermost layer around the raw
 * `fetch`, so tests that replace `globalThis.fetch` still observe every call
 * with the same arguments they always did (a `dispatcher` is added only when a
 * proxy actually applies).
 */
export function withProxy(
  fetchImpl: typeof fetch,
  config: ProxyConfig = resolveProxyConfig(),
): typeof fetch {
  if (!config.enabled) return fetchImpl;

  const dispatchers = new Map<string, ProxyAgent>();

  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const target = typeof input === "string" ? input : input instanceof URL ? input : input.url;
    const proxyUrl = proxyForUrl(target, config);
    if (proxyUrl == null) return fetchImpl(input, init);

    let dispatcher = dispatchers.get(proxyUrl);
    if (dispatcher === undefined) {
      dispatcher = createProxyDispatcher(proxyUrl) as ProxyAgent;
      dispatchers.set(proxyUrl, dispatcher);
    }

    return fetchImpl(input, { ...init, dispatcher } as RequestInit);
  }) as typeof fetch;
}
