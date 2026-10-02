import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  normalizeIntervalMs,
  normalizeTimeoutMs,
  normalizeWaitFlag,
  subscribeResource,
  type ResourceSubscriptionSnapshot,
} from "./resourceSubscriptionTool.js";
import { jsonFetch } from "./runtime.js";

vi.mock("./runtime.js", () => ({
  BASE_URL: "https://api.test.com",
  jsonFetch: vi.fn(),
}));

describe("resourceSubscriptionTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("normalizeTimeoutMs", () => {
    it("returns default when undefined", () => {
      expect(normalizeTimeoutMs(undefined)).toBe(120_000);
    });

    it("returns default when null", () => {
      expect(normalizeTimeoutMs(null)).toBe(120_000);
    });

    it("returns default when empty string", () => {
      expect(normalizeTimeoutMs("")).toBe(120_000);
    });

    it("returns the value when valid", () => {
      expect(normalizeTimeoutMs(60_000)).toBe(60_000);
    });

    it("clamps to max", () => {
      expect(normalizeTimeoutMs(1_000_000)).toBe(600_000);
    });

    it("parses string numbers", () => {
      expect(normalizeTimeoutMs("30000")).toBe(30_000);
    });

    it("throws on negative", () => {
      expect(() => normalizeTimeoutMs(-1)).toThrow("non-negative");
    });

    it("throws on NaN", () => {
      expect(() => normalizeTimeoutMs(NaN)).toThrow("non-negative");
    });
  });

  describe("normalizeIntervalMs", () => {
    it("returns default when undefined", () => {
      expect(normalizeIntervalMs(undefined)).toBe(5_000);
    });

    it("returns default when null", () => {
      expect(normalizeIntervalMs(null)).toBe(5_000);
    });

    it("returns default when empty string", () => {
      expect(normalizeIntervalMs("")).toBe(5_000);
    });

    it("returns the value when valid", () => {
      expect(normalizeIntervalMs(2_000)).toBe(2_000);
    });

    it("clamps to min", () => {
      expect(normalizeIntervalMs(500)).toBe(1_000);
    });

    it("clamps negative to min", () => {
      expect(normalizeIntervalMs(-1)).toBe(1_000);
    });

    it("throws on NaN", () => {
      expect(() => normalizeIntervalMs(NaN)).toThrow("must be a number");
    });
  });

  describe("normalizeWaitFlag", () => {
    it("returns false when undefined", () => {
      expect(normalizeWaitFlag(undefined)).toBe(false);
    });

    it("returns false when null", () => {
      expect(normalizeWaitFlag(null)).toBe(false);
    });

    it("returns false when empty string", () => {
      expect(normalizeWaitFlag("")).toBe(false);
    });

    it("returns true for true", () => {
      expect(normalizeWaitFlag(true)).toBe(true);
    });

    it("returns false for false", () => {
      expect(normalizeWaitFlag(false)).toBe(false);
    });

    it("returns true for 1", () => {
      expect(normalizeWaitFlag(1)).toBe(true);
    });

    it("returns false for 0", () => {
      expect(normalizeWaitFlag(0)).toBe(false);
    });

    it("parses 'true' string", () => {
      expect(normalizeWaitFlag("true")).toBe(true);
    });

    it("parses 'false' string", () => {
      expect(normalizeWaitFlag("false")).toBe(false);
    });

    it("parses 'yes' string", () => {
      expect(normalizeWaitFlag("yes")).toBe(true);
    });

    it("parses 'no' string", () => {
      expect(normalizeWaitFlag("no")).toBe(false);
    });

    it("throws on invalid string", () => {
      expect(() => normalizeWaitFlag("maybe")).toThrow("boolean");
    });
  });

  describe("subscribeResource", () => {
    it("performs single check when wait is false", async () => {
      let clock = 0;
      vi.mocked(jsonFetch).mockResolvedValue({
        ok: true,
        data: {
          id: "res-1",
          title: "Test Resource",
          price: "5.00",
          verificationStatus: "verified",
          listed: true,
        },
      });

      const result = await subscribeResource(
        {
          resourceId: "res-1",
          wait: false,
          timeoutMs: 60_000,
          intervalMs: 5_000,
          sleep: async (ms) => {
            clock += ms;
          },
          now: () => clock,
        },
        undefined,
      );

      expect(result.resourceId).toBe("res-1");
      expect(result.polled).toBe(false);
      expect(result.attempts).toBe(1);
      expect(result.changes).toHaveLength(0);
      expect(jsonFetch).toHaveBeenCalledTimes(1);
    });

    it("detects price changes", async () => {
      let clock = 0;
      let callCount = 0;
      vi.mocked(jsonFetch).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: true,
            data: {
              id: "res-1",
              title: "Test Resource",
              price: "5.00",
              verificationStatus: "verified",
              listed: true,
            },
          });
        }
        return Promise.resolve({
          ok: true,
          data: {
            id: "res-1",
            title: "Test Resource",
            price: "10.00",
            verificationStatus: "verified",
            listed: true,
          },
        });
      });

      const progressUpdates: string[] = [];
      const result = await subscribeResource(
        {
          resourceId: "res-1",
          wait: true,
          timeoutMs: 10_000,
          intervalMs: 100,
          sleep: async (ms) => {
            clock += ms;
          },
          now: () => clock,
        },
        async (_p, _t, message) => {
          if (message) progressUpdates.push(message);
        },
      );

      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].field).toBe("price");
      expect(result.changes[0].oldValue).toBe("5.00");
      expect(result.changes[0].newValue).toBe("10.00");
      expect(
        progressUpdates.some((u) => u.includes("Changes detected") && u.includes("price")),
      ).toBe(true);
    });

    it("detects verification status changes", async () => {
      let clock = 0;
      let callCount = 0;
      vi.mocked(jsonFetch).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: true,
            data: {
              id: "res-1",
              title: "Test Resource",
              price: "5.00",
              verificationStatus: "pending",
              listed: false,
            },
          });
        }
        return Promise.resolve({
          ok: true,
          data: {
            id: "res-1",
            title: "Test Resource",
            price: "5.00",
            verificationStatus: "verified",
            listed: true,
          },
        });
      });

      const progressUpdates: string[] = [];
      const result = await subscribeResource(
        {
          resourceId: "res-1",
          wait: true,
          timeoutMs: 10_000,
          intervalMs: 100,
          sleep: async (ms) => {
            clock += ms;
          },
          now: () => clock,
        },
        async (_p, _t, message) => {
          if (message) progressUpdates.push(message);
        },
      );

      expect(result.changes.length).toBeGreaterThanOrEqual(1);
      const statusChange = result.changes.find((c) => c.field === "verificationStatus");
      expect(statusChange).toBeDefined();
      expect(statusChange?.oldValue).toBe("pending");
      expect(statusChange?.newValue).toBe("verified");
    });

    it("detects listed status changes", async () => {
      let clock = 0;
      let callCount = 0;
      vi.mocked(jsonFetch).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: true,
            data: {
              id: "res-1",
              title: "Test Resource",
              price: "5.00",
              verificationStatus: "verified",
              listed: false,
            },
          });
        }
        return Promise.resolve({
          ok: true,
          data: {
            id: "res-1",
            title: "Test Resource",
            price: "5.00",
            verificationStatus: "verified",
            listed: true,
          },
        });
      });

      const progressUpdates: string[] = [];
      const result = await subscribeResource(
        {
          resourceId: "res-1",
          wait: true,
          timeoutMs: 10_000,
          intervalMs: 100,
          sleep: async (ms) => {
            clock += ms;
          },
          now: () => clock,
        },
        async (_p, _t, message) => {
          if (message) progressUpdates.push(message);
        },
      );

      expect(result.changes.length).toBeGreaterThanOrEqual(1);
      const listedChange = result.changes.find((c) => c.field === "listed");
      expect(listedChange).toBeDefined();
      expect(listedChange?.oldValue).toBe(false);
      expect(listedChange?.newValue).toBe(true);
    });

    it("times out when no changes occur", async () => {
      let clock = 0;
      vi.mocked(jsonFetch).mockResolvedValue({
        ok: true,
        data: {
          id: "res-1",
          title: "Test Resource",
          price: "5.00",
          verificationStatus: "verified",
          listed: true,
        },
      });

      const result = await subscribeResource(
        {
          resourceId: "res-1",
          wait: true,
          timeoutMs: 200,
          intervalMs: 100,
          sleep: async (ms) => {
            clock += ms;
          },
          now: () => clock,
        },
        undefined,
      );

      expect(result.timedOut).toBe(true);
      expect(result.changes).toHaveLength(0);
      expect(result.message).toContain("timed out");
    });

    it("emits progress notifications when reporter provided", async () => {
      let clock = 0;
      vi.mocked(jsonFetch).mockResolvedValue({
        ok: true,
        data: {
          id: "res-1",
          title: "Test Resource",
          price: "5.00",
          verificationStatus: "verified",
          listed: true,
        },
      });

      const progressCalls: Array<[number, number | undefined, string | undefined]> = [];
      await subscribeResource(
        {
          resourceId: "res-1",
          wait: true,
          timeoutMs: 200,
          intervalMs: 100,
          sleep: async (ms) => {
            clock += ms;
          },
          now: () => clock,
        },
        async (progress, total, message) => {
          progressCalls.push([progress, total, message]);
        },
      );

      expect(progressCalls.length).toBeGreaterThan(0);
      expect(progressCalls[0][0]).toBe(1); // First progress call
    });

    it("handles no progress reporter gracefully", async () => {
      let clock = 0;
      vi.mocked(jsonFetch).mockResolvedValue({
        ok: true,
        data: {
          id: "res-1",
          title: "Test Resource",
          price: "5.00",
          verificationStatus: "verified",
          listed: true,
        },
      });

      const result = await subscribeResource(
        {
          resourceId: "res-1",
          wait: true,
          timeoutMs: 200,
          intervalMs: 100,
          sleep: async (ms) => {
            clock += ms;
          },
          now: () => clock,
        },
        undefined, // No progress reporter
      );

      expect(result.resourceId).toBe("res-1");
    });
  });
});
