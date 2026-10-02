/**
 * Unit tests for the state mutex (#855).
 *
 * These tests verify that:
 * - The mutex serializes calls in FIFO order
 * - A throwing call does not wedge the queue
 * - The pending count is accurate
 * - serializesStateTool identifies the correct tools
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createStateMutex,
  serializesStateTool,
  STATE_SERIALIZED_TOOLS,
  type StateMutex,
} from "./stateMutex.js";

describe("stateMutex", () => {
  let mutex: StateMutex;

  beforeEach(() => {
    mutex = createStateMutex();
  });

  describe("createStateMutex", () => {
    it("starts with pending = 0", () => {
      expect(mutex.pending).toBe(0);
    });

    it("runs a simple function exclusively", async () => {
      const result = await mutex.runExclusive(() => 42);
      expect(result).toBe(42);
      expect(mutex.pending).toBe(0);
    });

    it("runs an async function exclusively", async () => {
      const result = await mutex.runExclusive(async () => {
        await Promise.resolve();
        return "async-result";
      });
      expect(result).toBe("async-result");
    });

    it("serializes calls in FIFO order", async () => {
      const order: number[] = [];
      const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

      // Launch three calls concurrently
      const p1 = mutex.runExclusive(async () => {
        order.push(1);
        await delay(10);
        order.push(11);
      });
      const p2 = mutex.runExclusive(async () => {
        order.push(2);
        await delay(10);
        order.push(22);
      });
      const p3 = mutex.runExclusive(async () => {
        order.push(3);
        await delay(10);
        order.push(33);
      });

      await Promise.all([p1, p2, p3]);

      // Each call runs to completion before the next starts
      expect(order).toEqual([1, 11, 2, 22, 3, 33]);
    });

    it("pending count increments and decrements correctly", async () => {
      let resolveGate: (v: unknown) => void;
      const gate = new Promise((resolve) => {
        resolveGate = resolve;
      });

      let resolveQueued: (v: unknown) => void;
      const queuedGate = new Promise((resolve) => {
        resolveQueued = resolve;
      });

      const running = mutex.runExclusive(async () => {
        await gate;
      });

      // One running, one queued
      expect(mutex.pending).toBe(1);
      const queued = mutex.runExclusive(async () => {
        await queuedGate;
      });
      expect(mutex.pending).toBe(2);

      resolveGate!("go");
      await running; // Wait for the first to complete
      // After running completes, queued is now running (waiting on its gate)
      expect(mutex.pending).toBe(1);

      resolveQueued!("go");
      await queued;
      expect(mutex.pending).toBe(0);
    });

    it("a throwing call does not poison the queue", async () => {
      const error = new Error("boom");
      await expect(mutex.runExclusive(() => { throw error; })).rejects.toThrow("boom");

      // Queue should still work
      const result = await mutex.runExclusive(() => "recovered");
      expect(result).toBe("recovered");
    });

    it("a rejecting promise does not poison the queue", async () => {
      await expect(mutex.runExclusive(async () => { throw new Error("async boom"); })).rejects.toThrow(
        "async boom",
      );

      const result = await mutex.runExclusive(() => "recovered");
      expect(result).toBe("recovered");
    });

    it("pending count is correct after a throwing call", async () => {
      try {
        await mutex.runExclusive(() => { throw new Error("boom"); });
      } catch {
        // ignore
      }
      expect(mutex.pending).toBe(0);
    });

    it("multiple mutex instances are independent", async () => {
      const mutex2 = createStateMutex();
      const order: number[] = [];

      const p1 = mutex.runExclusive(async () => {
        order.push(1);
        await Promise.resolve();
        order.push(11);
      });
      const p2 = mutex2.runExclusive(async () => {
        order.push(2);
        await Promise.resolve();
        order.push(22);
      });

      await Promise.all([p1, p2]);
      // They run in parallel, so order between mutexes is non-deterministic
      // But within each mutex, order is preserved
      expect(order.indexOf(1)).toBeLessThan(order.indexOf(11));
      expect(order.indexOf(2)).toBeLessThan(order.indexOf(22));
    });
  });

  describe("serializesStateTool", () => {
    it("returns true for state-mutating tools", () => {
      expect(serializesStateTool("mindvault_reset")).toBe(true);
      expect(serializesStateTool("mindvault_restore_state")).toBe(true);
      expect(serializesStateTool("mindvault_setup_wallet")).toBe(true);
      expect(serializesStateTool("mindvault_import_wallet")).toBe(true);
      expect(serializesStateTool("mindvault_use_profile")).toBe(true);
      expect(serializesStateTool("mindvault_register")).toBe(true);
      expect(serializesStateTool("mindvault_rotate_publisher_key")).toBe(true);
    });

    it("returns true for credential-spending tools", () => {
      expect(serializesStateTool("mindvault_publish")).toBe(true);
      expect(serializesStateTool("mindvault_buy")).toBe(true);
    });

    it("returns false for read-only tools", () => {
      expect(serializesStateTool("mindvault_browse")).toBe(false);
      expect(serializesStateTool("mindvault_search")).toBe(false);
      expect(serializesStateTool("mindvault_preview")).toBe(false);
      expect(serializesStateTool("mindvault_wallet_info")).toBe(false);
      expect(serializesStateTool("mindvault_list_profiles")).toBe(false);
      expect(serializesStateTool("mindvault_publish_status")).toBe(false);
      expect(serializesStateTool("mindvault_agent_status")).toBe(false);
      expect(serializesStateTool("mindvault_registry_info")).toBe(false);
      expect(serializesStateTool("mindvault_network_profile")).toBe(false);
      expect(serializesStateTool("mindvault_check_bindings")).toBe(false);
      expect(serializesStateTool("mindvault_check_consistency")).toBe(false);
      expect(serializesStateTool("mindvault_registry_lookup")).toBe(false);
      expect(serializesStateTool("mindvault_registry_list")).toBe(false);
      expect(serializesStateTool("mindvault_tx_status")).toBe(false);
      expect(serializesStateTool("mindvault_metrics")).toBe(false);
      expect(serializesStateTool("mindvault_check_state_permissions")).toBe(false);
      expect(serializesStateTool("mindvault_registry_health")).toBe(false);
      expect(serializesStateTool("mindvault_verify_install")).toBe(false);
      expect(serializesStateTool("mindvault_backup_state")).toBe(false);
    });

    it("returns false for unknown tools", () => {
      expect(serializesStateTool("mindvault_unknown")).toBe(false);
    });
  });

  describe("STATE_SERIALIZED_TOOLS", () => {
    it("contains exactly the expected tools", () => {
      const expected = new Set([
        "mindvault_reset",
        "mindvault_restore_state",
        "mindvault_setup_wallet",
        "mindvault_import_wallet",
        "mindvault_use_profile",
        "mindvault_register",
        "mindvault_rotate_publisher_key",
        "mindvault_publish",
        "mindvault_buy",
      ]);
      expect(STATE_SERIALIZED_TOOLS).toEqual(expected);
    });

    it("serializesStateTool matches the set", () => {
      for (const tool of STATE_SERIALIZED_TOOLS) {
        expect(serializesStateTool(tool)).toBe(true);
      }
    });
  });
});