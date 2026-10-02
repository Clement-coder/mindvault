import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { logger } from "./logger.js";

describe("MCP Logger", () => {
  let stdoutWriteSpy: any;
  let stderrWriteSpy: any;
  let originalEnvLevel: string | undefined;

  beforeEach(() => {
    stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true as any);
    stderrWriteSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true as any);
    originalEnvLevel = process.env.MCP_LOG_LEVEL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalEnvLevel === undefined) {
      delete process.env.MCP_LOG_LEVEL;
    } else {
      process.env.MCP_LOG_LEVEL = originalEnvLevel;
    }
  });

  it("defaults to info level if MCP_LOG_LEVEL is unset", () => {
    delete process.env.MCP_LOG_LEVEL;

    logger.debug("debug msg");
    logger.info("info msg");
    logger.warn("warn msg");
    logger.error("error msg");

    expect(stdoutWriteSpy).not.toHaveBeenCalled();
    expect(stderrWriteSpy).toHaveBeenCalledTimes(3);

    expect(stderrWriteSpy).toHaveBeenNthCalledWith(1, "[INFO] info msg\n");
    expect(stderrWriteSpy).toHaveBeenNthCalledWith(2, "[WARN] warn msg\n");
    expect(stderrWriteSpy).toHaveBeenNthCalledWith(3, "[ERROR] error msg\n");
  });

  it("defaults to info level if MCP_LOG_LEVEL is invalid", () => {
    process.env.MCP_LOG_LEVEL = "invalid-level";

    logger.debug("debug msg");
    logger.info("info msg");
    logger.warn("warn msg");
    logger.error("error msg");

    expect(stdoutWriteSpy).not.toHaveBeenCalled();
    expect(stderrWriteSpy).toHaveBeenCalledTimes(3);

    expect(stderrWriteSpy).toHaveBeenNthCalledWith(1, "[INFO] info msg\n");
    expect(stderrWriteSpy).toHaveBeenNthCalledWith(2, "[WARN] warn msg\n");
    expect(stderrWriteSpy).toHaveBeenNthCalledWith(3, "[ERROR] error msg\n");
  });

  it("supports debug level (case-insensitive) and logs all levels", () => {
    process.env.MCP_LOG_LEVEL = "DeBuG";

    logger.debug("debug msg");
    logger.info("info msg");
    logger.warn("warn msg");
    logger.error("error msg");

    expect(stdoutWriteSpy).not.toHaveBeenCalled();
    expect(stderrWriteSpy).toHaveBeenCalledTimes(4);

    expect(stderrWriteSpy).toHaveBeenNthCalledWith(1, "[DEBUG] debug msg\n");
    expect(stderrWriteSpy).toHaveBeenNthCalledWith(2, "[INFO] info msg\n");
    expect(stderrWriteSpy).toHaveBeenNthCalledWith(3, "[WARN] warn msg\n");
    expect(stderrWriteSpy).toHaveBeenNthCalledWith(4, "[ERROR] error msg\n");
  });

  it("supports warn level and filters out debug and info logs", () => {
    process.env.MCP_LOG_LEVEL = "warn";

    logger.debug("debug msg");
    logger.info("info msg");
    logger.warn("warn msg");
    logger.error("error msg");

    expect(stdoutWriteSpy).not.toHaveBeenCalled();
    expect(stderrWriteSpy).toHaveBeenCalledTimes(2);

    expect(stderrWriteSpy).toHaveBeenNthCalledWith(1, "[WARN] warn msg\n");
    expect(stderrWriteSpy).toHaveBeenNthCalledWith(2, "[ERROR] error msg\n");
  });

  it("supports error level and filters out debug, info, and warn logs", () => {
    process.env.MCP_LOG_LEVEL = "error";

    logger.debug("debug msg");
    logger.info("info msg");
    logger.warn("warn msg");
    logger.error("error msg");

    expect(stdoutWriteSpy).not.toHaveBeenCalled();
    expect(stderrWriteSpy).toHaveBeenCalledTimes(1);

    expect(stderrWriteSpy).toHaveBeenNthCalledWith(1, "[ERROR] error msg\n");
  });

  it("formats multiple arguments correctly via util.format style", () => {
    process.env.MCP_LOG_LEVEL = "info";

    logger.info("hello %s: %d", "world", 42, { extra: true });

    expect(stdoutWriteSpy).not.toHaveBeenCalled();
    expect(stderrWriteSpy).toHaveBeenCalledTimes(1);
    expect(stderrWriteSpy).toHaveBeenCalledWith("[INFO] hello world: 42 { extra: true }\n");
  });
});
