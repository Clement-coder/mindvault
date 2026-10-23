/**
 * Tests for standard proxy configuration (#1075).
 *
 * Two things must hold for an enterprise deployment to trust this feature:
 * routing follows the conventional variables (including NO_PROXY) and
 * credentials embedded in a proxy URL never appear in any operator-facing
 * string. Both are pure functions, so they are exercised directly, plus one
 * end-to-end check that `withProxy` actually attaches an undici dispatcher.
 */
import { describe, expect, it } from "vitest";
import { ProxyAgent } from "undici";
import {
  createProxyDispatcher,
  describeProxyConfig,
  isProxyBypassed,
  matchesNoProxyEntry,
  proxyForUrl,
  redactProxyUrl,
  resolveProxyConfig,
  withProxy,
} from "./proxy.js";

describe("resolveProxyConfig", () => {
  it("reports disabled with nothing set — direct connection is the default", () => {
    const config = resolveProxyConfig({});
    expect(config).toEqual({
      httpProxy: null,
      httpsProxy: null,
      noProxy: null,
      enabled: false,
    });
    expect(proxyForUrl("https://example.com", config)).toBeNull();
  });

  it("reads the uppercase variables", () => {
    const config = resolveProxyConfig({
      HTTP_PROXY: "http://proxy:8080",
      HTTPS_PROXY: "http://proxy:8443",
      NO_PROXY: "localhost",
    });
    expect(config.httpProxy).toBe("http://proxy:8080");
    expect(config.httpsProxy).toBe("http://proxy:8443");
    expect(config.noProxy).toBe("localhost");
    expect(config.enabled).toBe(true);
  });

  it("reads the lowercase aliases", () => {
    const config = resolveProxyConfig({
      http_proxy: "http://proxy:8080",
      https_proxy: "http://proxy:8443",
      no_proxy: "localhost",
    });
    expect(config.httpProxy).toBe("http://proxy:8080");
    expect(config.httpsProxy).toBe("http://proxy:8443");
    expect(config.noProxy).toBe("localhost");
    expect(config.enabled).toBe(true);
  });

  it("prefers the uppercase spelling when both are set", () => {
    const config = resolveProxyConfig({
      HTTP_PROXY: "http://upper:8080",
      http_proxy: "http://lower:8080",
    });
    expect(config.httpProxy).toBe("http://upper:8080");
  });

  it("treats an empty or whitespace-only value as unset", () => {
    const config = resolveProxyConfig({ HTTP_PROXY: "   ", http_proxy: "http://lower:8080" });
    expect(config.httpProxy).toBe("http://lower:8080");
    expect(resolveProxyConfig({ HTTPS_PROXY: "" }).enabled).toBe(false);
  });
});

describe("proxyForUrl — scheme selection", () => {
  const config = resolveProxyConfig({
    HTTP_PROXY: "http://http-proxy:8080",
    HTTPS_PROXY: "http://https-proxy:8443",
  });

  it("routes https through HTTPS_PROXY", () => {
    expect(proxyForUrl("https://api.example.com", config)).toBe("http://https-proxy:8443");
    expect(proxyForUrl(new URL("https://api.example.com"), config)).toBe("http://https-proxy:8443");
  });

  it("routes http through HTTP_PROXY", () => {
    expect(proxyForUrl("http://api.example.com", config)).toBe("http://http-proxy:8080");
  });

  it("falls back to the other proxy when one is unset", () => {
    const httpsOnly = resolveProxyConfig({ HTTPS_PROXY: "http://p:8443" });
    expect(proxyForUrl("http://api.example.com", httpsOnly)).toBe("http://p:8443");
    const httpOnly = resolveProxyConfig({ HTTP_PROXY: "http://p:8080" });
    expect(proxyForUrl("https://api.example.com", httpOnly)).toBe("http://p:8080");
  });

  it("returns null for an unparseable URL rather than guessing", () => {
    expect(proxyForUrl("not a url", config)).toBeNull();
  });
});

