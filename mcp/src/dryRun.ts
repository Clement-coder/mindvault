/**
 * Dry-run mode for MindVault MCP server.
 *
 * Validates inputs and shows intended network, endpoint, resource id, and required
 * wallet state without submitting payment or transactions. Errors during validation
 * are deterministic and agent-safe.
 */

export interface DryRunPublishInput {
  title: string;
  description?: string;
  price: string;
  externalUrl: string;
}

/**
 * Live facts a publish dry run can read before it reports.
 *
 * Every field is optional: a dry run must still succeed when the read behind a
 * field failed, and a caller that has nothing to say simply omits it. What a
 * field cannot be is a guess — the fee below is only ever a published price, and
 * the balance is only ever a balance Horizon actually returned.
 */
export interface DryRunPublishLive {
  /** `agent.pricePerVerification` from the read-only `GET /agent/status`. */
  verificationFee?: number | string | null;
  /** Wallet USDC balance, or null when it could not be read. */
  usdcBalance?: string | null;
  /** Set when a live read failed, so the agent knows the value is missing. */
  readError?: string | null;
}

export interface DryRunPublishResult {
  mode: "dry-run";
  operation: "publish";
  validation: {
    title: { valid: boolean; error?: string };
    price: { valid: boolean; error?: string };
    externalUrl: { valid: boolean; error?: string };
  };
  intentions: {
    network: string;
    endpoint: string;
    /** The paid endpoint a real publish would hit for content verification. */
    verificationEndpoint: string;
    requiresPublisherRegistration: boolean;
    estimatedVerificationFee: string;
    /** Where `estimatedVerificationFee` came from, so it is never mistaken for a quote. */
    verificationFeeSource: "live" | "default";
    requiredWalletState: {
      wallet: boolean;
      publisherApiKey: boolean;
      usdcBalance: string | null;
      /** True only when the live balance is known to cover the fee. */
      coversVerificationFee: boolean | null;
    };
  };
  /** Non-fatal facts the agent should know before a real publish. */
  warnings: string[];
  steps: string[];
}

export interface DryRunBuyResult {
  mode: "dry-run";
  operation: "buy";
  resourceId: string;
  validation: {
    resourceId: { valid: boolean; error?: string };
  };
  intentions: {
    network: string;
    endpoint: string;
    estimatedPrice: string | null;
    requiredWalletState: {
      wallet: boolean;
      usdcBalance: string | null;
    };
  };
  steps: string[];
}

export interface DryRunOnchainResult {
  mode: "dry-run";
  operation:
    | "register-onchain"
    | "update-metadata"
    | "set-price"
    | "transfer-ownership"
    | "set-listed";
  resourceId: string;
  validation: {
    resourceId: { valid: boolean; error?: string };
  };
  intentions: {
    network: string;
    endpoint: string;
    action: string;
    requiredWalletState: {
      wallet: boolean;
      publisherApiKey: boolean;
      xlmForFees: string | null;
    };
  };
  steps: string[];
}

/** Validate a resource title. */
function validateTitle(title: unknown): { valid: boolean; error?: string } {
  if (!title || typeof title !== "string") {
    return { valid: false, error: "Title must be a non-empty string" };
  }
  if (title.length < 1 || title.length > 256) {
    return { valid: false, error: "Title must be 1–256 characters" };
  }
  return { valid: true };
}

/** Validate a price (decimal USDC string). */
function validatePrice(price: unknown): { valid: boolean; error?: string } {
  if (!price || typeof price !== "string") {
    return { valid: false, error: "Price must be a decimal string (e.g., '5.00')" };
  }
  const parsed = parseFloat(price);
  if (isNaN(parsed) || parsed < 0) {
    return { valid: false, error: "Price must be a valid decimal >= 0" };
  }
  if (!/^\d+(\.\d{1,2})?$/.test(price)) {
    return { valid: false, error: "Price must have at most 2 decimal places" };
  }
  return { valid: true };
}

