/**
 * Focused tests for the two-step mindvault_import_wallet confirmation guard (#1050).
 *
 * The feature:
 *   - Without `confirm` (default): derive the address and return a preview that
 *     includes the derived address, target profile, and network binding.
 *     Nothing is written to disk or in-memory state.
 *   - With `confirm: true`: derive, persist, return confirmation.
 *   - The secret key is never present in any response (preview or confirmed).
 *   - Network / profile binding is shown explicitly in both paths.
 */

import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

// Isolate HOME before importing index.js so STATE_DIR/STATE_FILE pick up the
// temp directory (same pattern as concurrentStateWrites.test.ts).
process.env.MINDVAULT_MOCK = "1";
process.env.STELLAR_NETWORK = "testnet";
const home = mkdtempSync(join(tmpdir(), "mindvault-mcp-import-wallet-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

const { dispatchTool, _resetProfiles } = await import("./index.js");
const { Keypair } = await import("@stellar/stellar-sdk");

const STATE_FILE = join(home, ".mindvault", "state.json");

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  _resetProfiles();
  // Wipe state file between tests so each starts clean.
  try {
    rmSync(STATE_FILE);
  } catch {
    // OK if it doesn't exist yet.
  }
});

// ── helpers ──────────────────────────────────────────────────────────────────

// dispatchTool returns Promise<string> (the plain text outcome).
// normalizeToolResultForTest wraps an outcome into { content, structuredContent }.

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return { profiles: {} };
  }
}

// ── preview mode (no confirm) ─────────────────────────────────────────────────

describe("mindvault_import_wallet — preview mode (#1050)", () => {
  it("returns the derived address without writing anything to disk", async () => {
    const kp = Keypair.random();
    const text = await dispatchTool("mindvault_import_wallet", {
      secretKey: kp.secret(),
    });

    expect(text).toContain(kp.publicKey());
    expect(text).toContain("confirmation required");
    expect(text).toContain("confirm: true");

    // Disk state must be empty — nothing persisted.
    expect(Object.keys(readState().profiles)).toHaveLength(0);
  });

  it("shows the target profile in the preview", async () => {
    const kp = Keypair.random();
    const text = await dispatchTool("mindvault_import_wallet", {
      secretKey: kp.secret(),
      profile: "staging",
    });

    expect(text).toContain("staging");
  });

  it("shows network binding in the preview", async () => {
    const kp = Keypair.random();
    const text = await dispatchTool("mindvault_import_wallet", {
      secretKey: kp.secret(),
    });

    expect(text).toMatch(/Network:/);
  });

  it("never includes the secret key in the preview response", async () => {
    const kp = Keypair.random();
    const text = await dispatchTool("mindvault_import_wallet", {
      secretKey: kp.secret(),
    });

    expect(text).not.toContain(kp.secret());
  });

  it("confirm: false produces the same preview as no confirm", async () => {
    const kp = Keypair.random();
    const withFalse = await dispatchTool("mindvault_import_wallet", {
      secretKey: kp.secret(),
      confirm: false,
    });
    const withUndefined = await dispatchTool("mindvault_import_wallet", {
      secretKey: kp.secret(),
    });

    expect(withFalse).toContain("confirmation required");
    expect(withUndefined).toContain("confirmation required");
    expect(Object.keys(readState().profiles)).toHaveLength(0);
  });

  it("rejects an invalid secret key in preview mode", async () => {
    await expect(
      dispatchTool("mindvault_import_wallet", { secretKey: "not-a-key" }),
    ).rejects.toThrow();
  });
});

// ── confirmed import ──────────────────────────────────────────────────────────

describe("mindvault_import_wallet — confirm: true (#1050)", () => {
  it("persists the wallet and returns the address in confirmation", async () => {
    const kp = Keypair.random();
    const text = await dispatchTool("mindvault_import_wallet", {
      secretKey: kp.secret(),
      confirm: true,
    });

    expect(text).toContain("Wallet imported");
    expect(text).toContain(kp.publicKey());

    const state = readState();
    expect(state.profiles.default?.wallet?.publicKey).toBe(kp.publicKey());
  });

  it("imports into a named profile when profile is specified", async () => {
    const kp = Keypair.random();
    await dispatchTool("mindvault_import_wallet", {
      secretKey: kp.secret(),
      profile: "buyer",
      confirm: true,
    });

    const state = readState();
    expect(state.profiles.buyer?.wallet?.publicKey).toBe(kp.publicKey());
  });

  it("shows network binding in the confirmed response", async () => {
    const kp = Keypair.random();
    const text = await dispatchTool("mindvault_import_wallet", {
      secretKey: kp.secret(),
      confirm: true,
    });

    expect(text).toMatch(/Network:/);
  });

  it("never includes the secret key in the confirmed response", async () => {
    const kp = Keypair.random();
    const text = await dispatchTool("mindvault_import_wallet", {
      secretKey: kp.secret(),
      confirm: true,
    });

    expect(text).not.toContain(kp.secret());
  });
});

// ── secret never in any output ────────────────────────────────────────────────

describe("mindvault_import_wallet — secret key never exposed (#1050)", () => {
  it("omits secret from preview text", async () => {
    const kp = Keypair.random();
    const text = await dispatchTool("mindvault_import_wallet", { secretKey: kp.secret() });
    expect(text).not.toContain(kp.secret());
  });

  it("omits secret from confirmed text", async () => {
    const kp = Keypair.random();
    const text = await dispatchTool("mindvault_import_wallet", {
      secretKey: kp.secret(),
      confirm: true,
    });
    expect(text).not.toContain(kp.secret());
  });
});
