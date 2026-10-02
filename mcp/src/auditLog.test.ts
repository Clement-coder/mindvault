/**
 * Tests for audit logging with automatic secret redaction.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  initAuditLogging,
  isAuditLogEnabled,
  setAuditLogEnabled,
  logToolStart,
  logToolSuccess,
  logToolError,
  logNetworkRequest,
  logPaymentInitiation,
  logPaymentSuccess,
  logPaymentError,
  logOnchainTransaction,
  logWalletOperation,
} from "./auditLog.js";

describe("auditLog – initialization and control", () => {
  afterEach(() => {
    setAuditLogEnabled(false);
  });

  it("is disabled by default", () => {
    expect(isAuditLogEnabled()).toBe(false);
  });

  it("can be enabled via environment variable", () => {
    initAuditLogging({ MINDVAULT_AUDIT_LOG: "1" });
    expect(isAuditLogEnabled()).toBe(true);
  });

  it("stays disabled when env var is not set", () => {
    initAuditLogging({});
    expect(isAuditLogEnabled()).toBe(false);
  });

  it("can be toggled programmatically", () => {
    setAuditLogEnabled(true);
    expect(isAuditLogEnabled()).toBe(true);
    setAuditLogEnabled(false);
    expect(isAuditLogEnabled()).toBe(false);
  });
});

describe("auditLog – tool operation logging", () => {
  beforeEach(() => {
    setAuditLogEnabled(true);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    setAuditLogEnabled(false);
    vi.restoreAllMocks();
  });

  it("logs tool start with tool name", () => {
    logToolStart("mindvault_publish");
    expect(console.error).toHaveBeenCalled();
    const logged = JSON.parse((console.error as any).mock.calls[0][0]);
    expect(logged.toolName).toBe("mindvault_publish");
    expect(logged.status).toBe("start");
    expect(logged.timestamp).toBeDefined();
  });

  it("logs tool start with redacted arguments", () => {
    const args = {
      title: "Test",
      secretKey: "S1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEF",
      apiKey: "sk_live_1234567890",
    };
    logToolStart("mindvault_publish", args);
    const logged = JSON.parse((console.error as any).mock.calls[0][0]);
    expect(logged.details.title).toBe("Test");
    expect(logged.details.secretKey).toBe("[REDACTED]");
    expect(logged.details.apiKey).toBe("[REDACTED]");
  });

  it("logs tool success with duration and resource info", () => {
    logToolSuccess("mindvault_publish", 1500, {
      resourceId: "res-001",
      txHash: "abc123",
      network: "stellar:testnet",
    });
    const logged = JSON.parse((console.error as any).mock.calls[0][0]);
    expect(logged.status).toBe("success");
    expect(logged.duration).toBe(1500);
    expect(logged.resourceId).toBe("res-001");
    expect(logged.txHash).toBe("abc123");
    expect(logged.network).toBe("stellar:testnet");
  });

  it("logs tool error with duration and context", () => {
    const error = new Error("Payment failed");
    logToolError("mindvault_buy", 800, error, {
      resourceId: "res-001",
      errorCategory: "payment",
      httpStatus: 402,
    });
    const logged = JSON.parse((console.error as any).mock.calls[0][0]);
    expect(logged.status).toBe("error");
    expect(logged.duration).toBe(800);
    expect(logged.message).toBe("Payment failed");
    expect(logged.resourceId).toBe("res-001");
    expect(logged.errorCategory).toBe("payment");
    expect(logged.httpStatus).toBe(402);
  });

  it("redacts secret keys in error messages", () => {
    const error = new Error("Failed: S1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEF");
    logToolError("mindvault_setup_wallet", 500, error);
    const logged = JSON.parse((console.error as any).mock.calls[0][0]);
    expect(logged.message).not.toContain("S1234567890");
    expect(logged.message).toContain("[REDACTED]");
  });
});

describe("auditLog – network request logging", () => {
  beforeEach(() => {
    setAuditLogEnabled(true);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    setAuditLogEnabled(false);
    vi.restoreAllMocks();
  });

  it("logs network request with method, endpoint, status, duration, source", () => {
    logNetworkRequest("POST", "https://api.example.com/resources", "api", 201, 150);
    const logged = JSON.parse((console.error as any).mock.calls[0][0]);
    expect(logged.method).toBe("POST");
    expect(logged.endpoint).toBe("https://api.example.com/resources");
    expect(logged.status).toBe(201);
    expect(logged.duration).toBe(150);
    expect(logged.source).toBe("api");
  });

  it("logs different sources (api, x402, horizon, soroban, registry, sponsored)", () => {
    const sources = ["api", "x402", "horizon", "soroban", "registry", "sponsored"] as const;
    for (const source of sources) {
      vi.clearAllMocks();
      logNetworkRequest("GET", "https://example.com", source, 200, 100);
      const logged = JSON.parse((console.error as any).mock.calls[0][0]);
      expect(logged.source).toBe(source);
    }
  });

  it("includes transaction hash when available", () => {
    logNetworkRequest("POST", "https://example.com", "x402", 200, 200, {
      txHash: "abc123txhash",
    });
    const logged = JSON.parse((console.error as any).mock.calls[0][0]);
    expect(logged.txHash).toBe("abc123txhash");
  });

  it("redacts secrets in endpoint URLs", () => {
    logNetworkRequest("GET", "https://api.example.com?key=sk_live_secret123", "api", 200, 100);
    const logged = JSON.parse((console.error as any).mock.calls[0][0]);
    expect(logged.endpoint).not.toContain("sk_live_secret123");
    expect(logged.endpoint).toContain("[REDACTED]");
  });

  it("includes error summary when available", () => {
    logNetworkRequest("GET", "https://example.com", "api", 500, 300, {
      errorSummary: "Internal server error: database connection failed",
    });
    const logged = JSON.parse((console.error as any).mock.calls[0][0]);
    expect(logged.errorSummary).toBe("Internal server error: database connection failed");
  });

  it("captures a redacted request payload snapshot", () => {
    logNetworkRequest("POST", "https://example.com", "api", 201, 100, {
      requestPayload: {
        title: "Research notes",
        credentials: { apiKey: "sk_live_1234567890abcdef" },
        authorization: "Bearer token-that-must-not-appear",
      },
    });
    const logged = JSON.parse((console.error as any).mock.calls[0][0]);
    expect(logged.requestPayload.title).toBe("Research notes");
    expect(logged.requestPayload.credentials.apiKey).toBe("[REDACTED]");
    expect(logged.requestPayload.authorization).toBe("[REDACTED]");
  });
});

describe("auditLog – payment logging", () => {
  beforeEach(() => {
    setAuditLogEnabled(true);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    setAuditLogEnabled(false);
    vi.restoreAllMocks();
  });

  it("logs payment initiation", () => {
    logPaymentInitiation("res-001", "10.50", "stellar:testnet");
    const logged = JSON.parse((console.error as any).mock.calls[0][0]);
    expect(logged.toolName).toBe("x402-payment");
    expect(logged.status).toBe("start");
    expect(logged.resourceId).toBe("res-001");
    expect(logged.network).toBe("stellar:testnet");
    expect(logged.message).toContain("10.50 USDC");
  });

  it("logs payment success with tx hash", () => {
    logPaymentSuccess("res-001", "10.50", "txhash123", 2000);
    const logged = JSON.parse((console.error as any).mock.calls[0][0]);
    expect(logged.status).toBe("success");
    expect(logged.duration).toBe(2000);
    expect(logged.txHash).toBe("txhash123");
    expect(logged.message).toContain("10.50 USDC");
  });

  it("logs payment failure with status code", () => {
    logPaymentError("res-001", new Error("Insufficient funds"), 402, 500);
    const logged = JSON.parse((console.error as any).mock.calls[0][0]);
    expect(logged.status).toBe("error");
    expect(logged.httpStatus).toBe(402);
    expect(logged.message).toContain("Insufficient funds");
  });
});

describe("auditLog – on-chain transaction logging", () => {
  beforeEach(() => {
    setAuditLogEnabled(true);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    setAuditLogEnabled(false);
    vi.restoreAllMocks();
  });

  it("logs on-chain transaction submission", () => {
    logOnchainTransaction("register", "res-001", "onchain-tx-hash", 1500, true);
    const logged = JSON.parse((console.error as any).mock.calls[0][0]);
    expect(logged.toolName).toBe("onchain-register");
    expect(logged.status).toBe("success");
    expect(logged.resourceId).toBe("res-001");
    expect(logged.txHash).toBe("onchain-tx-hash");
    expect(logged.duration).toBe(1500);
  });

  it("logs on-chain transaction failure", () => {
    logOnchainTransaction("update-metadata", "res-002", null, 800, false);
    const logged = JSON.parse((console.error as any).mock.calls[0][0]);
    expect(logged.status).toBe("error");
    expect(logged.txHash).toBeUndefined();
  });
});

describe("auditLog – wallet operation logging", () => {
  beforeEach(() => {
    setAuditLogEnabled(true);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    setAuditLogEnabled(false);
    vi.restoreAllMocks();
  });

  it("logs wallet setup operation", () => {
    logWalletOperation("setup", true, 2000, "Wallet created");
    const logged = JSON.parse((console.error as any).mock.calls[0][0]);
    expect(logged.toolName).toBe("wallet-setup");
    expect(logged.status).toBe("success");
    expect(logged.duration).toBe(2000);
  });

  it("logs wallet info operation", () => {
    logWalletOperation("info", true, 500);
    const logged = JSON.parse((console.error as any).mock.calls[0][0]);
    expect(logged.toolName).toBe("wallet-info");
  });

  it("logs wallet reset operation", () => {
    logWalletOperation("reset", true, 300, "State cleared");
    const logged = JSON.parse((console.error as any).mock.calls[0][0]);
    expect(logged.toolName).toBe("wallet-reset");
  });

  it("redacts secrets in wallet operation messages", () => {
    logWalletOperation(
      "setup",
      true,
      1000,
      "Wallet S1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEF created",
    );
    const logged = JSON.parse((console.error as any).mock.calls[0][0]);
    expect(logged.message).not.toContain("S1234567890");
    expect(logged.message).toContain("[REDACTED]");
  });
});

describe("auditLog – disabled logging produces no output", () => {
  beforeEach(() => {
    setAuditLogEnabled(false);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not log when disabled", () => {
    logToolStart("mindvault_publish");
    logToolSuccess("mindvault_publish", 1000);
    logNetworkRequest("GET", "https://example.com", "api", 200, 100);
    expect(console.error).not.toHaveBeenCalled();
  });
});
