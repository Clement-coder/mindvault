/**
 * Profile-scoped purchase history filtering (#584).
 *
 * An agent that switches between a buyer profile and a publisher profile had
 * one undifferentiated purchase list. The interesting cases are at the edges:
 * receipts written before the field existed, and what a profile filter should
 * do about them.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PURCHASE_HISTORY_VERSION,
  PurchaseHistoryError,
  UNSCOPED_PROFILE,
  _setPurchasesFilePath,
  formatPurchaseHistory,
  listPurchases,
  loadPurchaseHistory,
  normalizePurchaseHistoryFilter,
  profileOf,
  purchaseHistoryTool,
  purchaseProfiles,
  recordPurchase,
  type PurchaseReceipt,
} from "./purchaseHistory.js";

let directory: string;
let file: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "mv-purchases-"));
  file = join(directory, "purchases.json");
  _setPurchasesFilePath(file);
});

afterEach(() => {
  _setPurchasesFilePath(null);
  rmSync(directory, { recursive: true, force: true });
});

function buy(resourceId: string, profile: string | undefined, timestamp: string) {
  return recordPurchase({
    resourceId,
    amount: "1.5",
    network: "stellar:testnet",
    txHash: null,
    receiptRef: null,
    timestamp,
    ...(profile ? { profile } : {}),
  });
}

/** Write a store directly, to simulate receipts from an older build. */
function seedLegacy(purchases: Partial<PurchaseReceipt>[]) {
  writeFileSync(
    file,
    JSON.stringify({
      version: PURCHASE_HISTORY_VERSION,
      purchases: purchases.map((p) => ({
        resourceId: "legacy",
        amount: "1",
        network: "stellar:testnet",
        txHash: null,
        receiptRef: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        ...p,
      })),
    }),
    "utf-8",
  );
}

describe("recording the profile", () => {
  it("stores the profile a purchase was made under", () => {
    const receipt = buy("res-1", "buyer.alice", "2026-01-01T00:00:00.000Z");

    expect(receipt.profile).toBe("buyer.alice");
  });

  it("persists it", () => {
    buy("res-1", "buyer.alice", "2026-01-01T00:00:00.000Z");

    expect(loadPurchaseHistory().purchases[0].profile).toBe("buyer.alice");
  });

  it("omits the field when no profile is supplied", () => {
    const receipt = buy("res-1", undefined, "2026-01-01T00:00:00.000Z");

    expect(receipt).not.toHaveProperty("profile");
  });

  it("keeps receipts from different profiles side by side", () => {
    buy("res-1", "buyer.alice", "2026-01-01T00:00:00.000Z");
    buy("res-2", "publisher", "2026-01-02T00:00:00.000Z");

    expect(listPurchases()).toHaveLength(2);
  });
});

describe("profileOf", () => {
  it("returns the recorded profile", () => {
    expect(profileOf({ profile: "buyer.alice" } as PurchaseReceipt)).toBe("buyer.alice");
  });

  it("reports a receipt with no profile as unscoped", () => {
    // Attributing it to whichever profile is active now would put a purchase
    // in the wrong account's history; the wallet that paid is unrecoverable.
    expect(profileOf({} as PurchaseReceipt)).toBe(UNSCOPED_PROFILE);
  });
});

describe("filtering by profile", () => {
  beforeEach(() => {
    buy("res-1", "buyer.alice", "2026-01-01T00:00:00.000Z");
    buy("res-2", "buyer.alice", "2026-01-02T00:00:00.000Z");
    buy("res-3", "publisher", "2026-01-03T00:00:00.000Z");
  });

  it("returns everything with no filter", () => {
    expect(listPurchases()).toHaveLength(3);
  });

  it("returns only the named profile's receipts", () => {
    const receipts = listPurchases({ profile: "buyer.alice" });

    expect(receipts.map((r) => r.resourceId).sort()).toEqual(["res-1", "res-2"]);
  });

  it("matches exactly and case-sensitively", () => {
    expect(listPurchases({ profile: "Buyer.Alice" })).toHaveLength(0);
  });

  it("returns nothing for a profile that bought nothing", () => {
    expect(listPurchases({ profile: "nobody" })).toHaveLength(0);
  });

  it("keeps the newest-first ordering", () => {
    const receipts = listPurchases({ profile: "buyer.alice" });

    expect(receipts.map((r) => r.resourceId)).toEqual(["res-2", "res-1"]);
  });

  it("combines with the resource filter", () => {
    expect(listPurchases({ profile: "buyer.alice", resourceId: "res-1" })).toHaveLength(1);
  });

  it("combines with the network filter", () => {
    expect(listPurchases({ profile: "buyer.alice", network: "stellar:pubnet" })).toHaveLength(0);
  });

  it("intersects rather than unions", () => {
    // res-3 belongs to publisher, so scoping to buyer.alice must exclude it
    // even though the resource filter matches.
    expect(listPurchases({ profile: "buyer.alice", resourceId: "res-3" })).toHaveLength(0);
  });
});