/** Validate a URL (http/https only). */
function validateUrl(url: unknown): { valid: boolean; error?: string } {
  if (!url || typeof url !== "string") {
    return { valid: false, error: "URL must be a non-empty string" };
  }
  try {
    const parsed = new URL(url);
    if (!parsed.protocol.startsWith("http")) {
      return { valid: false, error: "URL must use http or https protocol" };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: "Invalid URL format" };
  }
}

/** Validate a resource ID (alphanumeric + dash/dot/underscore). */
function validateResourceId(id: unknown): { valid: boolean; error?: string } {
  if (!id || typeof id !== "string") {
    return { valid: false, error: "Resource ID must be a non-empty string" };
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) {
    return {
      valid: false,
      error: "Resource ID must contain only letters, digits, dot, dash, or underscore",
    };
  }
  if (id.length > 256) {
    return { valid: false, error: "Resource ID must be at most 256 characters" };
  }
  return { valid: true };
}

/**
 * Fee reported when the live price could not be read.
 *
 * Deliberately a string, not a number: the point is to signal "this is the
 * commonly configured value, not what the server charges right now". The
 * `verificationFeeSource` field on the result says so explicitly.
 */
export const DEFAULT_VERIFICATION_FEE = "~0.10";

/** Format a live fee for display, preserving the server's own precision. */
function formatVerificationFee(fee: number | string): string {
  return typeof fee === "number" ? String(fee) : fee;
}

/**
 * Render the fee for the step list.
 *
 * The value is passed through unqualified: whether it is live or the default is
 * reported structurally in `intentions.verificationFeeSource` and in
 * `warnings`, so the agent does not have to parse prose to tell a quote from a
 * placeholder.
 */
function renderFeeText(fee: string): string {
  return fee;
}

/** Perform dry-run validation for publish. */
export function dryRunPublish(
  input: DryRunPublishInput,
  network: string,
  baseUrl: string,
  hasWallet: boolean,
  hasApiKey: boolean,
  live: DryRunPublishLive = {},
): DryRunPublishResult {
  const titleVal = validateTitle(input.title);
  const priceVal = validatePrice(input.price);
  const urlVal = validateUrl(input.externalUrl);

  const allValid = titleVal.valid && priceVal.valid && urlVal.valid;

  // A fee is only reported as live when the server actually returned one.
  const liveFee = live.verificationFee;
  const hasLiveFee = liveFee !== undefined && liveFee !== null && liveFee !== "";
  const feeSource: "live" | "default" = hasLiveFee ? "live" : "default";
  const estimatedVerificationFee = hasLiveFee
    ? formatVerificationFee(liveFee as number | string)
    : DEFAULT_VERIFICATION_FEE;
  const feeText = renderFeeText(estimatedVerificationFee);

  // The balance is only ever what Horizon returned. `undefined` means the read
  // did not happen or failed, which is not the same claim as a zero balance.
  const usdcBalance = live.usdcBalance ?? null;
  const coversVerificationFee =
    usdcBalance === null || !hasLiveFee ? null : Number(usdcBalance) >= Number(liveFee);

  const warnings: string[] = [];
  if (live.readError) {
    warnings.push(
      `Live fee and balance could not be read: ${live.readError}. Fee shown is the default, not a quote.`,
    );
  } else if (!hasLiveFee) {
    warnings.push(
      "Verification fee was not returned by /agent/status; the default is shown, not a quote.",
    );
  }
  if (hasWallet && coversVerificationFee === false) {
    warnings.push(
      `Wallet holds ${usdcBalance} USDC, which does not cover the ${estimatedVerificationFee} USDC verification fee. Publish will create the resource but stop before verification.`,
    );
  }
  if (hasWallet && usdcBalance !== null && !hasLiveFee) {
    warnings.push(
      "Balance was read but the fee was not, so affordability could not be determined. Check with mindvault_agent_status.",
    );
  }
  if (!hasApiKey) {
    warnings.push("No publisher API key in the active profile; run mindvault_register first.");
  }

  return {
    mode: "dry-run",
    operation: "publish",
    validation: {
      title: titleVal,
      price: priceVal,
      externalUrl: urlVal,
    },
    intentions: {
      network,
      endpoint: `POST ${baseUrl}/resources (then verify, then register on-chain)`,
      verificationEndpoint: `POST ${baseUrl}/verify-content (x402 payment, paid)`,
      requiresPublisherRegistration: !hasApiKey,
      estimatedVerificationFee,
      verificationFeeSource: feeSource,
      requiredWalletState: {
        wallet: hasWallet,
        publisherApiKey: hasApiKey,
        usdcBalance,
        coversVerificationFee,
      },
    },
    warnings,
    steps: allValid
      ? [
          "1. Create resource record via POST /resources",
          `2. Sign x402 payment for verification (${feeText} USDC)`,
          "3. Submit payment-signed request to POST /verify-content",
          "4. Await AI verification result (isOriginal flag)",
          "5. If approved, trigger on-chain registration (best-effort)",
          "6. Return resource ID, access URL, and verification status",
        ]
      : ["Validation failed; see errors above"],
  };
}

