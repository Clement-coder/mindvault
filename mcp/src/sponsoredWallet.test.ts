/**
 * Tests for the sponsored-wallet integrity checks (#839).
 *
 * The property under test is ownership, not well-formedness: a keypair passes
 * only when the secret this agent holds derives the address it was handed. Each
 * way a half-completed creation can break that is covered, because each one
 * otherwise persists as a "healthy" wallet the agent cannot sign for.
 */
import { describe, it, expect } from "vitest";
import {
  checkWalletIntegrity,
  sponsoredWalletIntegrityError,
  unownedWalletNote,
  type DerivePublicKey,
  type WalletIntegrityFailure,
} from "./sponsoredWallet.js";

/** A valid-looking keypair; the fake derivation below makes it self-consistent. */
const PUBLIC_A = "GAGENTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SECRET_A = "SAGENTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PUBLIC_B = "GBGENTBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const SECRET_B = "SBGENTBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

/** Stand-in for Keypair.fromSecret().publicKey(), so tests need no SDK. */
const derive: DerivePublicKey = (secret) => {
  if (secret === SECRET_A) return PUBLIC_A;
  if (secret === SECRET_B) return PUBLIC_B;
  throw new Error("invalid seed");
};

function failureOf(result: ReturnType<typeof checkWalletIntegrity>): WalletIntegrityFailure {
  if (result.ok) throw new Error("expected the keypair to be rejected");
  return result;
}

describe("checkWalletIntegrity", () => {
  it("accepts a keypair whose secret derives its address", () => {
    const result = checkWalletIntegrity({ publicKey: PUBLIC_A, secretKey: SECRET_A }, derive);
    expect(result).toEqual({ ok: true, publicKey: PUBLIC_A, secretKey: SECRET_A });
  });

  it("trims surrounding whitespace from both keys", () => {
    const result = checkWalletIntegrity(
      { publicKey: `  ${PUBLIC_A}\n`, secretKey: ` ${SECRET_A} ` },
      derive,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects the funded-address-without-a-secret case", () => {
    // The shape a creation that funds then times out can leave behind.
    const failure = failureOf(checkWalletIntegrity({ publicKey: PUBLIC_A }, derive));
    expect(failure.code).toBe("missing_secret_key");
    expect(failure.message).toContain(PUBLIC_A);
    expect(failure.message).toContain("cannot sign");
  });

  it("rejects a secret that belongs to a different account", () => {
    const failure = failureOf(
      checkWalletIntegrity({ publicKey: PUBLIC_A, secretKey: SECRET_B }, derive),
    );
    expect(failure.code).toBe("address_mismatch");
    expect(failure.message).toContain(PUBLIC_B);
    expect(failure.message).toContain(PUBLIC_A);
  });

  it("rejects a response with no address at all", () => {
    expect(failureOf(checkWalletIntegrity({}, derive)).code).toBe("missing_public_key");
    expect(failureOf(checkWalletIntegrity({ secretKey: SECRET_A }, derive)).code).toBe(
      "missing_public_key",
    );
  });

  it("rejects malformed strkeys before attempting derivation", () => {
    let derivations = 0;
    const counting: DerivePublicKey = (secret) => {
      derivations += 1;
      return derive(secret);
    };
    expect(
      failureOf(
        checkWalletIntegrity({ publicKey: "not-an-address", secretKey: SECRET_A }, counting),
      ).code,
    ).toBe("malformed_public_key");
    expect(
      failureOf(checkWalletIntegrity({ publicKey: PUBLIC_A, secretKey: "nope" }, counting)).code,
    ).toBe("malformed_secret_key");
    expect(derivations).toBe(0);
  });

  it("rejects non-string fields rather than coercing them", () => {
    expect(
      failureOf(checkWalletIntegrity({ publicKey: 42, secretKey: SECRET_A }, derive)).code,
    ).toBe("missing_public_key");
    expect(
      failureOf(checkWalletIntegrity({ publicKey: PUBLIC_A, secretKey: { s: 1 } }, derive)).code,
    ).toBe("missing_secret_key");
  });

  it("reports a seed the SDK cannot parse instead of throwing", () => {
    const wellFormedButInvalid = `S${"A".repeat(55)}`;
    const failure = failureOf(
      checkWalletIntegrity({ publicKey: PUBLIC_A, secretKey: wellFormedButInvalid }, derive),
    );
    expect(failure.code).toBe("underivable_secret_key");
  });

  it("never echoes the secret key in a failure message", () => {
    const messages = [
      failureOf(checkWalletIntegrity({ publicKey: PUBLIC_A, secretKey: SECRET_B }, derive)).message,
      failureOf(checkWalletIntegrity({ publicKey: PUBLIC_A, secretKey: "nope" }, derive)).message,
      failureOf(
        checkWalletIntegrity({ publicKey: PUBLIC_A, secretKey: `S${"A".repeat(55)}` }, derive),
      ).message,
    ];
    for (const message of messages) {
      expect(message).not.toContain(SECRET_A);
      expect(message).not.toContain(SECRET_B);
      expect(message).not.toMatch(/S[A-Z2-7]{55}/);
    }
  });
});

describe("sponsoredWalletIntegrityError", () => {
  const failure = failureOf(
    checkWalletIntegrity({ publicKey: PUBLIC_A, secretKey: SECRET_B }, derive),
  );
  const error = sponsoredWalletIntegrityError(failure, "https://sponsor.example");

  it("states that nothing was persisted", () => {
    expect(error.message).toContain("Nothing was persisted");
    expect(error.message).toContain("local keystore is unchanged");
  });

  it("warns that a funded account may be orphaned rather than recoverable", () => {
    expect(error.message).toContain("orphaned");
    expect(error.message).toContain("retrying creates a new account");
  });

  it("names the service and the specific defect", () => {
    expect(error.message).toContain("https://sponsor.example");
    expect(error.message).toContain(failure.message);
  });
});

describe("unownedWalletNote", () => {
  it("says the displayed balance is not spendable", () => {
    const failure = failureOf(checkWalletIntegrity({ publicKey: PUBLIC_A }, derive));
    const note = unownedWalletNote(failure);
    expect(note).toContain("does not own this address");
    expect(note).toContain("NOT spendable");
    expect(note).toContain("mindvault_import_wallet");
  });
});
