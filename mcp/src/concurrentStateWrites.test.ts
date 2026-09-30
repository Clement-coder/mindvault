/**
 * Regression tests for concurrent state writes (#591).
 *
 * MCP tool handlers are async and a client may have several in flight at once.
 * Several of them do a read-modify-write against the module-level `profiles`
 * map and then persist the whole map to `~/.mindvault/state.json`. The window
 * between the read and the write is not theoretical — `mindvault_import_wallet`
 * awaits a dynamic `import("@stellar/stellar-sdk")` and a `Keypair.fromSecret`
 * in the middle of exactly that sequence:
 *
 *     activeProfileName = target;        // ← read/modify
 *     …await…                            // ← another call runs here
 *     activeProfile().wallet = { … };    // ← modify, against whatever
 *     saveState();                       //   activeProfileName now says
 *
 * `STATE_MUTATING_TOOLS` + `stateMutex.runExclusive` in index.ts close that
 * window. These tests exist so that closing stays closed: they drive real
 * concurrent tool calls through `dispatchTool` and assert on the bytes that
 * land on disk, not on the mutex in isolation (`mutex.test.ts` covers the
 * primitive itself).
 *
 * The failure being guarded against is not a lost write — it is a *misdirected*
 * one. Interleaved calls do not drop a profile; they write one call's wallet
 * into another call's profile, which persists cleanly, reads back as valid
 * JSON, and hands the wrong agent a wallet. "Every profile is present" would
 * pass while that happened, so the assertions below check that each profile
 * holds the key that was actually meant for it.
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { Mutex } from "./mutex.js";

// Isolate HOME before importing index.js: STATE_DIR/STATE_FILE are resolved
// from homedir() at module load, so a later assignment would not be seen.
process.env.MINDVAULT_MOCK = "1";
process.env.STELLAR_NETWORK = "testnet";
const home = mkdtempSync(join(tmpdir(), "mindvault-mcp-concurrent-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

const { dispatchTool, _resetProfiles } = await import("./index.js");
const { Keypair } = await import("@stellar/stellar-sdk");

const STATE_FILE = join(home, ".mindvault", "state.json");

/** How many calls to overlap. Enough to interleave, small enough to stay fast. */
const CONCURRENCY = 12;

interface TestIdentity {
  profile: string;
  secretKey: string;
  publicKey: string;
}

/**
 * Distinct throwaway keypairs, one per concurrent call.
 *
 * Generated rather than inlined: these only need to be valid and mutually
 * distinct, and a committed `S…` literal reads like a leaked credential to
 * every scanner that meets it. Nothing here is ever funded or submitted.
 */
function makeIdentities(count: number, prefix: string): TestIdentity[] {
  return Array.from({ length: count }, (_, i) => {
    const keypair = Keypair.random();
    return {
      profile: `${prefix}-${i}`,
      secretKey: keypair.secret(),
      publicKey: keypair.publicKey(),
    };
  });
}

/** The persisted state file, parsed. Throws if it is missing or not JSON. */
function readPersistedState(): {
  version: number;
  activeProfile: string;
  profiles: Record<string, { wallet?: { publicKey: string; secretKey: string }; apiKey?: string }>;
} {
  return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
}

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  _resetProfiles();
  rmSync(STATE_FILE, { force: true });
});

