/**
 * Tests for issue #1049: wallet import/repair validation errors must never echo
 * submitted secret key material back to the caller.
 *
 * Each test submits an invalid secret key fixture and asserts that neither the
 * error message nor any structured output contains the submitted value.
 * This ensures that a mistyped passphrase or secret seed cannot leak into an
 * agent transcript or log.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { validateToolArgs, ToolValidationError } from "./validation.js";

// ---------------------------------------------------------------------------
// Fixtures — deliberately invalid secret key values that must not appear in any
// error or log output after validation.
// ---------------------------------------------------------------------------

/** Looks like a Stellar seed but is one character short (55 chars, not 56). */
const SHORT_SECRET = "SABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV";

/** Correct length but starts with the wrong letter (G = public key prefix). */
const WRONG_PREFIX_SECRET = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";

/** Completely arbitrary string that could be a password accidentally passed as secretKey. */
const PLAINTEXT_SECRET = "my-super-secret-password-12345";

/** All-zeros fake secret (still a well-formed S… key, length 56). */
const ZERO_SECRET = "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

// ---------------------------------------------------------------------------
// Validation layer (mindvault_import_wallet)
// ---------------------------------------------------------------------------

describe("mindvault_import_wallet — validation layer does not echo secret", () => {
  it("pattern_mismatch error for a short secret key does not echo the value", () => {
    let err: ToolValidationError | undefined;
    try {
      validateToolArgs("mindvault_import_wallet", { secretKey: SHORT_SECRET });
    } catch (e) {
      err = e as ToolValidationError;
    }
    expect(err).toBeInstanceOf(ToolValidationError);
    expect(err!.message).not.toContain(SHORT_SECRET);
    for (const issue of err!.issues) {
      expect(issue.message).not.toContain(SHORT_SECRET);
    }
  });

  it("pattern_mismatch error for a wrong-prefix secret does not echo the value", () => {
    let err: ToolValidationError | undefined;
    try {
      validateToolArgs("mindvault_import_wallet", { secretKey: WRONG_PREFIX_SECRET });
    } catch (e) {
      err = e as ToolValidationError;
    }
    expect(err).toBeInstanceOf(ToolValidationError);
    expect(err!.message).not.toContain(WRONG_PREFIX_SECRET);
    for (const issue of err!.issues) {
      expect(issue.message).not.toContain(WRONG_PREFIX_SECRET);
    }
  });

  it("pattern_mismatch error for an arbitrary string secret does not echo the value", () => {
    let err: ToolValidationError | undefined;
    try {
      validateToolArgs("mindvault_import_wallet", { secretKey: PLAINTEXT_SECRET });
    } catch (e) {
      err = e as ToolValidationError;
    }
    expect(err).toBeInstanceOf(ToolValidationError);
    expect(err!.message).not.toContain(PLAINTEXT_SECRET);
    for (const issue of err!.issues) {
      expect(issue.message).not.toContain(PLAINTEXT_SECRET);
    }
  });

  it("issue code is pattern_mismatch for a malformed secret key", () => {
    let err: ToolValidationError | undefined;
    try {
      validateToolArgs("mindvault_import_wallet", { secretKey: SHORT_SECRET });
    } catch (e) {
      err = e as ToolValidationError;
    }
    expect(err).toBeInstanceOf(ToolValidationError);
    const issue = err!.issues.find((i) => i.field === "secretKey");
    expect(issue?.code).toBe("pattern_mismatch");
  });
});

// ---------------------------------------------------------------------------
// Validation layer (mindvault_repair_sponsored_account)
// ---------------------------------------------------------------------------

describe("mindvault_repair_sponsored_account — validation layer does not echo secret", () => {
  it("pattern_mismatch error for a short secret key does not echo the value", () => {
    let err: ToolValidationError | undefined;
    try {
      validateToolArgs("mindvault_repair_sponsored_account", { secretKey: SHORT_SECRET });
    } catch (e) {
      err = e as ToolValidationError;
    }
    expect(err).toBeInstanceOf(ToolValidationError);
    expect(err!.message).not.toContain(SHORT_SECRET);
    for (const issue of err!.issues) {
      expect(issue.message).not.toContain(SHORT_SECRET);
    }
  });

  it("pattern_mismatch error for an arbitrary string secret does not echo the value", () => {
    let err: ToolValidationError | undefined;
    try {
      validateToolArgs("mindvault_repair_sponsored_account", { secretKey: PLAINTEXT_SECRET });
    } catch (e) {
      err = e as ToolValidationError;
    }
    expect(err).toBeInstanceOf(ToolValidationError);
    expect(err!.message).not.toContain(PLAINTEXT_SECRET);
    for (const issue of err!.issues) {
      expect(issue.message).not.toContain(PLAINTEXT_SECRET);
    }
  });

  it("issue code is pattern_mismatch for a malformed secret key", () => {
    let err: ToolValidationError | undefined;
    try {
      validateToolArgs("mindvault_repair_sponsored_account", { secretKey: SHORT_SECRET });
    } catch (e) {
      err = e as ToolValidationError;
    }
    expect(err).toBeInstanceOf(ToolValidationError);
    const issue = err!.issues.find((i) => i.field === "secretKey");
    expect(issue?.code).toBe("pattern_mismatch");
  });

  it("missing_required error (no secretKey) does not contain any secret material", () => {
    let err: ToolValidationError | undefined;
    try {
      validateToolArgs("mindvault_repair_sponsored_account", {});
    } catch (e) {
      err = e as ToolValidationError;
    }
    expect(err).toBeInstanceOf(ToolValidationError);
    expect(err!.message).not.toContain(ZERO_SECRET);
    const issue = err!.issues.find((i) => i.field === "secretKey");
    expect(issue?.code).toBe("missing_required");
  });
});

// ---------------------------------------------------------------------------
// repairSponsoredAccount runtime — SDK parse error does not echo the secret
// ---------------------------------------------------------------------------

describe("repairSponsoredAccount runtime — SDK errors do not echo the secret", () => {
  beforeEach(() => {
    // Simulate the Stellar SDK throwing an error that might naively include the
    // bad key in its message — the fix must catch and redact it.
    vi.doMock("@stellar/stellar-sdk", () => ({
      Keypair: {
        fromSecret: vi.fn().mockImplementation((key: string) => {
          throw new Error(`Invalid secret key: "${key}" is not a valid Stellar seed`);
        }),
      },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("error message does not contain the submitted secret key value", async () => {
    // We drive the tool through the dispatch path directly to exercise the
    // runtime guard added around Keypair.fromSecret.
    const { dispatchTool } = await import("./index.js");
    await expect(
      dispatchTool("mindvault_repair_sponsored_account", { secretKey: ZERO_SECRET }),
    ).rejects.toThrow(expect.not.stringContaining(ZERO_SECRET));
  });

  it("error message describes the shape problem, not the value", async () => {
    const { dispatchTool } = await import("./index.js");
    await expect(
      dispatchTool("mindvault_repair_sponsored_account", { secretKey: ZERO_SECRET }),
    ).rejects.toThrow(/invalid stellar secret key|could not derive public key/i);
  });
});
