/**
 * Outbound URL allowlisting for the MindVault MCP server (#1078).
 *
 * Publish and verification flows carry a publisher-supplied URL: the
 * `externalUrl` a buyer receives after payment, and the `http(s)://` metadata
 * pointer a resource anchors on-chain. Those strings travel to the API and the
 * registry untouched, and any component that later dereferences them — the
 * server, an indexer, or a future verification fetcher — would do so with the
 * publisher's chosen host. A URL that resolves to `127.0.0.1`, an RFC1918
 * address, a cloud metadata endpoint (`169.254.169.254`), or an IPv6
 * unique-local address turns that innocent "verify this content" call into a
 * server-side request forgery (SSRF) primitive against the host's own network.
 *
 * This module is the single gate every outbound, publisher-supplied URL passes
 * through. It rejects, before any request is made:
 *
 *   - non-`http(s)` schemes (`file:`, `gopher:`, `ftp:`, …),
 *   - literal IP hosts in a loopback, private, link-local, unique-local,
 *     multicast, or otherwise reserved range (IPv4 and IPv6),
 *   - hostnames that are structurally local (`localhost`, `.localhost`,
 *     `.local`, `.internal`, `.home.arpa`),
 *   - hostnames that *resolve* to any of those addresses — the DNS-rebinding
 *     defence: a host such as `evil.example` that answers with a public address
 *     on one lookup and `169.254.169.254` on the next is rejected because every
 *     resolved address is checked, not just the first.
 *
 * The check is repeated per redirect hop (`assertRedirectAllowed`), so a public
 * URL that 302s to `http://169.254.169.254/` is stopped at the hop rather than
 * followed.
 *
 * Operators who deliberately target a private host (a local registry mirror, a
 * lab deployment) opt in through `MINDVAULT_URL_ALLOWLIST`, a comma-separated
 * list of hosts. An allowlisted host skips the address checks but never the
 * scheme check.
 *
 * Design rules, mirroring `metadataHash.ts` and `proxy.ts`:
 *
 *   - Pure: parsing and policy only. DNS is injected as a `resolveHost`
 *     function, so the module has no I/O of its own and is unit-testable
 *     against a fake resolver.
 *   - Deterministic, agent-safe errors: a stable `code` and a one-line message
 *     that names the reason but never echoes the full URL or any secret.
 */

/** Why an outbound URL was rejected. Stable identifiers, safe to branch on. */
export type OutboundUrlErrorCode =
  | "not_a_string"
  | "empty"
  | "malformed"
  | "unsupported_scheme"
  | "missing_host"
  | "blocked_host"
  | "blocked_address"
  | "dns_failure";

/** Thrown by `resolveOutboundUrl` when a URL is not safe to dereference. */
export class OutboundUrlError extends Error {
  readonly code: OutboundUrlErrorCode;

  constructor(code: OutboundUrlErrorCode, message: string) {
    super(message);
    this.name = "OutboundUrlError";
    this.code = code;
  }
}

/** Environment variable that opts specific hosts out of the address checks. */
export const URL_ALLOWLIST_ENV_VAR = "MINDVAULT_URL_ALLOWLIST";

/**
 * Environment variable that turns the DNS-resolution defence on or off.
 *
 * Resolution is disabled by default in two situations where it would be wrong
 * rather than helpful: inside the pure argument validator (which must not do
 * I/O) and in environments without a resolver. Callers that own a live network
 * path enable it explicitly.
 */
export const URL_DNS_CHECK_ENV_VAR = "MINDVAULT_URL_DNS_CHECK";

/** Public surface of the allowlist so callers can describe it in diagnostics. */
export interface UrlAllowlist {
  /** Hosts (lowercased) that skip the address checks. Empty when unset. */
  readonly hosts: readonly string[];
  /** True when no host is allowlisted. */
  readonly isEmpty: boolean;
}

/** Result of a guard evaluation. */
export interface OutboundUrlDecision {
  /** The parsed, normalized URL. Present only when `allowed`. */
  readonly url?: URL;
  /** True when the URL may be dereferenced. */
  readonly allowed: boolean;
  /** Why the URL was rejected; present only when `!allowed`. */
  readonly code?: OutboundUrlErrorCode;
  /** One-line, agent-safe explanation; present only when `!allowed`. */
  readonly reason?: string;
}

/** A DNS resolver: hostname to the list of addresses it answers with. */
export type ResolveHost = (hostname: string) => Promise<readonly string[]>;

/** Options for `resolveOutboundUrl`. */
export interface ResolveOutboundUrlOptions {
  /** Resolved once from the environment unless supplied. */
  readonly allowlist?: UrlAllowlist;
  /**
   * Resolver used for the DNS-rebinding check. When omitted, hostnames are not
   * resolved — only literal-IP and structural checks apply. Pass one to enable
   * the full defence.
   */
  readonly resolveHost?: ResolveHost;
}

