// Issue #1030: bounded cancellation for long-running publish operations
export function isCancellationError(err: any): boolean {
  return err?.name === "AbortError" || err?.code === "ABORT_ERR" || err?.message === "timeout";
}
