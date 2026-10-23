import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createCipheriv, randomBytes, scryptSync } from "crypto";
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
  validateBackupProfiles,
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
    expect(() =>
      restoreState(
        blob,
        PASS,
        () => {
          wrote = true;
        },
        { expectedNetwork: "stellar:pubnet" },
      ),
    ).toThrow(/belongs to network/);
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

describe("validateBackupProfiles (#1047)", () => {
  it("returns valid for a well-formed multi-profile object", () => {
    const result = validateBackupProfiles({
      version: 1,
      activeProfile: "default",
      profiles: {
        default: { wallet: { publicKey: "GPUB", secretKey: "SSECRET" } },
        buyer: { wallet: { publicKey: "GBUY", secretKey: "SBUY" } },
      },
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("returns valid when profiles is absent (empty state)", () => {
    expect(validateBackupProfiles({ version: 1, activeProfile: "default" }).valid).toBe(true);
    expect(validateBackupProfiles({}).valid).toBe(true);
    expect(validateBackupProfiles(null).valid).toBe(true);
  });

  it("returns valid for an explicitly empty profiles object", () => {
    expect(validateBackupProfiles({ profiles: {} }).valid).toBe(true);
  });

  it("rejects when profiles is a non-object type (array)", () => {
    const result = validateBackupProfiles({ profiles: ["default", "buyer"] });
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe("profiles");
    expect(result.errors[0].message).toMatch(/plain object/);
  });

  it("rejects when profiles is a string", () => {
    const result = validateBackupProfiles({ profiles: "bad" });
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe("profiles");
  });

  it("rejects a profile name that fails the pattern (spaces)", () => {
    const result = validateBackupProfiles({ profiles: { "bad name": {} } });
    expect(result.valid).toBe(false);
    const err = result.errors.find((e) => e.field === "profiles.bad name");
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/valid profile name/);
  });

  it("rejects a profile name that is too long (65 chars)", () => {
    const longName = "a".repeat(65);
    const result = validateBackupProfiles({ profiles: { [longName]: {} } });
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe(`profiles.${longName}`);
  });

  it("rejects profile names that are case-insensitive duplicates", () => {
    const result = validateBackupProfiles({
      profiles: {
        default: {},
        Default: {},
      },
    });
    expect(result.valid).toBe(false);
    const err = result.errors.find((e) => e.field === "profiles.Default");
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/conflicts with.*default/i);
    expect(err!.message).toMatch(/case-insensitive duplicate/);
  });

  it("rejects multiple case-insensitive conflicts in a single pass", () => {
    const result = validateBackupProfiles({
      profiles: {
        alice: {},
        Alice: {},
        ALICE: {},
        bob: {},
        Bob: {},
      },
    });
    expect(result.valid).toBe(false);
    // Two collisions on alice/Alice/ALICE, one on bob/Bob.
    const aliceErrors = result.errors.filter((e) => e.field.toLowerCase().includes("alice"));
    const bobErrors = result.errors.filter((e) => e.field.toLowerCase().includes("bob"));
    expect(aliceErrors.length).toBeGreaterThanOrEqual(1);
    expect(bobErrors.length).toBeGreaterThanOrEqual(1);
  });

  it("collects multiple distinct errors for different problems", () => {
    const result = validateBackupProfiles({
      profiles: {
        "bad name": {},
        default: {},
        Default: {},
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe("restoreState rejects duplicate/conflicting profile identifiers (#1047)", () => {
  const STATE_DIR = join(homedir(), ".mindvault");
  const STATE_FILE = join(STATE_DIR, "state.json");
  const PASS = "test-passphrase-ok";

  const initial: ProfileState = {
    version: STATE_VERSION,
    activeProfile: "default",
    profiles: {
      default: {
        wallet: { publicKey: "GORIGINAL", secretKey: "SORIGINAL" },
      },
    },
  };

  beforeEach(() => {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(initial, null, 2), { mode: 0o600 });
  });

  afterEach(() => {
    if (existsSync(STATE_FILE)) rmSync(STATE_FILE);
  });

  /**
   * Build a backup blob that contains a hand-crafted payload, bypassing the
   * normal exportState path so we can inject arbitrary profile structures.
   */
  function buildBlobFromPayload(payload: unknown): string {
    const SCRYPT_N = 1 << 14;
    const SCRYPT_R = 8;
    const SCRYPT_P = 1;
    const SCRYPT_MAXMEM = 64 * 1024 * 1024;
    const KEY_LEN = 32;
    const SALT_LEN = 16;
    const NONCE_LEN = 12;
    const salt = randomBytes(SALT_LEN);
    const nonce = randomBytes(NONCE_LEN);
    const key = scryptSync(PASS, salt, KEY_LEN, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAXMEM,
    });
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const data = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const blob = Buffer.concat([data, tag]);
    return `v1:${salt.toString("base64")}:${nonce.toString("base64")}:${blob.toString("base64")}`;
  }

  it("rejects a backup with case-insensitive duplicate profile IDs, leaving state file unchanged", () => {
    const maliciousBlob = buildBlobFromPayload({
      version: 1,
      activeProfile: "default",
      profiles: {
        default: { wallet: { publicKey: "GNEW", secretKey: "SNEW" } },
        Default: { wallet: { publicKey: "GNEW2", secretKey: "SNEW2" } },
      },
    });

    let wrote = false;
    expect(() =>
      restoreState(maliciousBlob, PASS, () => {
        wrote = true;
      }),
    ).toThrow(StateBackupError);
    expect(wrote).toBe(false);

    // Disk state must be untouched.
    const ondisk = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    expect(ondisk.profiles.default.wallet.publicKey).toBe("GORIGINAL");
  });

  it("includes field-level information in the error message", () => {
    const blob = buildBlobFromPayload({
      version: 1,
      activeProfile: "default",
      profiles: {
        publisher: {},
        Publisher: {},
      },
    });

    let errorMsg = "";
    try {
      restoreState(blob, PASS, () => {});
    } catch (err) {
      errorMsg = (err as Error).message;
    }
    expect(errorMsg).toContain("profiles.Publisher");
    expect(errorMsg).toMatch(/conflicts with.*publisher/i);
  });

  it("rejects a backup whose profiles value is not an object", () => {
    const blob = buildBlobFromPayload({
      version: 1,
      activeProfile: "default",
      profiles: ["default", "buyer"],
    });

    let wrote = false;
    expect(() =>
      restoreState(blob, PASS, () => {
        wrote = true;
      }),
    ).toThrow(StateBackupError);
    expect(wrote).toBe(false);

    const ondisk = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    expect(ondisk.profiles.default.wallet.publicKey).toBe("GORIGINAL");
  });

  it("accepts a valid multi-profile backup with distinct case-insensitive names", () => {
    const blob = buildBlobFromPayload({
      version: 1,
      activeProfile: "publisher",
      profiles: {
        publisher: { wallet: { publicKey: "GPUB", secretKey: "SPUB" }, apiKey: "key-1" },
        buyer: { wallet: { publicKey: "GBUY", secretKey: "SBUY" } },
        staging: { network: "testnet" },
      },
    });

    let restored: ProfileState | null = null;
    const msg = restoreState(blob, PASS, (s) => {
      restored = s;
    });
    expect(restored).not.toBeNull();
    expect(msg).toContain("3 profile");
    expect(msg).toContain("publisher");
  });
});
