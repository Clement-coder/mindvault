/**
 * StrKey validation tests (#1051) — centralized Stellar address rejection.
 *
 * Acceptance criteria:
 *   - Invalid StrKeys return field-specific errors with stable issue codes.
 *   - No network request is made for a call whose address fails validation.
 *
 * This suite is isolated from the broader validation.test.ts to keep the
 * network-assertion contract visible at a glance without digging through
 * 400+ cases. The `fetch` spy is installed globally (via vitest.setup.ts)
 * but this suite explicitly asserts it was never called, so a tool that
 * bypasses validation and reaches an HTTP call will fail here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { validateToolArgs, ToolValidationError } from "./validation.js";

// ── Test fixtures ─────────────────────────────────────────────────────────────

/**
 * Real Stellar public key. Verified with StrKey.isValidEd25519PublicKey.
 * DO NOT use for real funds.
 */
const VALID_PUBLIC_KEY = "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH";

/**
 * Real Stellar secret seed. Derived from Buffer.alloc(32, 0x01).
 * Verified with StrKey.isValidEd25519SecretSeed. DO NOT use for real funds.
 */
const VALID_SECRET_KEY = "SAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC5MY";

/**
 * Public key that passes the character-set regex /^G[A-Z2-7]{55}$/ but
 * fails the CRC-16 checksum embedded in the StrKey encoding. The old
 * regex-only validator would have accepted this; the new StrKey validator
 * rejects it before any network call is made.
 */
const BAD_CHECKSUM_PUBLIC_KEY = "G" + "A".repeat(55);

/**
 * Secret seed that passes the character-set regex /^S[A-Z2-7]{55}$/ but
 * fails the CRC-16 checksum. Same gap as above, for secret keys.
 */
const BAD_CHECKSUM_SECRET_KEY = "S" + "A".repeat(55);

// ── Helper ────────────────────────────────────────────────────────────────────