describe("receipts written before profiles were tracked", () => {
  beforeEach(() => {
    seedLegacy([{ resourceId: "old-1" }, { resourceId: "new-1", profile: "buyer.alice" }]);
  });

  it("still loads them", () => {
    expect(loadPurchaseHistory().purchases).toHaveLength(2);
  });

  it("lists them when no profile filter is given", () => {
    expect(listPurchases()).toHaveLength(2);
  });

  it("excludes them from a specific profile's history", () => {
    // They predate the field; claiming they belong to buyer.alice would be a
    // guess presented as a fact.
    expect(listPurchases({ profile: "buyer.alice" }).map((r) => r.resourceId)).toEqual(["new-1"]);
  });

  it("finds them under the unscoped sentinel", () => {
    const receipts = listPurchases({ profile: UNSCOPED_PROFILE });

    expect(receipts.map((r) => r.resourceId)).toEqual(["old-1"]);
  });

  it("rejects a stored profile that is not a string", () => {
    seedLegacy([{ resourceId: "bad", profile: 42 as never }]);

    // The receipt validator drops it rather than surfacing a malformed record.
    expect(loadPurchaseHistory().purchases).toHaveLength(0);
  });
});

describe("purchaseProfiles", () => {
  it("is empty for an empty store", () => {
    expect(purchaseProfiles()).toEqual([]);
  });

  it("lists each profile once, sorted", () => {
    buy("res-1", "publisher", "2026-01-01T00:00:00.000Z");
    buy("res-2", "buyer.alice", "2026-01-02T00:00:00.000Z");
    buy("res-3", "buyer.alice", "2026-01-03T00:00:00.000Z");

    expect(purchaseProfiles()).toEqual(["buyer.alice", "publisher"]);
  });

  it("includes the unscoped bucket when legacy receipts exist", () => {
    seedLegacy([{ resourceId: "old" }, { resourceId: "new", profile: "buyer.alice" }]);

    expect(purchaseProfiles()).toEqual([UNSCOPED_PROFILE, "buyer.alice"]);
  });
});

describe("filter normalisation", () => {
  it("accepts a profile", () => {
    expect(normalizePurchaseHistoryFilter({ profile: "buyer.alice" })).toEqual({
      profile: "buyer.alice",
    });
  });

  it("trims padding", () => {
    expect(normalizePurchaseHistoryFilter({ profile: "  buyer.alice  " }).profile).toBe(
      "buyer.alice",
    );
  });

  it("ignores an empty profile", () => {
    expect(normalizePurchaseHistoryFilter({ profile: "" })).toEqual({});
  });

  it("ignores a null profile", () => {
    expect(normalizePurchaseHistoryFilter({ profile: null })).toEqual({});
  });

  it("rejects a non-string profile", () => {
    expect(() => normalizePurchaseHistoryFilter({ profile: 42 })).toThrow(PurchaseHistoryError);
  });

  it("rejects a whitespace-only profile", () => {
    expect(() => normalizePurchaseHistoryFilter({ profile: "   " })).toThrow(/non-empty string/);
  });

  it("keeps the other filters working alongside it", () => {
    expect(
      normalizePurchaseHistoryFilter({
        profile: "buyer.alice",
        resourceId: "res-1",
        network: "stellar:testnet",
      }),
    ).toEqual({ profile: "buyer.alice", resourceId: "res-1", network: "stellar:testnet" });
  });
});

describe("tool output", () => {
  it("reports the scope it searched", () => {
    buy("res-1", "buyer.alice", "2026-01-01T00:00:00.000Z");

    const output = JSON.parse(purchaseHistoryTool({ profile: "buyer.alice" }));

    expect(output.profile).toBe("buyer.alice");
    expect(output.count).toBe(1);
  });

  it("names the profile when nothing matched", () => {
    buy("res-1", "publisher", "2026-01-01T00:00:00.000Z");

    const output = JSON.parse(purchaseHistoryTool({ profile: "buyer.alice" }));

    // "No results" plus the profile searched is actionable; the usual cause is
    // looking in the wrong profile.
    expect(output.count).toBe(0);
    expect(output.message).toContain('profile "buyer.alice"');
  });

  it("omits the profile field when unscoped", () => {
    buy("res-1", "buyer.alice", "2026-01-01T00:00:00.000Z");

    expect(JSON.parse(purchaseHistoryTool({}))).not.toHaveProperty("profile");
  });

  it("surfaces the receipts' own profiles", () => {
    buy("res-1", "buyer.alice", "2026-01-01T00:00:00.000Z");

    const output = JSON.parse(purchaseHistoryTool({}));

    expect(output.purchases[0].profile).toBe("buyer.alice");
  });

  it("rejects a bad profile filter with a clear error", () => {
    expect(() => purchaseHistoryTool({ profile: 42 })).toThrow(/expected a string profile name/);
  });

  it("formats an empty result without a scope when none was given", () => {
    const output = JSON.parse(formatPurchaseHistory([], {}));

    expect(output.message).not.toContain("profile");
  });
});
