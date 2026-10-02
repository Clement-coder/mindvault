import { afterEach, describe, expect, it } from "vitest";

import {
  explorerAccountUrl,
  explorerContractUrl,
  explorerTxUrl,
  resolveExplorerNetwork,
} from "./stellarExplorer.js";

// The helper resolves its network segment from STELLAR_NETWORK; restore it after
// each case so tests stay independent of the ambient environment.
const ORIGINAL_NETWORK = process.env.STELLAR_NETWORK;
const ORIGINAL_HORIZON_URL = process.env.HORIZON_URL;

afterEach(() => {
  if (ORIGINAL_NETWORK === undefined) delete process.env.STELLAR_NETWORK;
  else process.env.STELLAR_NETWORK = ORIGINAL_NETWORK;
  if (ORIGINAL_HORIZON_URL === undefined) delete process.env.HORIZON_URL;
  else process.env.HORIZON_URL = ORIGINAL_HORIZON_URL;
});

describe("resolveExplorerNetwork", () => {
  it("defaults to testnet when STELLAR_NETWORK is unset", () => {
    expect(resolveExplorerNetwork({} as NodeJS.ProcessEnv)).toBe("testnet");
  });

  it("maps testnet to the testnet segment", () => {
    expect(resolveExplorerNetwork({ STELLAR_NETWORK: "testnet" } as NodeJS.ProcessEnv)).toBe(
      "testnet",
    );
  });

  it("maps mainnet and its aliases to the public segment", () => {
    for (const value of ["mainnet", "pubnet", "public"]) {
      expect(resolveExplorerNetwork({ STELLAR_NETWORK: value } as NodeJS.ProcessEnv)).toBe(
        "public",
      );
    }
  });
});

describe("explorerTxUrl", () => {
  it("formats a testnet transaction URL", () => {
    expect(explorerTxUrl("abc123", "testnet")).toBe(
      "https://stellar.expert/explorer/testnet/tx/abc123",
    );
  });

  it("formats a mainnet transaction URL using the public segment", () => {
    expect(explorerTxUrl("abc123", "public")).toBe(
      "https://stellar.expert/explorer/public/tx/abc123",
    );
  });

  it("returns null for a missing, empty, or whitespace hash", () => {
    expect(explorerTxUrl(null, "testnet")).toBeNull();
    expect(explorerTxUrl(undefined, "testnet")).toBeNull();
    expect(explorerTxUrl("", "testnet")).toBeNull();
    expect(explorerTxUrl("   ", "testnet")).toBeNull();
  });

  it("trims surrounding whitespace from the hash", () => {
    expect(explorerTxUrl("  abc123  ", "public")).toBe(
      "https://stellar.expert/explorer/public/tx/abc123",
    );
  });

  it("resolves the network from STELLAR_NETWORK when no segment is passed", () => {
    process.env.STELLAR_NETWORK = "mainnet";
    expect(explorerTxUrl("abc123")).toBe("https://stellar.expert/explorer/public/tx/abc123");
    process.env.STELLAR_NETWORK = "testnet";
    expect(explorerTxUrl("abc123")).toBe("https://stellar.expert/explorer/testnet/tx/abc123");
  });

  it("uses HORIZON_URL as the explorer base when configured", () => {
    process.env.HORIZON_URL = "https://horizon.example.test/";
    expect(explorerTxUrl("abc123", "testnet")).toBe(
      "https://horizon.example.test/explorer/testnet/tx/abc123",
    );
    expect(explorerAccountUrl("GABC", "testnet")).toBe(
      "https://horizon.example.test/explorer/testnet/account/GABC",
    );
    expect(explorerContractUrl("CABC", "testnet")).toBe(
      "https://horizon.example.test/explorer/testnet/contract/CABC",
    );
  });
});

describe("explorerAccountUrl / explorerContractUrl", () => {
  it("formats account URLs per network", () => {
    expect(explorerAccountUrl("GABC", "testnet")).toBe(
      "https://stellar.expert/explorer/testnet/account/GABC",
    );
    expect(explorerAccountUrl("GABC", "public")).toBe(
      "https://stellar.expert/explorer/public/account/GABC",
    );
  });

  it("formats contract URLs per network", () => {
    expect(explorerContractUrl("CABC", "testnet")).toBe(
      "https://stellar.expert/explorer/testnet/contract/CABC",
    );
    expect(explorerContractUrl("CABC", "public")).toBe(
      "https://stellar.expert/explorer/public/contract/CABC",
    );
  });
});