// ── Allowlist parsing ──────────────────────────────────────────────────────────

/**
 * Parse a comma-separated allowlist string into a normalized `UrlAllowlist`.
 *
 * Entries are trimmed, lowercased, and stripped of a scheme, path, and
 * trailing dot so `HTTPS://Example.COM/` and `example.com.` both match the
 * host `example.com`. Empty entries are dropped, so a trailing comma is not an
 * error.
 */
export function parseUrlAllowlist(raw: string | undefined | null): UrlAllowlist {
  const hosts = (raw ?? "")
    .split(",")
    .map((entry) => normalizeAllowlistEntry(entry))
    .filter((entry) => entry.length > 0);
  return { hosts: [...new Set(hosts)], isEmpty: hosts.length === 0 };
}

function normalizeAllowlistEntry(entry: string): string {
  let value = entry.trim().toLowerCase();
  if (value.length === 0) return "";
  // Strip a leading scheme (`https://`), any path/query/fragment.
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  value = value.split(/[/?#]/, 1)[0];
  // Strip userinfo (`user:pass@host`).
  const at = value.lastIndexOf("@");
  if (at !== -1) value = value.slice(at + 1);
  // Strip a port (`host:443`) for IPv4/hostname entries. A bare IPv6 literal is
  // bracketed at this point (`[::1]`), so a colon outside brackets is the port.
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close !== -1) value = value.slice(1, close);
  } else if (value.includes(":")) {
    const [host] = value.split(":", 1);
    value = host;
  }
  return value.replace(/\.$/, "");
}

/** Read the allowlist from a process-style environment object. */
export function resolveUrlAllowlist(env: NodeJS.ProcessEnv = process.env): UrlAllowlist {
  return parseUrlAllowlist(env.MINDVAULT_URL_ALLOWLIST);
}

/** True when `host` (lowercased) is allowlisted, or matches a `*.domain` entry. */
export function isHostAllowlisted(host: string, allowlist: UrlAllowlist): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, "");
  for (const entry of allowlist.hosts) {
    if (entry === normalized) return true;
    // A leading-dot (or bare-domain) entry matches the domain and its subtree.
    if (normalized === entry.replace(/^\./, "")) return true;
    if (entry.startsWith(".") && normalized.endsWith(entry)) return true;
  }
  return false;
}

// ── Address classification ─────────────────────────────────────────────────────

/**
 * True when an IPv4 address string belongs to a blocked (loopback, private,
 * link-local, shared, multicast, or reserved) range.
 *
 * Ranges, per IANA and RFC 6890:
 *
 *   0.0.0.0/8        "this network"
 *   10.0.0.0/8       private (RFC1918)
 *   100.64.0.0/10    shared address space / CGNAT (RFC6598)
 *   127.0.0.0/8      loopback
 *   169.254.0.0/16   link-local (includes 169.254.169.254 metadata)
 *   172.16.0.0/12    private (RFC1918)
 *   192.0.0.0/24     IETF protocol assignments
 *   192.0.2.0/24     TEST-NET-1
 *   192.88.99.0/24   6to4 relay anycast
 *   192.168.0.0/16   private (RFC1918)
 *   198.18.0.0/15    benchmarking
 *   198.51.100.0/24  TEST-NET-2
 *   203.0.113.0/24   TEST-NET-3
 *   224.0.0.0/4      multicast
 *   240.0.0.0/4      reserved (includes 255.255.255.255 broadcast)
 */
export function isBlockedIpv4(address: string): boolean {
  const octets = parseIpv4(address);
  if (!octets) return false;
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10
  if (a === 127) return true; // 127/8
  if (a === 169 && b === 254) return true; // 169.254/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 0 && octets[2] === 0) return true; // 192.0.0/24
  if (a === 192 && b === 0 && octets[2] === 2) return true; // 192.0.2/24
  if (a === 192 && b === 88 && octets[2] === 99) return true; // 192.88.99/24
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15
  if (a === 198 && b === 51 && octets[2] === 100) return true; // 198.51.100/24
  if (a === 203 && b === 0 && octets[2] === 113) return true; // 203.0.113/24
  if (a >= 224) return true; // 224/4 multicast + 240/4 reserved
  return false;
}

/**
 * True when an IPv6 address string belongs to a blocked range.
 *
 * Ranges:
 *
 *   ::/128           unspecified
 *   ::1/128          loopback
 *   ::ffff:0:0/96    IPv4-mapped — classified by the embedded IPv4 address
 *   ::/96            IPv4-compatible — classified by the embedded IPv4 address
 *   64:ff9b::/96     IPv4/IPv6 translation — classified by the embedded IPv4
 *   100::/64         discard-only
 *   2001:db8::/32    documentation
 *   2001::/32, 2002::/16  Teredo / 6to4 (tunnels to arbitrary IPv4)
 *   fc00::/7         unique-local (private)
 *   fe80::/10        link-local
 *   ff00::/8         multicast
 */