describe("NO_PROXY matching", () => {
  const config = resolveProxyConfig({
    HTTPS_PROXY: "http://proxy:8443",
    NO_PROXY: "localhost,127.0.0.1,.internal.example,billing.example.com:8443,*",
  });

  it("matches an exact host", () => {
    expect(matchesNoProxyEntry("localhost", null, "localhost")).toBe(true);
    expect(matchesNoProxyEntry("notlocalhost", null, "localhost")).toBe(false);
  });

  it("matches a leading-dot entry as a domain suffix", () => {
    expect(matchesNoProxyEntry("api.internal.example", null, ".internal.example")).toBe(true);
    expect(matchesNoProxyEntry("internal.example", null, ".internal.example")).toBe(true);
    expect(matchesNoProxyEntry("notinternal.example", null, ".internal.example")).toBe(false);
  });

  it("matches a bare domain on a label boundary", () => {
    expect(matchesNoProxyEntry("api.example.com", null, "example.com")).toBe(true);
    expect(matchesNoProxyEntry("notexample.com", null, "example.com")).toBe(false);
  });

  it("honours the port when an entry names one", () => {
    expect(matchesNoProxyEntry("billing.example.com", "8443", "billing.example.com:8443")).toBe(
      true,
    );
    expect(matchesNoProxyEntry("billing.example.com", "443", "billing.example.com:8443")).toBe(
      false,
    );
  });

  it("ignores blank entries and matches nothing when the list is empty", () => {
    expect(matchesNoProxyEntry("example.com", null, "  ")).toBe(false);
    const noList = resolveProxyConfig({ HTTPS_PROXY: "http://proxy:8443" });
    expect(isProxyBypassed(new URL("https://example.com"), noList.noProxy)).toBe(false);
  });

  it("bypasses every host when the list contains *", () => {
    expect(isProxyBypassed(new URL("https://anything.example"), config.noProxy)).toBe(true);
    expect(proxyForUrl("https://anything.example", config)).toBeNull();
  });
});

describe("redactProxyUrl", () => {
  it("strips userinfo while keeping scheme, host, and port", () => {
    expect(redactProxyUrl("http://user:s3cret@proxy.corp:8080")).toBe("http://proxy.corp:8080/");
  });

  it("leaves a credential-free URL unchanged", () => {
    expect(redactProxyUrl("http://proxy.corp:8080")).toBe("http://proxy.corp:8080");
  });

  it("returns null for null, undefined, and blank input", () => {
    expect(redactProxyUrl(null)).toBeNull();
    expect(redactProxyUrl(undefined)).toBeNull();
    expect(redactProxyUrl("   ")).toBeNull();
  });

  it("removes userinfo defensively when the value is not a parseable URL", () => {
    const redacted = redactProxyUrl("proxy://user:pass@host");
    expect(redacted).toBe("proxy://host");
  });
});

describe("describeProxyConfig — never exposes credentials", () => {
  it("reports the redacted URL and the enabled flag", () => {
    const summary = describeProxyConfig(
      resolveProxyConfig({
        HTTPS_PROXY: "http://user:s3cret@proxy.corp:8443",
        NO_PROXY: "localhost",
      }),
    );
    expect(summary.enabled).toBe(true);
    expect(summary.httpsProxy).toBe("http://proxy.corp:8443/");
    expect(summary.httpsProxy).not.toContain("s3cret");
    expect(summary.noProxy).toBe("localhost");
  });

  it("reports disabled when no proxy is configured", () => {
    expect(describeProxyConfig(resolveProxyConfig({})).enabled).toBe(false);
  });
});

describe("createProxyDispatcher / withProxy", () => {
  it("builds no dispatcher for a null proxy URL", () => {
    expect(createProxyDispatcher(null)).toBeNull();
  });

  it("builds an undici ProxyAgent for a proxy URL", () => {
    expect(createProxyDispatcher("http://proxy.corp:8080")).toBeInstanceOf(ProxyAgent);
  });

  it("returns the fetch implementation untouched when no proxy is configured", () => {
    const impl = (() => Promise.resolve(new Response())) as unknown as typeof fetch;
    expect(withProxy(impl, resolveProxyConfig({}))).toBe(impl);
  });

  it("attaches a dispatcher to proxied requests and leaves bypassed hosts alone", async () => {
    const config = resolveProxyConfig({
      HTTPS_PROXY: "http://proxy.corp:8443",
      NO_PROXY: "direct.example.com",
    });
    const seen: RequestInit[] = [];
    const impl = ((_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init ?? {});
      return Promise.resolve(new Response("ok"));
    }) as typeof fetch;

    const wrapped = withProxy(impl, config);
    await wrapped("https://api.example.com");
    await wrapped("https://direct.example.com");

    expect((seen[0] as { dispatcher?: unknown }).dispatcher).toBeInstanceOf(ProxyAgent);
    expect((seen[1] as { dispatcher?: unknown }).dispatcher).toBeUndefined();
  });

  it("reuses one dispatcher per proxy URL", async () => {
    const config = resolveProxyConfig({ HTTPS_PROXY: "http://proxy.corp:8443" });
    const seen: RequestInit[] = [];
    const impl = ((_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init ?? {});
      return Promise.resolve(new Response("ok"));
    }) as typeof fetch;

    const wrapped = withProxy(impl, config);
    await wrapped("https://a.example.com");
    await wrapped("https://b.example.com");

    expect((seen[0] as { dispatcher?: unknown }).dispatcher).toBe(
      (seen[1] as { dispatcher?: unknown }).dispatcher,
    );
  });
});