describe("concurrent state writes (#591)", () => {
  it("persists every profile when imports overlap", async () => {
    const identities = makeIdentities(CONCURRENCY, "overlap");

    await Promise.all(
      identities.map((id) =>
        dispatchTool("mindvault_import_wallet", {
          secretKey: id.secretKey,
          profile: id.profile,
          persist: true,
        }),
      ),
    );

    const state = readPersistedState();
    expect(Object.keys(state.profiles).sort()).toEqual(identities.map((i) => i.profile).sort());
  });

  it("never writes one call's wallet into another call's profile", async () => {
    // The actual corruption mode. Without the mutex, `activeProfileName` is
    // reassigned by a later call while an earlier one is suspended on its
    // `await`, so the earlier call's wallet lands under the later call's name.
    const identities = makeIdentities(CONCURRENCY, "crosstalk");

    await Promise.all(
      identities.map((id) =>
        dispatchTool("mindvault_import_wallet", {
          secretKey: id.secretKey,
          profile: id.profile,
          persist: true,
        }),
      ),
    );

    const state = readPersistedState();
    for (const id of identities) {
      const wallet = state.profiles[id.profile]?.wallet;
      expect(wallet, `profile ${id.profile} has a wallet`).toBeDefined();
      expect(wallet?.secretKey, `profile ${id.profile} kept its own secret key`).toBe(id.secretKey);
      expect(wallet?.publicKey, `profile ${id.profile} kept its own address`).toBe(id.publicKey);
    }
  });

  it("keeps the state file parseable at every point during a concurrent run", async () => {
    // saveState writes through writeAtomically (temp file + rename), so a
    // reader must see either the old file or the new one and never a partial
    // one. Reading between every await of the in-flight batch is the closest a
    // single-process test can get to a concurrent reader.
    const identities = makeIdentities(CONCURRENCY, "atomic");
    const observations: number[] = [];

    const writes = Promise.all(
      identities.map((id) =>
        dispatchTool("mindvault_import_wallet", {
          secretKey: id.secretKey,
          profile: id.profile,
          persist: true,
        }),
      ),
    );

    for (let i = 0; i < 50; i++) {
      await Promise.resolve();
      try {
        // A miss is fine — the file may not exist yet. A malformed read is not.
        observations.push(Object.keys(readPersistedState().profiles).length);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }

    await writes;

    // The loop above is the assertion: a torn write would have thrown a
    // SyntaxError out of `readPersistedState` and failed the test. Check the
    // loop was not vacuous — it has to have caught the file mid-run — and that
    // every profile still arrived once the batch drained.
    expect(observations.length).toBeGreaterThan(0);
    expect(Object.keys(readPersistedState().profiles).sort()).toEqual(
      identities.map((i) => i.profile).sort(),
    );
  });

  it("preserves 0600 on the state file across concurrent writes", async () => {
    const identities = makeIdentities(CONCURRENCY, "perms");

    await Promise.all(
      identities.map((id) =>
        dispatchTool("mindvault_import_wallet", {
          secretKey: id.secretKey,
          profile: id.profile,
          persist: true,
        }),
      ),
    );

    // The file holds wallet secret keys; a concurrent rewrite must not widen it.
    expect(statSync(STATE_FILE).mode & 0o777).toBe(0o600);
  });

  it("releases the lock when a mutating call fails, so later calls still land", async () => {
    // A rejected critical section that forgot to release would deadlock every
    // subsequent state-mutating tool — the server would look hung rather than
    // broken, which is the harder failure to diagnose.
    const good = makeIdentities(4, "after-failure");

    const results = await Promise.allSettled([
      dispatchTool("mindvault_import_wallet", { secretKey: "not-a-stellar-key", persist: true }),
      ...good.map((id) =>
        dispatchTool("mindvault_import_wallet", {
          secretKey: id.secretKey,
          profile: id.profile,
          persist: true,
        }),
      ),
    ]);

    expect(results[0].status).toBe("rejected");
    for (const result of results.slice(1)) {
      expect(result.status).toBe("fulfilled");
    }
    const state = readPersistedState();
    for (const id of good) {
      expect(state.profiles[id.profile]?.wallet?.publicKey).toBe(id.publicKey);
    }
  });

  it("lets read-only tools run alongside mutations without disturbing them", async () => {
    // Read-only tools are deliberately outside STATE_MUTATING_TOOLS so they do
    // not queue behind a slow write. This pins that the exemption is safe:
    // interleaving reads must not cost the writers any of their updates.
    const identities = makeIdentities(CONCURRENCY, "with-reads");

    await Promise.all([
      ...identities.map((id) =>
        dispatchTool("mindvault_import_wallet", {
          secretKey: id.secretKey,
          profile: id.profile,
          persist: true,
        }),
      ),
      ...Array.from({ length: CONCURRENCY }, () => dispatchTool("mindvault_list_profiles", {})),
    ]);

    const state = readPersistedState();
    for (const id of identities) {
      expect(state.profiles[id.profile]?.wallet?.secretKey).toBe(id.secretKey);
    }
  });

  it("survives a state file the previous run left read-only", async () => {
    // A stray chmod (or a restore from a backup tool) must not turn every
    // subsequent concurrent write into an unhandled rejection: saveState logs
    // and continues, so the tool calls themselves still resolve.
    const seed = makeIdentities(1, "seed")[0];
    await dispatchTool("mindvault_import_wallet", {
      secretKey: seed.secretKey,
      profile: seed.profile,
      persist: true,
    });
    chmodSync(STATE_FILE, 0o400);

    const identities = makeIdentities(4, "readonly-file");
    const results = await Promise.allSettled(
      identities.map((id) =>
        dispatchTool("mindvault_import_wallet", {
          secretKey: id.secretKey,
          profile: id.profile,
          persist: true,
        }),
      ),
    );

    for (const result of results) {
      expect(result.status).toBe("fulfilled");
    }
    chmodSync(STATE_FILE, 0o600);
  });
});

describe("why the state mutex is load-bearing (#591)", () => {
  // These two model the exact read-modify-write shape of importWallet against a
  // local mirror of the state. They are the control for the tests above: if the
  // mutex were removed from index.ts, the misdirected-wallet assertion would
  // start failing, and this pair shows precisely which interleaving does it:
  // every suspended body resumes against the *last* writer's `activeProfileName`.
  //
  // The interleaving is forced with explicit microtask yields rather than
  // timers, so the ordering is deterministic and these cannot flake.

  interface Mirror {
    active: string;
    profiles: Record<string, string>;
  }

  /** importWallet's shape: pick the profile, suspend, then write to it. */
  async function importInto(mirror: Mirror, profile: string, value: string): Promise<void> {
    mirror.active = profile;
    await Promise.resolve(); // stands in for `await import("@stellar/stellar-sdk")`
    mirror.profiles[mirror.active] = value;
  }

  it("writes into the wrong profile without serialization", async () => {
    const mirror: Mirror = { active: "default", profiles: {} };

    await Promise.all([
      importInto(mirror, "alice", "alice-key"),
      importInto(mirror, "bob", "bob-key"),
    ]);

    // Both bodies run up to their await before either resumes, so both resume
    // with `active` reading "bob": alice's key is written under bob's name,
    // then bob's key overwrites it. Two successful calls, no error raised, and
    // alice ends up with no entry at all.
    expect(mirror.profiles).toEqual({ bob: "bob-key" });
    expect(mirror.profiles.alice).toBeUndefined();
  });

  it("assigns each profile its own value when serialized", async () => {
    const mirror: Mirror = { active: "default", profiles: {} };
    const mutex = new Mutex();

    await Promise.all([
      mutex.runExclusive(() => importInto(mirror, "alice", "alice-key")),
      mutex.runExclusive(() => importInto(mirror, "bob", "bob-key")),
    ]);

    expect(mirror.profiles).toEqual({ alice: "alice-key", bob: "bob-key" });
  });
});
