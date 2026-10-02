/**
 * Optional tool-level metrics for the MindVault MCP server.
 *
 * Opt-in via the MINDVAULT_METRICS env var. When disabled a no-op recorder is
 * used, so there is no bookkeeping and no output. Metrics only ever contain tool
 * names, counts, and durations — never arguments, wallets, or API keys — so a
 * snapshot is always safe to surface to an agent. This module is pure and
 * side-effect free (no I/O, no globals beyond `performance.now`) for
 * deterministic testing.
 */

/** Per-tool counters. Durations are milliseconds. */
export interface ToolMetric {
  calls: number;
  errors: number;
  totalDurationMs: number;
  maxDurationMs: number;
  budgetExceeded: number;
}

export interface MetricsSnapshot {
  enabled: boolean;
  /** ISO timestamp of when collection (re)started, or null when disabled. */
  since: string | null;
  toolDurationBudgetMs: number | null;
  totals: { calls: number; errors: number; budgetExceeded: number };
  payments: { attempts: number; failures: number };
  tools: Record<string, ToolMetric>;
}

export interface MetricsRecorder {
  readonly enabled: boolean;
  readonly toolDurationBudgetMs: number;
  recordToolCall(tool: string, durationMs: number, ok: boolean): void;
  recordPayment(ok: boolean): void;
  snapshot(): MetricsSnapshot;
  reset(): void;
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** Metrics are opt-in: enabled only when MINDVAULT_METRICS is a truthy string. */
export function metricsEnabledFromEnv(env: NodeJS.ProcessEnv): boolean {
  const raw = env.MINDVAULT_METRICS;
  return typeof raw === "string" && TRUTHY.has(raw.trim().toLowerCase());
}

export const TOOL_DURATION_BUDGET_ENV_VAR = "MINDVAULT_TOOL_DURATION_BUDGET_MS";
export const DEFAULT_TOOL_DURATION_BUDGET_MS = 30000;

export function resolveToolDurationBudget(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[TOOL_DURATION_BUDGET_ENV_VAR];
  if (!raw || raw.trim() === "") return DEFAULT_TOOL_DURATION_BUDGET_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_TOOL_DURATION_BUDGET_MS;
  return Math.floor(parsed);
}

function emptyToolMetric(): ToolMetric {
  return { calls: 0, errors: 0, totalDurationMs: 0, maxDurationMs: 0, budgetExceeded: 0 };
}

/** Disabled recorder — zero overhead, always reports an empty, disabled snapshot. */
class NoopMetricsRecorder implements MetricsRecorder {
  readonly enabled = false;
  readonly toolDurationBudgetMs = 0;
  recordToolCall(): void {}
  recordPayment(): void {}
  reset(): void {}
  snapshot(): MetricsSnapshot {
    return {
      enabled: false,
      since: null,
      toolDurationBudgetMs: null,
      totals: { calls: 0, errors: 0, budgetExceeded: 0 },
      payments: { attempts: 0, failures: 0 },
      tools: {},
    };
  }
}

class ActiveMetricsRecorder implements MetricsRecorder {
  readonly enabled = true;
  readonly toolDurationBudgetMs: number;
  private since = new Date();
  private tools = new Map<string, ToolMetric>();
  private payments = { attempts: 0, failures: 0 };

  constructor(budgetMs: number) {
    this.toolDurationBudgetMs = budgetMs;
  }

  recordToolCall(tool: string, durationMs: number, ok: boolean): void {
    const metric = this.tools.get(tool) ?? emptyToolMetric();
    metric.calls += 1;
    if (!ok) metric.errors += 1;
    const duration = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
    metric.totalDurationMs += duration;
    metric.maxDurationMs = Math.max(metric.maxDurationMs, duration);
    if (duration > this.toolDurationBudgetMs) metric.budgetExceeded += 1;
    this.tools.set(tool, metric);
  }

  recordPayment(ok: boolean): void {
    this.payments.attempts += 1;
    if (!ok) this.payments.failures += 1;
  }

  reset(): void {
    this.since = new Date();
    this.tools.clear();
    this.payments = { attempts: 0, failures: 0 };
  }

