import { xdr } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const saveResourceTags = vi.fn();
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  return { logger, saveResourceTags };
});

vi.mock("../db/client.js", () => ({
  db: { select: vi.fn(), update: vi.fn() },
}));

vi.mock("../services/resourceService.js", () => ({
  saveResourceTags: mocks.saveResourceTags,
}));

vi.mock("../config.js", () => ({
  config: {
    REGISTRY_CONTRACT_ID: "C123",
    SOROBAN_RPC_URL: "https://rpc.example.test",
  },
}));

vi.mock("../lib/logger.js", () => ({
  getLogger: () => mocks.logger,
}));

import { extractNextTags, handleSetTagsEvent, type SorobanEvent } from "./eventListener.js";

function makeEvent(nextTags: string[] | null, id = "res-1"): SorobanEvent {
  return {
    type: "contract",
    ledger: 10,
    ledgerClosedAt: "2026-09-25T00:00:00Z",
    contractId: "C123",
    id: "event-1",
    pagingToken: "1",
    topic: [JSON.stringify({ symbol: "settags" }), JSON.stringify(id)],
    value: {
      type: "vec",
      vec: [
        { type: "vec", vec: [{ type: "string", value: "old" }] },
        nextTags === null
          ? { type: "string", value: "invalid" }
          : { type: "vec", vec: nextTags.map((value) => ({ type: "string", value })) },
      ],
    },
  };
}

function makeXdrEvent(): SorobanEvent {
  return {
    type: "contract",
    ledger: 11,
    ledgerClosedAt: "2026-09-25T00:00:00Z",
    contractId: "C123",
    id: "event-xdr",
    pagingToken: "2",
    topic: [
      xdr.ScVal.scvSymbol("settags"),
      xdr.ScVal.scvString("res-xdr"),
    ] as unknown as SorobanEvent["topic"],
    value: xdr.ScVal.scvVec([
      xdr.ScVal.scvVec([xdr.ScVal.scvString("old")]),
      xdr.ScVal.scvVec([xdr.ScVal.scvString("new"), xdr.ScVal.scvString("api")]),
    ]) as unknown as SorobanEvent["value"],
  };
}

describe("settags event handling", () => {
  beforeEach(() => {
    mocks.saveResourceTags.mockReset();
    mocks.saveResourceTags.mockResolvedValue(true);
    mocks.logger.debug.mockClear();
    mocks.logger.error.mockClear();
    mocks.logger.info.mockClear();
    mocks.logger.warn.mockClear();
  });

  it("extracts the next tag vector and ignores the previous vector", () => {
    expect(extractNextTags(makeEvent(["new", "api"]))).toEqual(["new", "api"]);
  });

  it("extracts an empty replacement vector", () => {
    expect(extractNextTags(makeEvent([]))).toEqual([]);
  });

  it("extracts tags from the SDK's XDR event representation", () => {
    expect(extractNextTags(makeXdrEvent())).toEqual(["new", "api"]);
  });

  it("returns null for a malformed event payload", () => {
    expect(extractNextTags(makeEvent(null))).toBeNull();
  });

  it("replaces stored tags and invalidates resource reads", async () => {
    await handleSetTagsEvent(makeEvent(["new", "api"]));

    expect(mocks.saveResourceTags).toHaveBeenCalledWith("res-1", ["new", "api"]);
    expect(mocks.logger.info).toHaveBeenCalledWith(
      { event: "event_settags", resourceId: "res-1", tags: ["new", "api"] },
      "synced settags event",
    );
  });

  it("saves an XDR event using its decoded resource id", async () => {
    await handleSetTagsEvent(makeXdrEvent());

    expect(mocks.saveResourceTags).toHaveBeenCalledWith("res-xdr", ["new", "api"]);
  });

  it("does not save when the resource is unknown", async () => {
    mocks.saveResourceTags.mockResolvedValue(false);

    await handleSetTagsEvent(makeEvent(["new"]));

    expect(mocks.saveResourceTags).toHaveBeenCalledWith("res-1", ["new"]);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      { event: "event_settags_unknown_resource", eventId: "event-1", resourceId: "res-1" },
      "settags event references an unknown resource",
    );
  });

  it("ignores a malformed event without writing", async () => {
    await handleSetTagsEvent(makeEvent(null));

    expect(mocks.saveResourceTags).not.toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      { event: "event_settags_invalid", eventId: "event-1", resourceId: "res-1" },
      "settags event has an invalid payload",
    );
  });
});
