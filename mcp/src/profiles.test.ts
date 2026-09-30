import { describe, it, expect } from "vitest";
import {
  DEFAULT_PROFILE,
  STATE_VERSION,
  exportAllProfiles,
  exportProfile,
  isValidProfileName,
  isValidWallet,
  migrateState,
  normalizeProfiles,
} from "./profiles.js";

const wallet = { publicKey: "GABC", secretKey: "SABC" };

describe("isValidWallet", () => {
  it("accepts a wallet with both keys", () => {
    expect(isValidWallet(wallet)).toBe(true);
  });
  it("rejects partial or malformed wallets", () => {
    expect(isValidWallet({ publicKey: "GABC" })).toBe(false);
    expect(isValidWallet({ publicKey: "GABC", secretKey: "" })).toBe(false);
    expect(isValidWallet(null)).toBe(false);
    expect(isValidWallet("nope")).toBe(false);
  });
});

describe("isValidProfileName", () => {
  it("accepts safe names", () => {
    for (const name of ["default", "testnet", "main-net", "buyer_1", "a.b", "A".repeat(64)]) {
      expect(isValidProfileName(name)).toBe(true);
    }
  });
  it("rejects empty, oversized, or unsafe names", () => {
    for (const name of ["", "a".repeat(65), "has space", "slash/name", 'quote"', 42, null]) {
      expect(isValidProfileName(name)).toBe(false);
    }
  });
});

describe("normalizeProfiles", () => {
  it("keeps valid wallet/apiKey fields and drops junk", () => {
    const out = normalizeProfiles({
      testnet: { wallet, apiKey: "key-1", network: "testnet", extra: "ignored" },
      empty: {},
      "bad name": { wallet },
      broken: { wallet: { publicKey: "GABC" } },
    });
    expect(out).toEqual({
      testnet: { wallet, apiKey: "key-1", network: "testnet" },
      empty: {},
      broken: {},
    });
    expect(out["bad name"]).toBeUndefined();
  });
  it("returns an empty object for non-objects", () => {
    expect(normalizeProfiles(null)).toEqual({});
    expect(normalizeProfiles("x")).toEqual({});
  });
});

describe("migrateState", () => {
  it("migrates legacy single-wallet state into the default profile", () => {
    const { state, migrated } = migrateState({ wallet, apiKey: "legacy-key" });
    expect(migrated).toBe(true);
    expect(state).toEqual({
      version: STATE_VERSION,
      activeProfile: DEFAULT_PROFILE,
      profiles: { [DEFAULT_PROFILE]: { wallet, apiKey: "legacy-key" } },
    });
  });

  it("migrates a legacy wallet even without an apiKey", () => {
    const { state, migrated } = migrateState({ wallet });
    expect(migrated).toBe(true);
    expect(state.profiles[DEFAULT_PROFILE]).toEqual({ wallet });
  });

  it("passes through current multi-profile state without migrating", () => {
    const input = {
      version: STATE_VERSION,
      activeProfile: "publisher",
      profiles: {
        publisher: { wallet, apiKey: "pk" },
        buyer: { wallet: { publicKey: "GBUY", secretKey: "SBUY" } },
      },
    };
    const { state, migrated } = migrateState(input);
    expect(migrated).toBe(false);
    expect(state.activeProfile).toBe("publisher");
    expect(Object.keys(state.profiles).sort()).toEqual(["buyer", "publisher"]);
  });

  it("falls back to the first profile when activeProfile is unknown", () => {
    const { state } = migrateState({
      activeProfile: "ghost",
      profiles: { alpha: { wallet } },
    });
    expect(state.activeProfile).toBe("alpha");
  });

  it("falls back to default when there are no profiles", () => {
    const { state } = migrateState({ profiles: {} });
    expect(state.activeProfile).toBe(DEFAULT_PROFILE);
    expect(state.profiles).toEqual({});
  });

  it("returns an empty state for corrupted or empty input", () => {
    for (const raw of [null, undefined, 42, "junk", {}, { wallet: { publicKey: "GABC" } }]) {
      const { state, migrated } = migrateState(raw);
      expect(migrated).toBe(false);
      expect(state).toEqual({
        version: STATE_VERSION,
        activeProfile: DEFAULT_PROFILE,
        profiles: {},
      });
    }
  });
});