  snapshot(): MetricsSnapshot {
    const tools: Record<string, ToolMetric> = {};
    let calls = 0;
    let errors = 0;
    let budgetExceeded = 0;
    for (const [name, metric] of this.tools) {
      tools[name] = { ...metric };
      calls += metric.calls;
      errors += metric.errors;
      budgetExceeded += metric.budgetExceeded;
    }
    return {
      enabled: true,
      since: this.since.toISOString(),
      toolDurationBudgetMs: this.toolDurationBudgetMs,
      totals: { calls, errors, budgetExceeded },
      payments: { ...this.payments },
      tools,
    };
  }
}

export function createMetricsRecorder(enabled: boolean, budgetMs: number): MetricsRecorder {
  return enabled ? new ActiveMetricsRecorder(budgetMs) : new NoopMetricsRecorder();
}

/**
 * Run a tool handler while recording its call count, error count, and duration.
 * Errors are re-thrown unchanged so the caller's existing error handling (and
 * the deterministic `Error: …` response shape) is preserved.
 */
export async function measureTool<T>(
  recorder: MetricsRecorder,
  tool: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const start = performance.now();
  try {
    const result = await fn();
    recorder.recordToolCall(tool, performance.now() - start, true);
    return result;
  } catch (err) {
    recorder.recordToolCall(tool, performance.now() - start, false);
    throw err;
  }
}

// ── Export path (#891) ────────────────────────────────────────────────────────

export const METRICS_EXPORT_FORMATS = ["json", "otlp"] as const;
export type MetricsExportFormat = (typeof METRICS_EXPORT_FORMATS)[number];

export const METRICS_EXPORT_CONSOLE_ENV_VAR = "MINDVAULT_METRICS_EXPORT_CONSOLE";

/** Serialized as request-scoped preferences, "json" is the default export shape. */
export function normalizeMetricsExportFormat(raw: unknown): MetricsExportFormat {
  if (raw === undefined || raw === null || raw === "") return "json";
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : String(raw);
  if (value === "otlp") return "otlp";
  if (value === "json") return "json";
  throw new Error(
    `format must be one of: ${METRICS_EXPORT_FORMATS.join(", ")}. Got: ${JSON.stringify(raw)}.`,
  );
}

/**
 * Stream a metrics export to the process console when
 * MINDVAULT_METRICS_EXPORT_CONSOLE is truthy. Opt-in, like metrics themselves;
 * the line goes to stderr so stdout stays clean for the MCP stdio transport.
 */
export function metricsExportToConsoleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[METRICS_EXPORT_CONSOLE_ENV_VAR];
  return typeof raw === "string" && TRUTHY.has(raw.trim().toLowerCase());
}

/** OTLP/JSON ExportMetricsServiceRequest data model (the fields we emit). */
export type OtlpMetricsDataPoint = {
  attributes?: Array<{ key: string; value: { stringValue: string } }>;
  startTimeUnixNano?: string;
  timeUnixNano: string;
  asInt?: string;
  asDouble?: string;
};

export type OtlpMetricsPayload = {
  resourceMetrics: Array<{
    resource: { attributes: Array<{ key: string; value: { stringValue: string } }> };
    scopeMetrics: Array<{
      scope: { name: string; version: string };
      metrics: Array<
        | { name: string; description: string; unit: string; sum: OtlpSum }
        | {
            name: string;
            description: string;
            unit: string;
            gauge: { dataPoints: OtlpMetricsDataPoint[] };
          }
      >;
    }>;
  }>;
};

type OtlpSum = {
  dataPoints: OtlpMetricsDataPoint[];
  aggregationTemporality: 2;
  isMonotonic: boolean;
};

function toUnixNanosLoop(iso: string | null): string {
  const time = iso ? Date.parse(iso) : Date.now();
  return String(Number.isFinite(time) ? time * 1e6 : Date.now() * 1e6);
}

function attributeOf(key: string, value: string) {
  return { key, value: { stringValue: value } };
}

/**
 * Deterministic conversion of a metrics snapshot into an OTLP/JSON
 * ExportMetricsServiceRequest body. Ordering is fixed (overall counters, then
 * per-tool counters grouped by metric, tools alphabetical) so exports are
 * stable across runs and diffable in tests.
 */
