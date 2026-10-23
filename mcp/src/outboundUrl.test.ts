/**
 * Security tests for the outbound-URL guard (#1078).
 *
 * The guard exists so a publisher-supplied URL cannot turn a publish or
 * verification flow into an SSRF primitive. These tests pin the acceptance
 * bar: every private / loopback / link-local / reserved address is rejected
 * (IPv4 and IPv6, literal and resolved), a public URL is accepted, a redirect
 * to a blocked host is stopped at the hop, and a host that resolves to a
 * blocked address on a later lookup is rejected (DNS rebinding).
 */
import { describe, it, expect, vi } from "vitest";
import {
  OutboundUrlError,
  assertOutboundUrlAllowed,
  assertRedirectAllowed,
  guardedFetch,
  isBlockedAddress,
  isBlockedHostname,
  isBlockedIpv4,
  isBlockedIpv6,
  isHostAllowlisted,
  parseUrlAllowlist,
  resolveOutboundUrl,
} from "./outboundUrl.js";

/** A resolver that answers every host with the given addresses. */
function resolverFor(addresses: readonly string[]) {
  return vi.fn(async () => addresses);
}

describe("IPv4 classification", () => {
  const blocked = [
    "0.0.0.0",
    "0.1.2.3",
    "10.0.0.1",
    "10.255.255.255",
    "100.64.0.1",
    "127.0.0.1",
    "127.255.255.254",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.1",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "239.255.255.255",
    "240.0.0.1",
    "255.255.255.255",
  ];

  const allowed = ["1.1.1.1", "8.8.8.8", "93.184.216.34", "172.15.0.1", "172.32.0.1", "11.0.0.1"];

  it.each(blocked)("rejects %s", (address) => {
    expect(isBlockedIpv4(address)).toBe(true);
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(allowed)("allows %s", (address) => {
    expect(isBlockedIpv4(address)).toBe(false);
    expect(isBlockedAddress(address)).toBe(false);
  });

  it("ignores non-IPv4 strings", () => {
    expect(isBlockedIpv4("example.com")).toBe(false);
    expect(isBlockedIpv4("999.1.1.1")).toBe(false);
  });
});

describe("IPv6 classification", () => {
  const blocked = [
    "::",
    "::1",
    "fe80::1",
    "feb0::1",
    "fc00::1",
    "fd12:3456:789a::1",
    "ff02::1",
    "100::1",
    "2001:db8::1",
    "2001::1",
    "2002::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "::ffff:10.0.0.1",
    "::127.0.0.1",
    "64:ff9b::10.0.0.1",
  ];

  const allowed = ["2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8"];

  it.each(blocked)("rejects %s", (address) => {
    expect(isBlockedIpv6(address)).toBe(true);
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(allowed)("allows %s", (address) => {
    expect(isBlockedIpv6(address)).toBe(false);
    expect(isBlockedAddress(address)).toBe(false);
  });

  it("strips a zone id before classifying", () => {
    expect(isBlockedIpv6("fe80::1%eth0")).toBe(true);
  });
});

describe("hostname classification", () => {
  it.each([
    "localhost",
    "LOCALHOST",
    "foo.localhost",
    "x.local",
    "internal",
    "api.internal",
    "host.home.arpa",
  ])("rejects structural local host %s", (host) => {
    expect(isBlockedHostname(host)).toBe(true);
  });

  it.each(["example.com", "api.mindvault.dev", "8.8.8.8"])("allows %s", (host) => {
    expect(isBlockedHostname(host)).toBe(false);
  });

  it("rejects a bracketed loopback IPv6 literal", () => {
    expect(isBlockedHostname("[::1]")).toBe(true);
  });
});

describe("resolveOutboundUrl — scheme and shape", () => {
  it("rejects a non-string or empty value", async () => {
    expect((await resolveOutboundUrl(undefined)).code).toBe("not_a_string");
    expect((await resolveOutboundUrl("   ")).code).toBe("empty");
  });

  it("rejects a malformed URL", async () => {
    expect((await resolveOutboundUrl("not a url")).code).toBe("malformed");
  });

  it.each(["file:///etc/passwd", "ftp://example.com/x", "gopher://example.com/"])(
    "rejects the %s scheme",
    async (url) => {
      expect((await resolveOutboundUrl(url)).code).toBe("unsupported_scheme");
    },
  );

  it("accepts an http(s) URL with a public host", async () => {
    const decision = await resolveOutboundUrl("https://example.com/data.json");
    expect(decision.allowed).toBe(true);
    expect(decision.url?.hostname).toBe("example.com");
  });
});

describe("resolveOutboundUrl — blocked hosts", () => {
  it("rejects a loopback IP literal without needing DNS", async () => {
    const decision = await resolveOutboundUrl("http://127.0.0.1:8080/admin");
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("blocked_address");
  });

  it("rejects the cloud metadata address", async () => {
    const decision = await resolveOutboundUrl("http://169.254.169.254/latest/meta-data/");
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("blocked_address");
  });

  it("rejects a bracketed IPv6 loopback literal", async () => {
    const decision = await resolveOutboundUrl("http://[::1]/");
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("blocked_address");
  });

  it("rejects localhost by name", async () => {
    const decision = await resolveOutboundUrl("http://localhost:4021/");
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("blocked_host");
  });
});

describe("resolveOutboundUrl — DNS rebinding", () => {
  it("rejects a named host that resolves to a private address", async () => {
    const decision = await resolveOutboundUrl("https://evil.example/x", {
      resolveHost: resolverFor(["10.0.0.5"]),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("blocked_address");
  });

  it("rejects when any answer in a mixed set is private", async () => {
    const decision = await resolveOutboundUrl("https://mixed.example/x", {
      resolveHost: resolverFor(["93.184.216.34", "169.254.169.254"]),
    });
    expect(decision.allowed).toBe(false);
  });

  it("accepts when every answer is public", async () => {
    const decision = await resolveOutboundUrl("https://good.example/x", {
      resolveHost: resolverFor(["93.184.216.34", "2606:4700:4700::1111"]),
    });
    expect(decision.allowed).toBe(true);
  });

  it("reports a resolver failure rather than allowing the URL", async () => {
    const decision = await resolveOutboundUrl("https://broken.example/x", {
      resolveHost: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("dns_failure");
  });

  it("does not resolve when no resolver is supplied", async () => {
    // A named host passes without resolution: the guard does no I/O on its own.
    const decision = await resolveOutboundUrl("https://evil.example/x");
    expect(decision.allowed).toBe(true);
  });
});

describe("allowlist", () => {
  it("parses and normalizes entries", () => {
    const list = parseUrlAllowlist(" HTTPS://Example.COM/ , localhost , 10.0.0.1:8080 , ");
    expect(list.hosts).toEqual(["example.com", "localhost", "10.0.0.1"]);
    expect(list.isEmpty).toBe(false);
  });

  it("treats an unset or empty value as empty", () => {
    expect(parseUrlAllowlist(undefined).isEmpty).toBe(true);
    expect(parseUrlAllowlist("   ").isEmpty).toBe(true);
  });

  it("matches exact hosts and subdomains of a leading-dot entry", () => {
    const list = parseUrlAllowlist("internal.example, .corp.example");
    expect(isHostAllowlisted("internal.example", list)).toBe(true);
    expect(isHostAllowlisted("api.corp.example", list)).toBe(true);
    expect(isHostAllowlisted("corp.example", list)).toBe(true);
    expect(isHostAllowlisted("other.example", list)).toBe(false);
  });

  it("lets an allowlisted private host through the guard", async () => {
    const decision = await resolveOutboundUrl("http://10.0.0.5/registry", {
      allowlist: parseUrlAllowlist("10.0.0.5"),
    });
    expect(decision.allowed).toBe(true);
  });

  it("still enforces the scheme for an allowlisted host", async () => {
    const decision = await resolveOutboundUrl("file:///etc/passwd", {
      allowlist: parseUrlAllowlist("localhost"),
    });
    expect(decision.code).toBe("unsupported_scheme");
  });
});

describe("assertOutboundUrlAllowed", () => {
  it("returns the parsed URL when allowed", async () => {
    const url = await assertOutboundUrlAllowed("https://example.com/x");
    expect(url.href).toBe("https://example.com/x");
  });

  it("throws OutboundUrlError with a stable code when rejected", async () => {
    await expect(assertOutboundUrlAllowed("http://127.0.0.1/")).rejects.toBeInstanceOf(
      OutboundUrlError,
    );
    await expect(assertOutboundUrlAllowed("http://127.0.0.1/")).rejects.toMatchObject({
      code: "blocked_address",
    });
  });
});

describe("redirect handling", () => {
  it("re-checks each hop and stops a redirect to a blocked host", async () => {
    await expect(assertRedirectAllowed("http://169.254.169.254/")).rejects.toMatchObject({
      code: "blocked_address",
    });
  });

  it("guardedFetch follows a safe redirect and re-validates every hop", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      if (urls.length === 1) {
        return new Response(null, { status: 302, headers: { location: "https://example.com/b" } });
      }
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const res = await guardedFetch("https://example.com/a", { fetchImpl });
    expect(res.status).toBe(200);
    expect(urls).toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  it("guardedFetch refuses a redirect to a private address", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      });
    }) as unknown as typeof fetch;

    await expect(guardedFetch("https://example.com/a", { fetchImpl })).rejects.toMatchObject({
      code: "blocked_address",
    });
  });
});
