#!/usr/bin/env tsx
/**
 * Write provenance.json for the built package — issue #586.
 *
 * Run after `pnpm build` and before publishing:
 *
 *     pnpm build && pnpm provenance && pnpm prepublish:check
 *
 * The pure document builder lives in `src/provenance.ts`; this script is only
 * the impure half — reading `dist/`, shelling out to git, writing the file.
 * Keeping the split means the record's shape is unit-tested and this file has
 * nothing in it worth testing.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { PROVENANCE_FILENAME, buildProvenance, serializeProvenance } from "../src/provenance.js";

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST_DIR = join(PACKAGE_DIR, "dist");

/** Run a git command, returning null when git or the repo is unavailable. */
function git(...args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: PACKAGE_DIR,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** Every file under dist/, as package-relative paths with forward slashes. */
function distFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...distFiles(full));
    else if (entry.isFile()) found.push(relative(PACKAGE_DIR, full).split(sep).join("/"));
  }
  return found;
}

function main(): void {
  let built: string[];
  try {
    statSync(DIST_DIR);
    built = distFiles(DIST_DIR).sort();
  } catch {
    console.error("dist/ does not exist — run `pnpm build` first.");
    process.exit(1);
  }

  if (built.length === 0) {
    console.error("dist/ is empty — run `pnpm build` first.");
    process.exit(1);
  }

  const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf-8"));

  // `git status --porcelain` over the package directory only: an unrelated
  // edit elsewhere in the monorepo does not make *this* artifact untrustworthy.
  const status = git("status", "--porcelain", "--", ".");

  const provenance = buildProvenance({
    manifest,
    artifacts: built.map((path) => ({
      path,
      contents: readFileSync(join(PACKAGE_DIR, path)),
    })),
    commit: git("rev-parse", "HEAD"),
    ref: git("rev-parse", "--abbrev-ref", "HEAD"),
    dirty: status !== null && status.length > 0,
  });

  const destination = join(PACKAGE_DIR, PROVENANCE_FILENAME);
  writeFileSync(destination, serializeProvenance(provenance), "utf-8");

  console.log(`Wrote ${PROVENANCE_FILENAME}`);
  console.log(`  version   ${provenance.version}`);
  console.log(`  commit    ${provenance.source.commit ?? "(unknown)"}`);
  console.log(`  ref       ${provenance.source.ref ?? "(unknown)"}`);
  console.log(`  builder   ${provenance.builder.type}`);
  console.log(`  artifacts ${provenance.artifacts.length} file(s)`);
  console.log(`  digest    ${provenance.artifactsDigest}`);
  if (provenance.source.dirty) {
    console.log("  WARNING: built from a dirty working tree");
  }
}

main();
