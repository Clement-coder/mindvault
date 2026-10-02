import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import {
  chmodSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  statSync,
  mkdtempSync,
} from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";
import {
  exportState,
  exportStateFile,
  restoreState,
  StateBackupError,
  readPersistedState,
  checkStatePermissions,
  scanPersistedStateSecrets,
  quarantineStateFile,
  preserveLegacyState,
  writeAtomically,
} from "./stateBackup.js";
import { STATE_VERSION, type ProfileState } from "./profiles.js";

const STATE_DIR = join(homedir(), ".mindvault");
const STATE_FILE = join(STATE_DIR, "state.json");
const PASS = "test-passphrase-ok";

const sample: ProfileState = {
  version: STATE_VERSION,
  activeProfile: "publisher",
  profiles: {
    publisher: {
      wallet: { publicKey: "GPUB", secretKey: "SSECRET" },
      apiKey: "api-key-xyz",
      network: "stellar:testnet",
    },
    buyer: {
      wallet: { publicKey: "GBUY", secretKey: "SBUY" },
    },
  },
};

function writeState(state: ProfileState = sample): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

describe("stateBackup", () => {
  const original = existsSync(STATE_FILE) ? readFileSync(STATE_FILE, "utf-8") : null;

  beforeEach(() => {
    writeState();
  });

  afterEach(() => {
    if (original !== null) {
      writeFileSync(STATE_FILE, original, { mode: 0o600 });
    } else if (existsSync(STATE_FILE)) {
      rmSync(STATE_FILE);
    }
  });

  it("exportState rejects short passphrases", () => {
    expect(() => exportState("short")).toThrow(StateBackupError);
    expect(() => exportState("short")).toThrow(/at least 8/);
  });

  it("exportState fails when state file is missing", () => {
    rmSync(STATE_FILE);
    expect(() => exportState(PASS)).toThrow(/No state file/);
  });

  it("exportState never leaks plaintext secrets", () => {
    const blob = exportState(PASS);
    expect(blob.startsWith("v1:")).toBe(true);
    expect(blob).not.toContain("SSECRET");
    expect(blob).not.toContain("SBUY");
    expect(blob).not.toContain("api-key-xyz");
    expect(blob).not.toContain("GPUB");
  });

  it("exports a private encrypted recovery file", () => {
    const directory = mkdtempSync(join(tmpdir(), "mindvault-backup-"));
    const path = exportStateFile(PASS, new Date("2026-01-02T03:04:05.000Z"), directory);
    const contents = readFileSync(path, "utf8");
    expect(path).toContain("state-2026-01-02T03-04-05-000Z.backup");
    expect(contents).toMatch(/^v1:/);
    expect(contents).not.toContain("SSECRET");
    expect(statSync(path).mode & 0o7777).toBe(0o600);
    rmSync(path);
  });

  it("identifies secrets before an unencrypted persisted-state backup is shared", () => {
    expect(scanPersistedStateSecrets(sample)).toEqual([
      { path: "profiles.publisher.wallet.secretKey", kind: "wallet-secret-key" },
      { path: "profiles.publisher.apiKey", kind: "api-key" },
      { path: "profiles.buyer.wallet.secretKey", kind: "wallet-secret-key" },
    ]);
    expect(scanPersistedStateSecrets({ profiles: { empty: {} } })).toEqual([]);
  });

  it("round-trips export → restore with same passphrase", () => {
    const blob = exportState(PASS);
    let restored: ProfileState | null = null;
    const msg = restoreState(blob, PASS, (s) => {
      restored = s;
    });
    expect(msg).toContain("2 profile");
    expect(msg).toContain("publisher");
    expect(restored).toEqual(sample);
  });

  it("restore rejects wrong passphrase without calling write", () => {
    const blob = exportState(PASS);
    let wrote = false;
    expect(() =>
      restoreState(blob, "wrong-passphrase", () => {
        wrote = true;
      }),
    ).toThrow(/integrity check failed/);
    expect(wrote).toBe(false);
  });

  it("rejects a backup bound to another network before writing", () => {
    const blob = exportState(PASS);
    let wrote = false;
    expect(() => restoreState(blob, PASS, () => { wrote = true; }, { expectedNetwork: "stellar:pubnet" }))
      .toThrow(/belongs to network/);
    expect(wrote).toBe(false);
  });

  it("restore rejects tampered blob without calling write", () => {
    const blob = exportState(PASS);
    const parts = blob.split(":");
    // flip last char of ciphertext
    const last = parts[3];
    const flipped = last.slice(0, -1) + (last.endsWith("A") ? "B" : "A");
    const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${flipped}`;
    let wrote = false;
    expect(() =>
      restoreState(tampered, PASS, () => {
        wrote = true;
      }),
    ).toThrow(StateBackupError);
    expect(wrote).toBe(false);
  });

  it("restore rejects invalid format", () => {
    expect(() => restoreState("not-a-blob", PASS, () => {})).toThrow(/Invalid backup format/);
    expect(() => restoreState("v2:a:b:c", PASS, () => {})).toThrow(/Invalid backup format/);
  });

  it("readPersistedState returns normalized profiles", () => {
    const state = readPersistedState();
    expect(state.activeProfile).toBe("publisher");
    expect(state.profiles.publisher?.wallet?.secretKey).toBe("SSECRET");
    expect(state.profiles.buyer?.wallet?.publicKey).toBe("GBUY");
  });
});

describe("writeAtomically", () => {
  const STATE_DIR = join(homedir(), ".mindvault");
  const STATE_FILE = join(STATE_DIR, "state.json");

  beforeEach(() => {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({ old: true }, null, 2), { mode: 0o600 });
  });

  afterEach(() => {
    if (existsSync(STATE_FILE)) rmSync(STATE_FILE);
    vi.restoreAllMocks();
  });

  it("writes to a temp file in the same directory and keeps the destination at 0600", () => {
    writeAtomically(STATE_FILE, JSON.stringify({ ok: true }, null, 2), 0o600);
    expect(JSON.parse(readFileSync(STATE_FILE, "utf-8"))).toEqual({ ok: true });
    expect(statSync(STATE_FILE).mode & 0o7777).toBe(0o600);
    expect(existsSync(`${STATE_FILE}.tmp`)).toBe(false);
  });

  it("does not leave the destination partially written when rename fails", () => {
    const failure = new Error("rename failed");
    expect(() =>
      writeAtomically(STATE_FILE, '{"new": true}', 0o600, {
        writeFileSync: fs.writeFileSync,
        renameSync: () => {
          throw failure;
        },
        chmodSync: fs.chmodSync,
        existsSync: fs.existsSync,
        unlinkSync: fs.unlinkSync,
      }),
    ).toThrow(/rename failed/);

    expect(readFileSync(STATE_FILE, "utf-8")).toContain("old");
    const tmpMatches = fs
      .readdirSync(STATE_DIR)
      .filter((name) => name.startsWith("state.json.tmp"));
    expect(tmpMatches).toEqual([]);
  });
});

describe("checkStatePermissions", () => {
  const STATE_DIR = join(homedir(), ".mindvault");
  const STATE_FILE = join(STATE_DIR, "state.json");

  beforeEach(() => {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(
      STATE_FILE,
      JSON.stringify({ version: 1, activeProfile: "default", profiles: {} }),
      {
        mode: 0o600,
      },
    );
  });

  afterEach(() => {
    if (existsSync(STATE_FILE)) rmSync(STATE_FILE);
  });

  it("reports safe when mode is 0600", () => {
    const result = checkStatePermissions();
    expect(result.exists).toBe(true);
    expect(result.isSafe).toBe(true);
    expect(result.mode).toBe("0600");
    expect(result.message).toContain("safe");
  });

  it("reports unsafe when mode is 0644 (world-readable)", () => {
    chmodSync(STATE_FILE, 0o644);
    const result = checkStatePermissions();
    expect(result.exists).toBe(true);
    expect(result.isSafe).toBe(false);
    expect(result.mode).toBe("0644");
    expect(result.message).toContain("UNSAFE");
    expect(result.message).toContain("world-readable");
    expect(result.message).toContain("chmod 0600");
  });

  it("reports unsafe when mode is 0666 (world-readable and writable)", () => {
    chmodSync(STATE_FILE, 0o666);
    const result = checkStatePermissions();
    expect(result.exists).toBe(true);
    expect(result.isSafe).toBe(false);
    expect(result.message).toContain("UNSAFE");
    expect(result.message).toContain("world-readable");
    expect(result.message).toContain("world-writable");
  });

  it("reports safe when file does not exist", () => {
    rmSync(STATE_FILE);
    const result = checkStatePermissions();
    expect(result.exists).toBe(false);
    expect(result.isSafe).toBe(true);
    expect(result.message).toContain("does not exist");
  });
});

describe("corrupted state file quarantine (#600)", () => {
  const STATE_DIR = join(homedir(), ".mindvault");
  const STATE_FILE = join(STATE_DIR, "state.json");

  beforeEach(() => {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, '{"version": 1, "brok' + "en", { mode: 0o600 });
  });

  afterEach(() => {
    if (existsSync(STATE_FILE)) rmSync(STATE_FILE);
    if (existsSync(`${STATE_FILE}.corrupt-1234567890`)) {
      rmSync(`${STATE_FILE}.corrupt-1234567890`);
    }
  });

  it("moves the corrupt file aside so evidence survives and the live path is clean", () => {
    const quarantined = quarantineStateFile(STATE_FILE, 1234567890);
    expect(quarantined).toBe(`${STATE_FILE}.corrupt-1234567890`);
    expect(existsSync(STATE_FILE)).toBe(false);
    expect(existsSync(quarantined)).toBe(true);
    expect(readFileSync(quarantined, "utf-8")).toBe('{"version": 1, "brok' + "en");
  });

  it("preserves the original permissions (0600) of a secret-bearing file", () => {
    const quarantined = quarantineStateFile(STATE_FILE, 1234567890);
    expect(statSync(quarantined).mode & 0o7777).toBe(0o600);
  });

  it("throws a deterministic error when there is nothing to quarantine", () => {
    rmSync(STATE_FILE);
    expect(() => quarantineStateFile(STATE_FILE, 1234567890)).toThrow(StateBackupError);
  });
});

describe("legacy state preservation (#601)", () => {
  const STATE_DIR = join(homedir(), ".mindvault");
  const STATE_FILE = join(STATE_DIR, "state.json");
  const LEGACY_FILE = `${STATE_FILE}.legacy`;
  const legacy = { wallet: { publicKey: "GPUB", secretKey: "SSECRET" }, apiKey: "legacy-key" };

  beforeEach(() => {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(
      STATE_FILE,
      JSON.stringify({ version: 1, activeProfile: "default", profiles: {} }),
      {
        mode: 0o600,
      },
    );
  });

  afterEach(() => {
    if (existsSync(STATE_FILE)) rmSync(STATE_FILE);
    if (existsSync(LEGACY_FILE)) rmSync(LEGACY_FILE);
  });

  it("snapshots the un-migrated legacy object before the current format replaces it", () => {
    preserveLegacyState(legacy);
    expect(existsSync(LEGACY_FILE)).toBe(true);
    expect(JSON.parse(readFileSync(LEGACY_FILE, "utf-8"))).toEqual(legacy);
  });

  it("writes the legacy snapshot with mode 0600 like the state file itself", () => {
    preserveLegacyState(legacy);
    expect(statSync(LEGACY_FILE).mode & 0o7777).toBe(0o600);
  });
});