/** Perform dry-run validation for buy. */
export function dryRunBuy(
  resourceId: string,
  network: string,
  baseUrl: string,
  hasWallet: boolean,
  estimatedPrice: string | null = null,
): DryRunBuyResult {
  const idVal = validateResourceId(resourceId);

  return {
    mode: "dry-run",
    operation: "buy",
    resourceId,
    validation: {
      resourceId: idVal,
    },
    intentions: {
      network,
      endpoint: `GET ${baseUrl}/resources/${resourceId} (with x402 payment proof)`,
      estimatedPrice: estimatedPrice ?? "Fetch from mindvault_preview before buying",
      requiredWalletState: {
        wallet: hasWallet,
        usdcBalance: "Must be >= estimated price",
      },
    },
    steps: idVal.valid
      ? [
          "1. Fetch resource metadata to confirm price",
          "2. Verify wallet has sufficient USDC balance",
          "3. Create x402 payment authorization (sign payment tx)",
          "4. Retry request with payment proof attached",
          "5. On success, receive access URL and persist purchase receipt",
        ]
      : ["Validation failed; see errors above"],
  };
}

/** Perform dry-run validation for on-chain mutations. */
export function dryRunOnchain(
  operation: DryRunOnchainResult["operation"],
  resourceId: string,
  network: string,
  baseUrl: string,
  hasWallet: boolean,
  hasApiKey: boolean,
): DryRunOnchainResult {
  const idVal = validateResourceId(resourceId);

  const actionMap: Record<DryRunOnchainResult["operation"], string> = {
    "register-onchain": "Register verified resource on-chain vault-registry contract",
    "update-metadata": "Update resource on-chain metadata pointer",
    "set-price": "Update resource on-chain USDC price",
    "transfer-ownership": "Transfer resource ownership to new wallet address",
    "set-listed": "Update resource on-chain listing status",
  };

  return {
    mode: "dry-run",
    operation,
    resourceId,
    validation: {
      resourceId: idVal,
    },
    intentions: {
      network,
      endpoint: `Soroban contract call via ${baseUrl} (prepare unsigned, sign with agent wallet)`,
      action: actionMap[operation],
      requiredWalletState: {
        wallet: hasWallet,
        publisherApiKey: hasApiKey,
        xlmForFees: "~0.001 XLM per invocation (check with mindvault_wallet_info)",
      },
    },
    steps: idVal.valid
      ? [
          "1. Fetch resource details (confirm resource exists and you own it)",
          "2. Prepare unsigned Soroban transaction via server",
          "3. Sign transaction with agent wallet (private key held locally)",
          "4. Submit signed transaction via Soroban RPC",
          "5. Poll transaction status until settled",
          "6. Return on-chain tx hash and new state",
        ]
      : ["Validation failed; see errors above"],
  };
}
