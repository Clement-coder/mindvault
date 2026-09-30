/**
 * Integrity checks for wallets the sponsored-account service hands back (#839).
 *
 * `mindvault_setup_wallet` posts to an external service, which mints a Stellar
 * account, funds its reserve, adds the USDC trustline, and returns the keypair.
 * The server used to persist whatever came back:
 *
 *     activeProfile().wallet = { publicKey: res.data.publicKey, secretKey: res.data.secretKey };
 *
 * That trusts a remote service to be well-formed on a path where being wrong is
 * expensive. If creation half-completes — the service funds the account and
 * then times out, restarts, or answers from a proxy with a truncated body — the
 * reply can carry an address with no secret, or a secret that belongs to a
 * different account. Persisting it produces the failure mode in the issue: a
 * profile naming a *funded* address that the local keystore cannot sign for.
 *
 * Everything downstream then reads as healthy. `mindvault_wallet_info` shows
 * the address and queries Horizon, so it reports a real balance; diagnostics
 * report a wallet present; the agent believes it is ready to pay. The truth only
 * surfaces later, as an opaque signing failure inside an x402 payment.
 *
 * So the keypair is verified at the boundary instead: the address must be
 * derivable *from the secret we hold*. That single check distinguishes "we own
 * this account" from "we know this account's address", which is the whole
 * question. It also covers the stored state, because a profile can reach the
 * same broken shape through a hand-edited state file or a restored backup.
 *
 * The module is pure and takes its key derivation as an argument, so it is
 * unit-testable without the Stellar SDK and cannot itself perform I/O.
 */

/** Stellar strkey shapes. Ed25519 public keys are G…, secret seeds are S…. */
const PUBLIC_KEY_PATTERN = /^G[A-Z2-7]{55}$/;
const SECRET_KEY_PATTERN = /^S[A-Z2-7]{55}$/;

/** Why a keypair cannot be trusted. Stable codes so callers can branch. */
export type WalletIntegrityCode =
  | "missing_public_key"
  | "missing_secret_key"
  | "malformed_public_key"
  | "malformed_secret_key"
  | "underivable_secret_key"
  | "address_mismatch";

export interface WalletIntegrityFailure {
  ok: false;
  code: WalletIntegrityCode;
  /** Agent-safe explanation. Never contains the secret or any part of it. */
  message: string;
}

export interface WalletIntegrityOk {
  ok: true;
  publicKey: string;
  secretKey: string;
}

export type WalletIntegrityResult = WalletIntegrityOk | WalletIntegrityFailure;

/** Derives the Stellar address for a secret seed; throws when the seed is invalid. */
export type DerivePublicKey = (secretKey: string) => string;

function failure(code: WalletIntegrityCode, message: string): WalletIntegrityFailure {
  return { ok: false, code, message };
}

/**
 * Verify that a keypair is well-formed and that the secret really owns the
 * address.
 *
 * The address is never echoed on the mismatch path beyond its own value (which
 * is public), and the secret is never echoed at all — a malformed secret is
 * described by shape, not quoted, because this message reaches the agent and
 * may be logged.
 */
export function checkWalletIntegrity(
  candidate: { publicKey?: unknown; secretKey?: unknown },
  derivePublicKey: DerivePublicKey,
): WalletIntegrityResult {
  const publicKey = typeof candidate.publicKey === "string" ? candidate.publicKey.trim() : "";
  const secretKey = typeof candidate.secretKey === "string" ? candidate.secretKey.trim() : "";

  if (!publicKey) {
    return failure("missing_public_key", "the response carried no account address");
  }
  if (!secretKey) {
    return failure(
      "missing_secret_key",
      `the response carried the address ${publicKey} but no secret key, so this agent cannot sign for it`,
    );
  }
  if (!PUBLIC_KEY_PATTERN.test(publicKey)) {
    return failure(
      "malformed_public_key",
      "the account address is not a Stellar public key (expected G followed by 55 base32 characters)",
    );
  }
  if (!SECRET_KEY_PATTERN.test(secretKey)) {
    return failure(
      "malformed_secret_key",
      "the secret key is not a Stellar seed (expected S followed by 55 base32 characters)",
    );
  }

  let derived: string;
  try {
    derived = derivePublicKey(secretKey);
  } catch {
    return failure(
      "underivable_secret_key",
      "the secret key could not be parsed as a Stellar seed, so no address can be derived from it",
    );
  }

  if (derived !== publicKey) {
    return failure(
      "address_mismatch",
      `the secret key belongs to ${derived}, not to the returned address ${publicKey}`,
    );
  }

  return { ok: true, publicKey, secretKey };
}

/**
 * The error raised when the sponsored-account service returns a keypair the
 * agent cannot use.
 *
 * It states three things the agent needs and cannot infer: nothing was
 * persisted (so the local keystore is unchanged), the account the service may
 * already have funded is unreachable without its secret, and a retry mints a
 * fresh account rather than recovering that one.
 */
export function sponsoredWalletIntegrityError(
  failureResult: WalletIntegrityFailure,
  service: string,
): Error {
  return new Error(
    [
      `mindvault_setup_wallet refused the wallet returned by ${service}: ${failureResult.message}.`,
      "Nothing was persisted — the local keystore is unchanged.",
      "If the service already funded that account, it is orphaned: without the matching secret",
      "key nobody can spend from it, and retrying creates a new account rather than recovering it.",
      "Retry mindvault_setup_wallet; if this repeats, the sponsored-account service is returning",
      "incomplete responses and should be reported rather than retried in a loop.",
    ].join(" "),
  );
}

/**
 * The note `mindvault_wallet_info` adds when the stored keypair fails the same
 * check, so a balance shown for an address the agent cannot sign for is never
 * presented as spendable funds.
 */
export function unownedWalletNote(failureResult: WalletIntegrityFailure): string {
  return (
    `This profile's stored secret key does not own this address (${failureResult.message}). ` +
    "Any balance shown here is NOT spendable by this agent: payments will fail at signing. " +
    "Run mindvault_import_wallet with the correct secret key, or mindvault_setup_wallet to create a new wallet."
  );
}
