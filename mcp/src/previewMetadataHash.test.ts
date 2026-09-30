/**
 * Tests for the mindvault_preview_metadata_hash tool (#604).
 *
 * Bootstrap follows index.test.ts rather than the MINDVAULT_MOCK harness: the
 * registry client is replaced with a controllable fake, so the on-chain read
 * is deterministic without a network while everything else — argument
 * validation, dispatch, error mapping, structuredContent wiring — runs for
 * real through the SDK transport.
 *
 * The mock registry is also exercised with plain-string metadata (not
 * digest-anchored JSON), which is exactly the `present: false` report the
 * shared reporter produces for bare pointers — so the tests pin both the
 * wiring and the no-anchor contract on a realistic payload. Digest-anchored
 * and malformed anchors are additionally covered directly against the shared
 * reporter, which is the same code the handler calls.
 */
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Controllable registry fake: "ok" resolves with `metadata`, "contract"
// surfaces a registry error (matched against Errors[2] for not-found),
// "transport" throws before the client answers.
const registryControl = vi.hoisted(() => ({
  state: null as
    | null
    | { kind: "ok"; metadata: unknown }
    | { kind: "contract"; err: Error }
    | { kind: "transport"; err: Error },
}));

vi.mock("@mindvault/registry-client", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createRegistryClient: () => ({
      get: async () => {
        const s = registryControl.state;
        if (s?.kind === "transport") throw s.err;
        if (s?.kind === "contract") {
          return { result: { isErr: () => true, unwrapErr: () => s.err } };
        }
        return {
          result: {
            isErr: () => false,
            unwrap: () => ({ metadata: s === null ? undefined : s.metadata }),
          },
        };
      },
    }),
  };
});

// Isolate state persistence from the developer machine (same as the other
// harness tests) and pin the network preset before index.js loads.
process.env.STELLAR_NETWORK = "testnet";
const harnessHome = mkdtempSync(join(tmpdir(), "mindvault-mcp-hash-"));
process.env.HOME = harnessHome;
process.env.USERPROFILE = harnessHome;

const { server } = await import("./index.js");
const { describeMetadataPointerHash } = await import("./metadataHash.js");
const { Errors as RegistryErrors } = await import("@mindvault/registry-client");
const { startIntegrationHarness, type IntegrationHarness } = await import(
  "./integrationHarness.js"
);

const SHA256 = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

interface HashPreviewStructured {
  resourceId: string;
  pointer: { source: string | null; present: boolean };
  report: {
    present: boolean;
    valid: boolean;
    canonical: string | null;
    algorithm: string | null;
    reason: string | null;
  };
}

describe("mindvault_preview_metadata_hash", () => {
  let harness: IntegrationHarness;

  beforeAll(async () => {
    harness = await startIntegrationHarness(server);
  });

  afterAll(async () => {
    await harness?.close();
    rmSync(harnessHome, { recursive: true, force: true });
  });

  it("is advertised with a read-only annotation and an output schema", async () => {
    const { tools } = await harness.listTools();
    const tool = tools.find((t) => t.name === "mindvault_preview_metadata_hash") as {
      annotations?: { readOnlyHint?: boolean };
      outputSchema?: unknown;
    };
    expect(tool).toBeDefined();
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(tool.outputSchema).toBeDefined();
  });

  it("requires the resourceId argument", async () => {
    const result = await harness.callTool("mindvault_preview_metadata_hash", {});
    expect(result.isError).toBe(true);
    expect((result.content ?? []).map((c) => c.text ?? "").join("\n")).toMatch(
      /resourceId is required/i,
    );
  });

  it("reports the metadata pointer of a registered resource", async () => {
    registryControl.state = { kind: "ok", metadata: "Intro to Stellar" };
    try {
      const result = await harness.callTool("mindvault_preview_metadata_hash", {
        resourceId: "res-001",
      });
      expect(result.isError).toBeUndefined();
      const out = (result.structuredContent ?? undefined) as HashPreviewStructured | undefined;
      expect(out).toBeDefined();
      expect(out?.resourceId).toBe("res-001");
      expect(out?.pointer.source).toBe("on-chain");
      expect(out?.pointer.present).toBe(true);
      // Plain-string pointer: carried, but not digest-anchored, so the report
      // is a deterministic "no digest".
      expect(out?.report.present).toBe(false);
      expect(out?.report.valid).toBe(false);
      expect(out?.report.canonical).toBeNull();
      expect(out?.report.reason).toContain("not JSON");
      const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
      expect(text).toContain("res-001");
      expect(text).toContain("Digest anchored: no");
    } finally {
      registryControl.state = null;
    }
  });

  it("reports a digest-anchored pointer with the canonical form", async () => {
    registryControl.state = {
      kind: "ok",
      metadata: JSON.stringify({
        title: "Anchored",
        description: "has a content hash",
        contentHash: SHA256,
      }),
    };
    try {
      const result = await harness.callTool("mindvault_preview_metadata_hash", {
        resourceId: "res-001",
      });
      const out = (result.structuredContent ?? undefined) as HashPreviewStructured | undefined;
      expect(out?.report.present).toBe(true);
      expect(out?.report.valid).toBe(true);
      expect(out?.report.algorithm).toBe("sha256");
      expect(out?.report.canonical).toBe(`sha256:${SHA256}`);
      const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
      expect(text).toContain(`Canonical digest: sha256:${SHA256}`);
    } finally {
      registryControl.state = null;
    }
  });

  it("surfaces a registry not-found as an input error, not a digest report", async () => {
    registryControl.state = { kind: "contract", err: new Error(RegistryErrors[2].message) };
    try {
      const result = await harness.callTool("mindvault_preview_metadata_hash", {
        resourceId: "no-such-resource",
      });
      expect(result.isError).toBe(true);
      expect((result.content ?? []).map((c) => c.text ?? "").join("\n")).toMatch(
        /not registered on-chain|not found/i,
      );
    } finally {
      registryControl.state = null;
    }
  });

  it("maps a transport failure to the classified soroban error", async () => {
    registryControl.state = { kind: "transport", err: new Error("RPC connection refused") };
    try {
      const result = await harness.callTool("mindvault_preview_metadata_hash", {
        resourceId: "res-001",
      });
      expect(result.isError).toBe(true);
      expect((result.content ?? []).map((c) => c.text ?? "").join("\n")).toContain(
        "Metadata hash preview failed",
      );
    } finally {
      registryControl.state = null;
    }
  });

  // The shared reporter is the same code the handler calls, so its edge cases
  // are pinned directly.
  it("reports a malformed anchor deterministically via the shared reporter", () => {
    const pointer = JSON.stringify({ title: "Bad", contentHash: SHA256.slice(0, 63) });
    const report = describeMetadataPointerHash(pointer);
    expect(report.present).toBe(true);
    expect(report.valid).toBe(false);
    expect(report.canonical).toBeNull();
    expect(report.reason).toBeTruthy();
  });

  it("reports a bare URI pointer as not digest-anchored via the shared reporter", () => {
    const report = describeMetadataPointerHash("ipfs://QmProbe");
    expect(report.present).toBe(false);
    expect(report.reason).toContain("not JSON");
  });
});