describe("migrateState rollback (#601)", () => {
  const legacy = {
    wallet,
    apiKey: "legacy-key",
    extraField: "kept-out-of-state-but-preserved",
  };

  it("returns the raw legacy input as the rollback source when migrated", () => {
    const { state, migrated, legacy: rollback } = migrateState(legacy);
    expect(migrated).toBe(true);
    expect(rollback).toBeDefined();
    expect(rollback).toEqual(legacy);
    expect(state.profiles[DEFAULT_PROFILE]).toEqual({ wallet, apiKey: "legacy-key" });
  });

  it("rolls back by feeding the preserved legacy straight back into the store", () => {
    const first = migrateState(legacy);
    // The rollback step: re-persisting `legacy` restores the exact original
    // object, and migrating it a second time reproduces the identical state.
    const second = migrateState(first.legacy);
    expect(second.migrated).toBe(true);
    expect(second.legacy).toEqual(legacy);
    expect(second.state).toEqual(first.state);
  });

  it("does not attach a rollback source when nothing was migrated", () => {
    const current = {
      version: STATE_VERSION,
      activeProfile: "publisher",
      profiles: { publisher: { wallet, apiKey: "pk" } },
    };
    const { migrated, legacy: rollback } = migrateState(current);
    expect(migrated).toBe(false);
    expect(rollback).toBeUndefined();
  });

  it("is re-entrant: migrating the migrated state is a stable no-op", () => {
    const first = migrateState(legacy);
    expect(first.migrated).toBe(true);
    const again = migrateState(first.state);
    expect(again.migrated).toBe(false);
    expect(again.state).toEqual(first.state);
    // The profiles object is not re-folded into a nested default profile.
    expect(again.state.profiles[DEFAULT_PROFILE]).toEqual(first.state.profiles[DEFAULT_PROFILE]);
  });
});

describe("exportProfile", () => {
  it("exports a profile with secrets redacted", () => {
    const profile = {
      wallet: { publicKey: "GABC123", secretKey: "SSECRETKEY123" },
      apiKey: "sk_live_abc123",
    };
    const exported = exportProfile("testnet", profile);
    expect(exported).toEqual({
      name: "testnet",
      address: "GABC123",
      registered: true,
    });
  });

  it("handles a profile with no wallet", () => {
    const exported = exportProfile("empty", {});
    expect(exported).toEqual({
      name: "empty",
      address: null,
      registered: false,
    });
  });

  it("never exposes secretKey in the exported object", () => {
    const profile = {
      wallet: { publicKey: "GABC123", secretKey: "SSECRETKEY123" },
      apiKey: "sk_live_abc123",
    };
    const exported = exportProfile("testnet", profile);
    const json = JSON.stringify(exported);
    expect(json).not.toContain("SSECRETKEY123");
    expect(json).not.toContain("sk_live_abc123");
  });
});

describe("exportAllProfiles", () => {
  it("exports all profiles sorted by name", () => {
    const state = {
      version: STATE_VERSION,
      activeProfile: "beta",
      profiles: {
        beta: { wallet: { publicKey: "GBETA", secretKey: "SBETA" }, apiKey: "key-beta" },
        alpha: { wallet: { publicKey: "GALPHA", secretKey: "SALPHA" } },
      },
    };
    const exported = exportAllProfiles(state);
    expect(exported.map((p) => p.name)).toEqual(["alpha", "beta"]);
    expect(exported[0]).toEqual({ name: "alpha", address: "GALPHA", registered: false });
    expect(exported[1]).toEqual({ name: "beta", address: "GBETA", registered: true });
  });

  it("returns an empty array for empty profiles", () => {
    const state = {
      version: STATE_VERSION,
      activeProfile: DEFAULT_PROFILE,
      profiles: {},
    };
    expect(exportAllProfiles(state)).toEqual([]);
  });
});