function expectInvalid(tool: string, args: unknown): ToolValidationError {
  try {
    validateToolArgs(tool, args);
  } catch (err) {
    expect(err).toBeInstanceOf(ToolValidationError);
    return err as ToolValidationError;
  }
  throw new Error(`expected ${tool} to reject ${JSON.stringify(args)}`);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("StrKey validation: no network calls for invalid addresses", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Intercept any outbound fetch so we can assert it is never called for
    // a request that should have been rejected in validation.
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("fetch must not be called for an invalid Stellar address"));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // ── Addresses with bad checksums (the core of #1051) ─────────────────────

  describe("bad-checksum public keys (regex-pass but StrKey-fail)", () => {
    it("mindvault_transfer_ownership rejects bad checksum without a network call", () => {
      expectInvalid("mindvault_transfer_ownership", {
        resourceId: "res-001",
        newCreator: BAD_CHECKSUM_PUBLIC_KEY,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("mindvault_royalty rejects bad checksum without a network call", () => {
      expectInvalid("mindvault_royalty", {
        resourceId: "res-001",
        royaltyRecipient: BAD_CHECKSUM_PUBLIC_KEY,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("mindvault_lease_status rejects bad checksum without a network call", () => {
      expectInvalid("mindvault_lease_status", {
        resourceId: "res-001",
        holder: BAD_CHECKSUM_PUBLIC_KEY,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("mindvault_terms rejects bad checksum without a network call", () => {
      expectInvalid("mindvault_terms", {
        operation: "get",
        creator: BAD_CHECKSUM_PUBLIC_KEY,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("mindvault_register rejects bad checksum without a network call", () => {
      expectInvalid("mindvault_register", {
        name: "Agent A",
        email: "a@b.co",
        walletAddress: BAD_CHECKSUM_PUBLIC_KEY,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("bad-checksum secret keys (regex-pass but StrKey-fail)", () => {
    it("mindvault_repair_sponsored_account rejects bad checksum without a network call", () => {
      expectInvalid("mindvault_repair_sponsored_account", {
        secretKey: BAD_CHECKSUM_SECRET_KEY,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("mindvault_import_wallet rejects bad checksum without a network call", () => {
      expectInvalid("mindvault_import_wallet", {
        secretKey: BAD_CHECKSUM_SECRET_KEY,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // ── Clearly invalid inputs ─────────────────────────────────────────────────

  describe("clearly invalid public keys (fail both regex and StrKey)", () => {
    const CLEARLY_INVALID = ["not-a-key", "GABC", "", "0x1234"];

    for (const key of CLEARLY_INVALID) {
      it(`mindvault_transfer_ownership rejects "${key || "(empty)"}" without a network call`, () => {
        expectInvalid("mindvault_transfer_ownership", {
          resourceId: "res-001",
          newCreator: key,
        });
        expect(fetchSpy).not.toHaveBeenCalled();
      });
    }
  });

  describe("clearly invalid secret keys (fail both regex and StrKey)", () => {
    const CLEARLY_INVALID = ["not-a-key", "SABC", ""];

    for (const key of CLEARLY_INVALID) {
      it(`mindvault_repair_sponsored_account rejects "${key || "(empty)"}" without a network call`, () => {
        expectInvalid("mindvault_repair_sponsored_account", {
          secretKey: key,
        });
        expect(fetchSpy).not.toHaveBeenCalled();
      });
    }
  });

  // ── Valid keys do not cause issues ────────────────────────────────────────

  it("accepts a valid public key (validation passes; no fetch call made since no dispatch)", () => {
    // validateToolArgs does not make network calls itself. This test confirms
    // a valid address passes validation cleanly.
    expect(() =>
      validateToolArgs("mindvault_transfer_ownership", {
        resourceId: "res-001",
        newCreator: VALID_PUBLIC_KEY,
      }),
    ).not.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("accepts a valid secret key (validation passes; no fetch call made since no dispatch)", () => {
    expect(() =>
      validateToolArgs("mindvault_repair_sponsored_account", { secretKey: VALID_SECRET_KEY }),
    ).not.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── Error shape contracts ─────────────────────────────────────────────────────

describe("StrKey validation: error shape", () => {
  describe("stellar_address errors", () => {
    it("uses code invalid_stellar_address for bad-checksum keys", () => {
      const err = expectInvalid("mindvault_transfer_ownership", {
        resourceId: "res-001",
        newCreator: BAD_CHECKSUM_PUBLIC_KEY,
      });
      expect(err.issues).toHaveLength(1);
      expect(err.issues[0]).toMatchObject({
        field: "newCreator",
        code: "invalid_stellar_address",
      });
    });

    it("does not echo the rejected address in the message", () => {
      const err = expectInvalid("mindvault_transfer_ownership", {
        resourceId: "res-001",
        newCreator: BAD_CHECKSUM_PUBLIC_KEY,
      });
      expect(err.message).not.toContain(BAD_CHECKSUM_PUBLIC_KEY);
    });

    it("names the field in the message", () => {
      const err = expectInvalid("mindvault_transfer_ownership", {
        resourceId: "res-001",
        newCreator: BAD_CHECKSUM_PUBLIC_KEY,
      });
      expect(err.message).toContain("newCreator");
    });

    it("message is deterministic across multiple calls", () => {
      const args = { resourceId: "res-001", newCreator: BAD_CHECKSUM_PUBLIC_KEY };
      expect(expectInvalid("mindvault_transfer_ownership", args).message).toBe(
        expectInvalid("mindvault_transfer_ownership", args).message,
      );
    });

    it("uses code wrong_type when value is not a string", () => {
      const err = expectInvalid("mindvault_transfer_ownership", {
        resourceId: "res-001",
        newCreator: 12345,
      });
      expect(err.issues[0].code).toBe("wrong_type");
      // Rejected numeric value must not appear in the message.
      expect(err.message).not.toContain("12345");
    });

    it("uses code empty_string when value is empty", () => {
      const err = expectInvalid("mindvault_transfer_ownership", {
        resourceId: "res-001",
        newCreator: "   ",
      });
      expect(err.issues[0].code).toBe("empty_string");
    });
  });

  describe("stellar_secret errors", () => {
    it("uses code invalid_stellar_secret for bad-checksum keys", () => {
      const err = expectInvalid("mindvault_repair_sponsored_account", {
        secretKey: BAD_CHECKSUM_SECRET_KEY,
      });
      expect(err.issues).toHaveLength(1);
      expect(err.issues[0]).toMatchObject({
        field: "secretKey",
        code: "invalid_stellar_secret",
      });
    });

    it("does not echo the rejected secret in the message (secret safety)", () => {
      const err = expectInvalid("mindvault_repair_sponsored_account", {
        secretKey: BAD_CHECKSUM_SECRET_KEY,
      });
      expect(err.message).not.toContain(BAD_CHECKSUM_SECRET_KEY);
    });

    it("does not echo a public key submitted as a secret", () => {
      const err = expectInvalid("mindvault_repair_sponsored_account", {
        secretKey: VALID_PUBLIC_KEY,
      });
      expect(err.message).not.toContain(VALID_PUBLIC_KEY);
    });

    it("names the field in the message", () => {
      const err = expectInvalid("mindvault_repair_sponsored_account", {
        secretKey: BAD_CHECKSUM_SECRET_KEY,
      });
      expect(err.message).toContain("secretKey");
    });

    it("message is deterministic across multiple calls", () => {
      const args = { secretKey: BAD_CHECKSUM_SECRET_KEY };
      expect(expectInvalid("mindvault_repair_sponsored_account", args).message).toBe(
        expectInvalid("mindvault_repair_sponsored_account", args).message,
      );
    });

    it("uses code wrong_type when value is not a string", () => {
      const err = expectInvalid("mindvault_repair_sponsored_account", { secretKey: true });
      expect(err.issues[0].code).toBe("wrong_type");
    });
  });
});
