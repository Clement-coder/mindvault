import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { resources } from "../db/schema.js";
import { config } from "../config.js";
import { getLogger } from "../lib/logger.js";
import { saveResourceTags } from "../services/resourceService.js";

const POLL_INTERVAL_MS = 30_000;
const EVENT_PAGE_LIMIT = 100;

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEDGER_TRACKER_PATH = join(__dirname, "..", "..", "last-processed-ledger.json");

const CONTRACT_ID = config.REGISTRY_CONTRACT_ID;

// Event topic symbols (matching contract `symbol_short!`)
const EVENT_REGISTER = "register";
const EVENT_SET_PRICE = "setprice";
const EVENT_UPD_META = "updmeta";
const EVENT_SET_TAGS = "settags";
const EVENT_TRANSFER = "transfer";
const EVENT_SET_LISTED = "setlisted";

let intervalHandle: ReturnType<typeof setInterval> | null = null;

function loadLastLedger(): number {
  try {
    if (existsSync(LEDGER_TRACKER_PATH)) {
      const data = JSON.parse(readFileSync(LEDGER_TRACKER_PATH, "utf-8"));
      return data.lastLedger ?? 0;
    }
  } catch {
    // ignore corrupt file
  }
  return 0;
}

function saveLastLedger(ledger: number): void {
  try {
    const dir = dirname(LEDGER_TRACKER_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(LEDGER_TRACKER_PATH, JSON.stringify({ lastLedger: ledger }));
  } catch (err) {
    getLogger().error({ event: "ledger_tracker_write_error", err }, "failed to save last ledger");
  }
}

type EventValue = {
  type?: string;
  value?: string;
  symbol?: string;
  vec?: EventValue[] | (() => EventValue[] | undefined);
  switch?: () => { name?: string };
  str?: () => string;
  sym?: () => string;
  map?: Array<{ key: { type: string; symbol?: string }; val: { type: string; value?: string } }>;
};

export interface SorobanEvent {
  type: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  id: string;
  pagingToken: string;
  topic: Array<string | EventValue>;
  value: EventValue;
}

function eventValueType(value: EventValue | undefined): string | null {
  if (!value) return null;
  if (typeof value.type === "string") return value.type;
  const name = value.switch?.()?.name;
  return typeof name === "string" ? name.replace(/^scv/, "").toLowerCase() : null;
}

function eventVector(value: EventValue | undefined): EventValue[] | null {
  if (eventValueType(value) !== "vec") return null;
  if (typeof value?.vec === "function") return value.vec() ?? null;
  return Array.isArray(value?.vec) ? value.vec : null;
}

function eventString(value: string | EventValue | undefined): string | null {
  if (typeof value === "string") return value;
  if (!value) return null;
  const type = eventValueType(value);
  if (type === undefined && typeof value.value === "string") return value.value;
  if (type === undefined && typeof value.symbol === "string") return value.symbol;
  if (type !== "string" && type !== "symbol") return null;
  if (typeof value.str === "function") return value.str();
  if (typeof value.sym === "function") return value.sym();
  if (typeof value.value === "string") return value.value;
  return typeof value.symbol === "string" ? value.symbol : null;
}

function extractResourceId(topic: Array<string | EventValue>): string | null {
  if (topic.length < 2) return null;
  const raw = eventString(topic[1]);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "string"
      ? parsed
      : typeof parsed?.value === "string"
        ? parsed.value
        : null;
  } catch {
    return raw;
  }
}

function extractTopicSymbol(topic: Array<string | EventValue>): string | null {
  const raw = eventString(topic[0]);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "string"
      ? parsed
      : typeof parsed?.symbol === "string"
        ? parsed.symbol
        : null;
  } catch {
    return raw;
  }
}

function extractAddress(val: { type?: string; value?: string }): string | null {
  if (val.type === "address") return val.value ?? null;
  return null;
}

function extractStringVector(value: EventValue | undefined): string[] | null {
  const entries = eventVector(value);
  if (!entries) return null;
  const tags: string[] = [];
  for (const entry of entries) {
    const tag = eventString(entry);
    if (tag === null) return null;
    tags.push(tag);
  }
  return tags;
}

export function extractNextTags(event: SorobanEvent): string[] | null {
  const values = eventVector(event.value);
  if (!values || values.length < 2) return null;
  return extractStringVector(values[1]);
}

export async function handleSetTagsEvent(event: SorobanEvent): Promise<void> {
  const id = extractResourceId(event.topic);
  if (!id) {
    getLogger().warn(
      { event: "event_settags_invalid", eventId: event.id },
      "settags event missing resource id",
    );
    return;
  }

  const tags = extractNextTags(event);
  if (tags === null) {
    getLogger().warn(
      { event: "event_settags_invalid", eventId: event.id, resourceId: id },
      "settags event has an invalid payload",
    );
    return;
  }

  const saved = await saveResourceTags(id, tags);

  if (!saved) {
    getLogger().warn(
      { event: "event_settags_unknown_resource", eventId: event.id, resourceId: id },
      "settags event references an unknown resource",
    );
    return;
  }

  getLogger().info({ event: "event_settags", resourceId: id, tags }, "synced settags event");
}