export function isBlockedIpv6(address: string): boolean {
  const groups = parseIpv6(address);
  if (!groups) return false;

  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;

  const isZeroUpTo = (n: number): boolean => {
    for (let i = 0; i < n; i++) if (groups[i] !== 0) return false;
    return true;
  };

  // ::/128 (unspecified) and ::1/128 (loopback).
  if (isZeroUpTo(7) && g7 <= 1) return true;

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): first five
  // groups zero, g5 is 0 or 0xffff. Also 64:ff9b::/96 (g0=0x64,g1=0xff9b).
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isBlockedIpv4(embeddedIpv4(g6, g7));
  }
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isBlockedIpv4(embeddedIpv4(g6, g7));
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isBlockedIpv4(embeddedIpv4(g6, g7));
  }

  // 100::/64 discard-only.
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true;
  // 2001:db8::/32 documentation.
  if (g0 === 0x2001 && g1 === 0xdb8) return true;
  // 2001::/32 Teredo and 2002::/16 6to4 — encapsulate arbitrary IPv4.
  if (g0 === 0x2001 && g1 === 0) return true;
  if (g0 === 0x2002) return true;
  // fc00::/7 unique-local.
  if ((g0 & 0xfe00) === 0xfc00) return true;
  // fe80::/10 link-local.
  if ((g0 & 0xffc0) === 0xfe80) return true;
  // ff00::/8 multicast.
  if ((g0 & 0xff00) === 0xff00) return true;

  return false;
}

/** True when `address` is a blocked IPv4 or IPv6 literal. */
export function isBlockedAddress(address: string): boolean {
  if (address.includes(":")) return isBlockedIpv6(address);
  return isBlockedIpv4(address);
}

/**
 * True when `hostname` is structurally local without a DNS lookup: a bare
 * loopback name or a reserved internal suffix.
 */
export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "local" || host.endsWith(".local")) return true;
  if (host === "internal" || host.endsWith(".internal")) return true;
  if (host === "home.arpa" || host.endsWith(".home.arpa")) return true;
  // Bracketed IPv6 literal, e.g. "[::1]".
  const literal = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (looksLikeIp(literal)) return isBlockedAddress(literal);
  return false;
}

function looksLikeIp(value: string): boolean {
  return value.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(value);
}

// ── Core guard ─────────────────────────────────────────────────────────────────

/**
 * Evaluate whether a publisher-supplied URL may be dereferenced.
 *
 * Never throws for a rejected URL — the decision is returned, so callers can
 * render it in a tool error or a dry-run report. A `resolveHost` in `options`
 * enables the DNS-rebinding check; without it only schemes, literal IPs, and
 * structural hostnames are checked.
 */
export async function resolveOutboundUrl(
  rawUrl: unknown,
  options: ResolveOutboundUrlOptions = {},
): Promise<OutboundUrlDecision> {
  const allowlist = options.allowlist ?? resolveUrlAllowlist();

  if (typeof rawUrl !== "string") {
    return reject("not_a_string", "URL must be a string.");
  }
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) return reject("empty", "URL must not be empty.");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return reject("malformed", "URL is not a valid absolute URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return reject("unsupported_scheme", "URL must use the http or https scheme.");
  }

  const host = url.hostname;
  if (host.length === 0) return reject("missing_host", "URL must include a host.");

  // Whitelisted hosts skip every address check below (scheme is already fixed).
  if (isHostAllowlisted(host, allowlist)) {
    return { url, allowed: true };
  }

  // Literal IP host: classify directly, no resolver needed. Checked before the
  // structural-hostname branch so the reported code distinguishes an address
  // from a reserved name.
  const hostLiteral = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (looksLikeIp(hostLiteral)) {
    if (isBlockedAddress(hostLiteral)) {
      return reject("blocked_address", "URL host is a private, loopback, or reserved address.");
    }
    return { url, allowed: true };
  }

  if (isBlockedHostname(host)) {
    return reject("blocked_host", "URL host resolves to a local or reserved name.");
  }

  // Named host: resolve and check every answer (DNS rebinding).
  if (options.resolveHost) {
    let addresses: readonly string[];
    try {
      addresses = await options.resolveHost(host);
    } catch {
      return reject("dns_failure", "URL host could not be resolved.");
    }
    if (addresses.length === 0) {
      return reject("dns_failure", "URL host could not be resolved.");
    }
    for (const address of addresses) {
      if (isBlockedAddress(address)) {
        return reject(
          "blocked_address",
          "URL host resolves to a private, loopback, or reserved address.",
        );
      }
    }
  }

  return { url, allowed: true };
}

