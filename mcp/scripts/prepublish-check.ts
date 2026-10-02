#!/usr/bin/env node
/**
 * Automated pre-publish gate for @mindvault/mcp.
 *
 * Runs the checks from docs/mcp-publish-checklist.md and exits non-zero on the
 * first category that fails, so `pnpm prepublish:check` can gate a release in
 * CI or locally:
 *
 *   1. tests      — the package's own vitest suite
 *   2. build      — a clean tsc build into dist/
 *   3. manifest   — name/version/type/main/bin/files/license/engines
 *   4. bin        — the entrypoint exists, is built, is packed, has a shebang
 *   5. contents   — `npm pack --dry-run` ships dist/ and no sources or secrets
 *   6. deps       — workspace: ranges are publishable
 *   7. smoke      — the end-to-end driver is present and runnable
 *
 * By default the smoke test itself is *not* executed (it can take a live
 * backend and a funded wallet). Pass --smoke to run it in offline mock mode.
 *
 * Usage:
 *   pnpm prepublish:check
 *   pnpm prepublish:check --skip-tests --skip-build   # checks only, no rebuild
 *   pnpm prepublish:check --smoke                     # also run the mock smoke test
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  binEntrypoints,
  checkDependencies,
  commandCheck,
  formatReport,
  hasFailures,
  runPackageChecks,
  type CheckResult,
  type PackageSnapshot,
} from "../src/prepublish.js";
import {
  PROVENANCE_FILENAME,
  checkProvenance,
  checkProvenanceCoverage,
  parseProvenance,
} from "../src/provenance.js";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE_DIR = resolve(PACKAGE_DIR, "..");

const args = new Set(process.argv.slice(2));
const skipTests = args.has("--skip-tests");
const skipBuild = args.has("--skip-build");
const runSmoke = args.has("--smoke");

/** Run a command in the package directory, returning success and its output. */
function run(command: string, commandArgs: string[], env: NodeJS.ProcessEnv = {}) {
  try {
    const stdout = execFileSync(command, commandArgs, {
      cwd: PACKAGE_DIR,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    return { ok: true, output: stdout };
  } catch (err: any) {
    return { ok: false, output: `${err?.stdout ?? ""}${err?.stderr ?? err?.message ?? ""}` };
  }
}

/** Last line of command output — enough context for a one-line report entry. */
function lastLine(output: string): string {
  const lines = output.trim().split("\n").filter(Boolean);
  return lines[lines.length - 1] ?? "(no output)";
}

/** Every file under `dir`, as paths relative to the package directory. */
function listFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".git")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, out);
    else out.push(relative(PACKAGE_DIR, full));
  }
  return out;
}

/** Newest mtime across the package's TypeScript sources. */
function newestSourceMtime(): number | null {
  const sources = listFiles(join(PACKAGE_DIR, "src")).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
  );
  if (sources.length === 0) return null;
  return Math.max(...sources.map((f) => statSync(join(PACKAGE_DIR, f)).mtimeMs));
}

/** Ask npm which files the tarball would contain. */
function packedFiles(): { files: string[]; error: string | null } {
  const result = run("npm", ["pack", "--dry-run", "--json"]);
  if (!result.ok) return { files: [], error: lastLine(result.output) };
  try {
    const parsed = JSON.parse(result.output) as { files: { path: string }[] }[];
    return { files: (parsed[0]?.files ?? []).map((f) => f.path), error: null };
  } catch {
    return { files: [], error: "could not parse `npm pack --dry-run --json` output" };
  }
}

/** Manifests of sibling workspace packages, keyed by package name. */
function workspacePackages(): Record<string, { private?: boolean; version?: string }> {
  const found: Record<string, { private?: boolean; version?: string }> = {};
  const roots = [WORKSPACE_DIR, join(WORKSPACE_DIR, "packages")];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(root, entry.name, "package.json");
      if (!existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        if (typeof manifest.name === "string") {
          found[manifest.name] = { private: manifest.private, version: manifest.version };
        }
      } catch {
        // Unreadable sibling manifest — not this package's problem.
      }
    }
  }
  return found;
}

const results: CheckResult[] = [];

// 1. Tests
if (skipTests) {
  results.push(commandCheck("tests", true, "skipped (--skip-tests)"));
} else {
  const tests = run("npx", ["vitest", "run"]);
  results.push(
    commandCheck("tests", tests.ok, tests.ok ? lastLine(tests.output) : lastLine(tests.output)),
  );
}

// 2. Build
if (skipBuild) {
  results.push(commandCheck("build", true, "skipped (--skip-build)"));
} else {
  const build = run("npx", ["tsc", "-p", "tsconfig.build.json"]);
  results.push(
    commandCheck("build", build.ok, build.ok ? "tsc completed" : lastLine(build.output)),
  );
}

// 3–7. Static checks over the package on disk.
const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf-8"));
const pack = packedFiles();
if (pack.error) results.push(commandCheck("contents:pack", false, pack.error));

const files = listFiles(PACKAGE_DIR);
const binEntry = binEntrypoints(manifest)[0]?.replace(/^\.\//, "");
const binPath = binEntry ? join(PACKAGE_DIR, binEntry) : null;

const snapshot: PackageSnapshot = {
  manifest,
  files,
  binSource: binPath && existsSync(binPath) ? readFileSync(binPath, "utf-8") : null,
  packedFiles: pack.files,
  newestSourceMtime: newestSourceMtime(),
  builtEntrypointMtime: binPath && existsSync(binPath) ? statSync(binPath).mtimeMs : null,
};

results.push(...runPackageChecks(snapshot));
results.push(...checkDependencies(manifest, workspacePackages()));

// 7b. Provenance record shipped with the artifact (#586).
const provenancePath = join(PACKAGE_DIR, PROVENANCE_FILENAME);
const provenance = existsSync(provenancePath)
  ? parseProvenance(readFileSync(provenancePath, "utf-8"))
  : null;
results.push(...checkProvenance(provenance, manifest, pack.files));
if (provenance) results.push(checkProvenanceCoverage(provenance, pack.files));

// 8. Optional end-to-end smoke run against the offline mock backend.
if (runSmoke) {
  const smoke = run("npx", ["tsx", "scripts/smoke.ts"], { MINDVAULT_MOCK: "1" });
  results.push(
    commandCheck(
      "smoke:run",
      smoke.ok,
      smoke.ok ? "mock smoke run passed" : lastLine(smoke.output),
    ),
  );
} else {
  results.push(commandCheck("smoke:run", true, "not run — pass --smoke to drive the mock backend"));
}

console.log(formatReport(results));
process.exit(hasFailures(results) ? 1 : 0);