async function handleRegisterEvent(event: SorobanEvent): Promise<void> {
  const id = extractResourceId(event.topic);
  if (!id) return;

  const dbResource = await db
    .select({ id: resources.id })
    .from(resources)
    .where(eq(resources.id, id))
    .then((r) => r[0]);

  if (dbResource) {
    await db.update(resources).set({ onchainStatus: "registered" }).where(eq(resources.id, id));
    getLogger().info({ event: "event_register", resourceId: id }, "synced register event");
  }
}

async function handleSetPriceEvent(event: SorobanEvent): Promise<void> {
  const id = extractResourceId(event.topic);
  if (!id) return;

  if (event.value.type === "i128" || event.value.type === "string") {
    const rawPrice = event.value.value ?? "0";
    const stroops = BigInt(rawPrice);
    const usdc = (Number(stroops) / 10_000_000).toFixed(7).replace(/\.?0+$/, "");

    await db.update(resources).set({ price: usdc }).where(eq(resources.id, id));

    getLogger().info(
      { event: "event_setprice", resourceId: id, price: usdc },
      "synced set_price event",
    );
  }
}

async function handleTransferEvent(event: SorobanEvent): Promise<void> {
  const id = extractResourceId(event.topic);
  if (!id) return;

  const newCreator = extractAddress({ type: event.value.type, value: event.value.value });
  if (newCreator) {
    await db.update(resources).set({ walletAddress: newCreator }).where(eq(resources.id, id));

    getLogger().info(
      { event: "event_transfer", resourceId: id, newCreator },
      "synced transfer event",
    );
  }
}

async function handleSetListedEvent(event: SorobanEvent): Promise<void> {
  const id = extractResourceId(event.topic);
  if (!id) return;

  // The `setlisted` event payload changed from a single `bool` to a two-element
  // tuple `(old_listed: bool, new_listed: bool)`. The XDR representation is a
  // `vec` with two bool entries. We extract `new_listed` (index 1) to determine
  // the resulting state. A legacy single-bool payload is also accepted for
  // backwards-compatibility with events emitted before the upgrade.
  let listed: boolean | null = null;

  if (event.value.type === "vec" && Array.isArray(event.value.vec)) {
    // New format: (old_listed, new_listed) tuple
    const newListedEntry = event.value.vec[1];
    if (newListedEntry?.type === "bool") {
      listed = newListedEntry.value === "true";
    }
  } else if (event.value.type === "bool") {
    // Legacy format: single bool (pre-upgrade events)
    listed = event.value.value === "true";
  }

  if (listed !== null) {
    await db.update(resources).set({ listed }).where(eq(resources.id, id));

    getLogger().info(
      { event: "event_setlisted", resourceId: id, listed },
      "synced set_listed event",
    );
  }
}

async function pollEvents(): Promise<void> {
  const lastLedger = loadLastLedger();
  if (lastLedger === 0) {
    saveLastLedger(1);
    return;
  }

  try {
    const { rpc: StellarRpc } = await import("@stellar/stellar-sdk");
    const server = new StellarRpc.Server(config.SOROBAN_RPC_URL);

    const response: any = await server.getEvents({
      startLedger: lastLedger,
      filters: [
        {
          type: "contract",
          contractIds: [CONTRACT_ID],
        },
      ],
      limit: EVENT_PAGE_LIMIT,
    });

    const events: SorobanEvent[] = response?.events ?? [];

    if (events.length === 0) return;

    let maxLedger = lastLedger;

    for (const event of events) {
      if (event.ledger > maxLedger) maxLedger = event.ledger;

      const eventType = extractTopicSymbol(event.topic);

      try {
        switch (eventType) {
          case EVENT_REGISTER:
            await handleRegisterEvent(event);
            break;
          case EVENT_SET_PRICE:
            await handleSetPriceEvent(event);
            break;
          case EVENT_UPD_META:
            break;
          case EVENT_SET_TAGS:
            await handleSetTagsEvent(event);
            break;
          case EVENT_TRANSFER:
            await handleTransferEvent(event);
            break;
          case EVENT_SET_LISTED:
            await handleSetListedEvent(event);
            break;
          default:
            getLogger().debug({ eventType }, "unknown event type from registry");
        }
      } catch (err) {
        getLogger().warn(
          { event: "event_handler_error", eventType, eventId: event.id, err },
          "failed to process event",
        );
      }
    }

    saveLastLedger(maxLedger + 1);
  } catch (err) {
    getLogger().error({ event: "event_listener_poll_error", err }, "event polling failed");
  }
}

export function startEventListener(): void {
  getLogger().info(
    { event: "event_listener_start", intervalMs: POLL_INTERVAL_MS, contractId: CONTRACT_ID },
    "starting registry event listener",
  );

  pollEvents();
  intervalHandle = setInterval(pollEvents, POLL_INTERVAL_MS);
}

export function stopEventListener(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
