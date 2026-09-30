import { describe, it, expect, beforeEach, vi } from "vitest";

// The row returned by the mocked `update(...).returning()` chain. Each test
// mutates this to drive the registered / unregistered / not-found branches.
let returnedRow: Record<string, unknown> | undefined;

vi.mock("../db/client.js", () => ({
  db: {
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve(returnedRow ? [returnedRow] : []),
        }),
      }),
    }),
  },
}));

const deleteFile = vi.fn((_path: string) => Promise.resolve());
vi.mock("../storage/supabaseStorage.js", () => ({
  uploadFile: vi.fn(),
  deleteFile: (path: string) => deleteFile(path),
}));

// delistOnChain is the real default; we mock the module so importing
// resourceService doesn't construct a live Stellar client at load time.
const delistOnChain = vi.fn((_id: string) =>
  Promise.resolve<{ txHash: string; success: boolean; error?: string }>({
    txHash: "tx123",
    success: true,
  }),
);
vi.mock("./registryClient.js", () => ({
  delistOnChain: (id: string) => delistOnChain(id),
}));

vi.mock("../config.js", () => ({ config: { CATALOG_CACHE_TTL_MS: 60_000 } }));

import { delistResource, saveResourceTags } from "./resourceService.js";

describe("delistResource on-chain sync (#218)", () => {
  beforeEach(() => {
    returnedRow = undefined;
    deleteFile.mockClear();
    delistOnChain.mockClear();
    delistOnChain.mockResolvedValue({ txHash: "tx123", success: true });
  });

  it("returns null when the resource is missing or not owned by the caller", async () => {
    returnedRow = undefined;
    const result = await delistResource("missing", "pub1");
    expect(result).toBeNull();
    expect(delistOnChain).not.toHaveBeenCalled();
  });

  it("triggers an on-chain delist for resources registered on-chain", async () => {
    returnedRow = { id: "r1", onchainStatus: "registered", storagePath: null };
    const injected = vi.fn(() => Promise.resolve({ success: true }));

    const result = await delistResource("r1", "pub1", injected);

    expect(result).toMatchObject({ id: "r1" });
    expect(injected).toHaveBeenCalledWith("r1");
  });

  it("skips the on-chain delist for resources never registered on-chain", async () => {
    returnedRow = { id: "r2", onchainStatus: "none", storagePath: null };
    const injected = vi.fn(() => Promise.resolve({ success: true }));

    const result = await delistResource("r2", "pub1", injected);

    expect(result).toMatchObject({ id: "r2" });
    expect(injected).not.toHaveBeenCalled();
  });

  it("still resolves the DB delist when the on-chain delist fails", async () => {
    returnedRow = { id: "r3", onchainStatus: "registered", storagePath: null };
    const injected = vi.fn(() => Promise.resolve({ success: false, error: "rpc down" }));

    const result = await delistResource("r3", "pub1", injected);

    // DB delist remains authoritative even when the chain call reports failure.
    expect(result).toMatchObject({ id: "r3" });
    expect(injected).toHaveBeenCalledWith("r3");
  });

  it("deletes stored files for file resources before syncing on-chain", async () => {
    returnedRow = { id: "r4", onchainStatus: "registered", storagePath: "r4/file.pdf" };
    const injected = vi.fn(() => Promise.resolve({ success: true }));

    await delistResource("r4", "pub1", injected);

    expect(deleteFile).toHaveBeenCalledWith("r4/file.pdf");
    expect(injected).toHaveBeenCalledWith("r4");
  });
});

describe("saveResourceTags", () => {
  beforeEach(() => {
    returnedRow = undefined;
  });

  it("returns true when the resource exists", async () => {
    returnedRow = { id: "r1" };
    await expect(saveResourceTags("r1", ["new"])).resolves.toBe(true);
  });

  it("returns false when the resource does not exist", async () => {
    await expect(saveResourceTags("missing", ["new"])).resolves.toBe(false);
  });
});