export function toOtlpMetricsExport(snapshot: MetricsSnapshot): OtlpMetricsPayload {
  const sinceNs = toUnixNanosLoop(snapshot.since);
  const nowNs = toUnixNanosLoop(null);

  const intPoint = (tool: string | null, value = 0): OtlpMetricsDataPoint => ({
    attributes: tool ? [attributeOf("tool", tool)] : undefined,
    startTimeUnixNano: sinceNs,
    timeUnixNano: nowNs,
    asInt: String(value),
  });
  const doublePoint = (tool: string | null, value: number): OtlpMetricsDataPoint => ({
    attributes: tool ? [attributeOf("tool", tool)] : undefined,
    startTimeUnixNano: sinceNs,
    timeUnixNano: nowNs,
    asDouble: String(Math.round(value * 1000) / 1000),
  });

  const tools = Object.keys(snapshot.tools).sort();
  const metricBodies: OtlpMetricsPayload["resourceMetrics"][0]["scopeMetrics"][0]["metrics"] = [];

  const sumMetric = (
    name: string,
    description: string,
    points: OtlpMetricsDataPoint[],
    monotonic: boolean,
  ) => {
    metricBodies.push({
      name,
      description,
      unit: "1",
      sum: { dataPoints: points, aggregationTemporality: 2, isMonotonic: monotonic },
    });
  };

  sumMetric(
    "mindvault.calls",
    "Total MCP tool calls recorded by the MindVault server.",
    [intPoint(null, snapshot.totals.calls)],
    true,
  );
  sumMetric(
    "mindvault.errors",
    "Total MCP tool calls that failed.",
    [intPoint(null, snapshot.totals.errors)],
    true,
  );
  sumMetric(
    "mindvault.payments.attempts",
    "x402 payment attempts (including failed verifications).",
    [intPoint(null, snapshot.payments.attempts)],
    true,
  );
  sumMetric(
    "mindvault.payments.failures",
    "x402 payment attempts that did not succeed.",
    [intPoint(null, snapshot.payments.failures)],
    true,
  );
  sumMetric(
    "mindvault.tool.budget_exceeded",
    "Tool calls that overran the per-call duration budget.",
    tools.map((tool) => intPoint(tool, snapshot.tools[tool].budgetExceeded)),
    true,
  );
  sumMetric(
    "mindvault.tool.calls",
    "Tool calls per MCP tool.",
    tools.map((tool) => intPoint(tool, snapshot.tools[tool].calls)),
    true,
  );
  sumMetric(
    "mindvault.tool.errors",
    "Failed tool calls per MCP tool.",
    tools.map((tool) => intPoint(tool, snapshot.tools[tool].errors)),
    true,
  );
  sumMetric(
    "mindvault.tool.duration_ms_total",
    "Cumulative handler duration in milliseconds per MCP tool.",
    tools.map((tool) => doublePoint(tool, snapshot.tools[tool].totalDurationMs)),
    true,
  );

  metricBodies.push({
    name: "mindvault.tool.duration_ms_max",
    description: "Longest single handler duration in milliseconds per MCP tool.",
    unit: "ms",
    gauge: {
      dataPoints: tools.map((tool) => doublePoint(tool, snapshot.tools[tool].maxDurationMs)),
    },
  });
  metricBodies.push({
    name: "mindvault.tool_duration_budget_ms",
    description: "Configured per-call tool duration budget in milliseconds.",
    unit: "ms",
    gauge: {
      dataPoints: [doublePoint(null, snapshot.toolDurationBudgetMs ?? 0)],
    },
  });

  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            attributeOf("service.name", "mindvault-mcp"),
            attributeOf("mindvault.metrics.since", snapshot.since ?? ""),
          ],
        },
        scopeMetrics: [{ scope: { name: "mindvault-mcp", version: "mcp" }, metrics: metricBodies }],
      },
    ],
  };
}

/** Render a snapshot in the requested export format (pretty JSON either way). */
export function serializeMetricsExport(
  snapshot: MetricsSnapshot,
  format: MetricsExportFormat,
): string {
  return JSON.stringify(format === "otlp" ? toOtlpMetricsExport(snapshot) : snapshot, null, 2);
}

/** One-line export for the stderr stream when console export is enabled (#891). */
export function metricsExportLine(snapshot: MetricsSnapshot, format: MetricsExportFormat): string {
  const payload = format === "otlp" ? toOtlpMetricsExport(snapshot) : snapshot;
  return `[mindvault-metrics] ${JSON.stringify(payload)}`;
}