/**
 * Assert the URL is allowed, throwing `OutboundUrlError` otherwise.
 *
 * The throwing form for call sites that abort a request; the decision form
 * (`resolveOutboundUrl`) is for validators that collect messages.
 */
export async function assertOutboundUrlAllowed(
  rawUrl: unknown,
  options: ResolveOutboundUrlOptions = {},
): Promise<URL> {
  const decision = await resolveOutboundUrl(rawUrl, options);
  if (!decision.allowed || !decision.url) {
    throw new OutboundUrlError(decision.code ?? "blocked_host", decision.reason ?? "URL rejected.");
  }
  return decision.url;
}

/**
 * Re-check a redirect target before following it.
 *
 * Redirects are the classic SSRF bypass: a public `Location` target on the
 * first request can point at `169.254.169.254` on the second. Every hop passes
 * back through the full guard, so this is exactly `assertOutboundUrlAllowed`
 * with an intent-revealing name.
 */
export async function assertRedirectAllowed(
  location: string,
  options: ResolveOutboundUrlOptions = {},
): Promise<URL> {
  return assertOutboundUrlAllowed(location, options);
}

/**
 * Guarded fetch: validate the URL, follow redirects manually, and re-validate
 * every hop before it is requested.
 *
 * `fetchImpl` is injected so the module stays free of a global `fetch`
 * dependency in tests. At most `maxRedirects` hops are followed; exceeding the
 * limit is reported rather than silently truncated.
 */
export interface GuardedFetchOptions extends ResolveOutboundUrlOptions {
  readonly fetchImpl: typeof fetch;
  readonly init?: RequestInit;
  readonly maxRedirects?: number;
}

export async function guardedFetch(
  rawUrl: string,
  options: GuardedFetchOptions,
): Promise<Response> {
  const { fetchImpl, init, maxRedirects = 5 } = options;
  let target = await assertOutboundUrlAllowed(rawUrl, options);

  for (let hop = 0; ; hop++) {
    const res = await fetchImpl(target, { ...init, redirect: "manual" });
    const isRedirect = res.status >= 300 && res.status < 400;
    const location = res.headers.get("location");
    if (!isRedirect || !location) return res;

    if (hop >= maxRedirects) {
      throw new OutboundUrlError("malformed", "Too many redirects while fetching the URL.");
    }
    const next = new URL(location, target).toString();
    target = await assertRedirectAllowed(next, options);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function reject(code: OutboundUrlErrorCode, reason: string): OutboundUrlDecision {
  return { allowed: false, code, reason };
}

function parseIpv4(address: string): [number, number, number, number] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets as [number, number, number, number];
}

function embeddedIpv4(high: number, low: number): string {
  const a = (high >> 8) & 0xff;
  const b = high & 0xff;
  const c = (low >> 8) & 0xff;
  const d = low & 0xff;
  return `${a}.${b}.${c}.${d}`;
}

/**
 * Parse an IPv6 address into eight 16-bit groups, expanding `::` and any
 * trailing embedded IPv4 (`::ffff:1.2.3.4`). Returns null when malformed.
 * A zone id (`%eth0`) is stripped.
 */
function parseIpv6(address: string): number[] | null {
  let value = address.trim();
  const zone = value.indexOf("%");
  if (zone !== -1) value = value.slice(0, zone);
  if (value.length === 0) return null;

  // Expand a trailing embedded IPv4 into two groups.
  const lastColon = value.lastIndexOf(":");
  if (lastColon !== -1 && value.slice(lastColon + 1).includes(".")) {
    const embedded = parseIpv4(value.slice(lastColon + 1));
    if (!embedded) return null;
    const [a, b, c, d] = embedded;
    const high = ((a << 8) | b).toString(16);
    const low = ((c << 8) | d).toString(16);
    value = `${value.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const doubleColon = value.indexOf("::");
  let head: string[];
  let tail: string[];
  if (doubleColon !== -1) {
    if (value.indexOf("::", doubleColon + 1) !== -1) return null; // only one `::`
    head = value
      .slice(0, doubleColon)
      .split(":")
      .filter((s) => s.length > 0);
    tail = value
      .slice(doubleColon + 2)
      .split(":")
      .filter((s) => s.length > 0);
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    const groups = [...head, ...Array(missing).fill("0"), ...tail];
    return toGroups(groups);
  }

  const groups = value.split(":");
  if (groups.length !== 8) return null;
  return toGroups(groups);
}

function toGroups(groups: string[]): number[] | null {
  const out: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    out.push(parseInt(group, 16));
  }
  return out;
}
