/**
 * Wiring tests for the guarded mindvault_reset tool (#406).
 *
 * These exercise the real `resetState` export against a temporary HOME so the
 * confirmed path can be observed clearing memory *and* disk without touching a
 * developer's actual ~/.mindvault/state.json. Mock mode keeps the import of
 * index.ts free of network access.
 */
import { existsSync } from "fs";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

// Isolate agent state before the server module loads.
process.env.MINDVAULT_MOCK = "1";
process.env.STELLAR_NETWORK = "testnet";
const resetHome = mkdtempSync(join(tmpdir(), "mindvault-mcp-reset-"));
process.env.HOME = resetHome;
process.env.USERPROFILE = resetHome;

const STATE_FILE = join(resetHome, ".mindvault", "state.json");

const {
  resetState,
  backupState,
  listProfiles,
  useProfile,
  _resetProfiles,
  _setAgentWallet,
  _setAgentApiKey,
} = await import("./index.js");

const testWallet = {
  publicKey: "GTESTPUBLICKEY000000000000000000000000000000000000000000",
  secretKey: "STESTSECRETKEY000000000000000000000000000000000000000000",
};

/** Seed the active profile with credentials and persist them to the temp HOME. */
function seedPersistedProfile(name = "default"): void {
  _resetProfiles();
  useProfile(name); // sets the active profile and persists
  _setAgentWallet(testWallet);
  _setAgentApiKey("test-api-key");
  useProfile(name); // re-persist with credentials attached
}

afterAll(() => {
  rmSync(resetHome, { recursive: true, force: true });
});

describe("mindvault_reset — unconfirmed", () => {
  beforeEach(() => {
    seedPersistedProfile();
  });

  it("returns a warning instead of clearing anything", () => {
    const result = resetState(false);
    expect(result).toContain("Reset NOT performed");
    expect(result).toContain("confirm: true");
  });

  it("leaves the wallet and API key in memory", () => {
    resetState(false);
    const profiles = listProfiles();
    expect(profiles).toContain("default");
    expect(profiles).toContain(testWallet.publicKey);
    expect(profiles).toContain("registered");
  });

  it("leaves the state file on disk", () => {
    expect(existsSync(STATE_FILE)).toBe(true);
    resetState(true); // all=true, still unconfirmed
    expect(existsSync(STATE_FILE)).toBe(true);
  });

  it("previews an all=true wipe without performing it", () => {
    const result = resetState(true);
    expect(result).toContain("ALL 1 profile(s)");
    expect(result).toContain("the state file itself");
    expect(existsSync(STATE_FILE)).toBe(true);
    expect(listProfiles()).toContain(testWallet.publicKey);
  });

  it("never leaks the wallet secret key into the warning", () => {
    expect(resetState(false)).not.toContain(testWallet.secretKey);
    expect(resetState(true)).not.toContain(testWallet.secretKey);
  });
});

describe("mindvault_backup_state — confirmation", () => {
  beforeEach(() => seedPersistedProfile());

  it("previews without exporting and writes an encrypted file only after confirmation", () => {
    expect(backupState("correct-horse")).toContain("Backup NOT performed");
    const result = backupState("correct-horse", true);
    expect(result).toContain("Encrypted state backup written");
    const path = result.match(/File: (.+)/)?.[1];
    expect(path).toBeTruthy();
    expect(existsSync(path!)).toBe(true);
  });
});

describe("mindvault_reset — confirmed", () => {
  beforeEach(() => {
    seedPersistedProfile();
  });

  it("clears the active profile from memory and re-persists", () => {
    const result = resetState(false, true);
    expect(result).toContain('Profile "default" cleared');
    expect(listProfiles()).not.toContain(testWallet.publicKey);
  });

  it("clears every profile and deletes the state file when all=true", () => {
    expect(existsSync(STATE_FILE)).toBe(true);

    const result = resetState(true, true);

    expect(result).toContain("Reset complete");
    expect(result).toContain("All profiles removed from memory and disk");
    expect(existsSync(STATE_FILE)).toBe(false);
    expect(listProfiles()).toContain("No profiles yet");
  });

  it("accepts the alternate truthy confirmations", () => {
    expect(resetState(false, "yes")).toContain("cleared");
    seedPersistedProfile();
    expect(resetState(false, 1)).toContain("cleared");
    seedPersistedProfile();
    expect(resetState(false, "true")).toContain("cleared");
  });

  it("does not clear on a false-ish confirmation", () => {
    expect(resetState(false, "no")).toContain("Reset NOT performed");
    expect(resetState(false, 0)).toContain("Reset NOT performed");
    expect(listProfiles()).toContain(testWallet.publicKey);
  });
});
