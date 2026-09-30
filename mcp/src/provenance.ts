/**
 * Package provenance metadata for release artifacts — issue #586.
 *
 * A published tarball currently says what it is (`name`, `version`) but nothing
 * about where it came from. Anyone who installs `@mindvault/mcp` and wants to
 * know which commit produced it, whether it was built in CI or on somebody's
 * laptop, or whether the `dist/` they received matches this repository at that
 * commit, has no way to find out. For an MCP server that holds a Stellar
 * secret key and signs payments, that is a gap worth closing.
 *
 * This module builds a `provenance.json` that ships inside the tarball,
 * recording the source commit and ref, the repository, the build time, the
 * builder (CI workflow or local), the toolchain, and a content digest over the
 * built files. It is a lightweight, self-contained record — not a signed
 * attestation. npm's own `--provenance` flag produces the cryptographically
 * verifiable version, and the two are complementary: the flag proves the
 * tarball came from a CI run, this file says what that run was building. The
 * pre-publish checks below nudge toward turning the flag on as well.
 *
 * The builders are pure functions over an explicitly supplied environment and
 * file list, so the document is deterministic and unit-testable: the same
 * inputs always produce the same record.
 */

import { createHash } from "node:crypto";

/** Schema version for the emitted document. Bump on a breaking field change. */
export const PROVENANCE_SCHEMA_VERSION = "1.0.0";

/** Filename written into the package root and shipped in the tarball. */
export const PROVENANCE_FILENAME = "provenance.json";

/**
 * Build-time variables read when generating the record.
 *
 * Indexed through this map rather than read as named properties, matching
 * `TIMEOUT_ENV_VARS` and `RETRY_ENV_VARS`: these are set by the CI runner, not
 * by an operator configuring an MCP client, so they are deliberately absent
 * from the client configuration table in `docs/mcp-client-configs.md`.
 */
export const BUILD_ENV_VARS = {
  githubActions: "GITHUB_ACTIONS",
  githubRepository: "GITHUB_REPOSITORY",
  githubRunId: "GITHUB_RUN_ID",
  githubSha: "GITHUB_SHA",
  githubRefName: "GITHUB_REF_NAME",
  githubRef: "GITHUB_REF",
  ci: "CI",
  userAgent: "npm_config_user_agent",
} as const;

/** One built file and its digest. */
export interface ArtifactDigest {
  /** Package-relative path, e.g. `dist/index.js`. */
  path: string;
  /** Lowercase hex sha256 of the file's bytes. */
  sha256: string;
  bytes: number;
}

export interface SourceProvenance {
  /** Repository URL, normalised to https and without the `git+`/`.git` noise. */
  repository: string | null;
  /** Full commit SHA the artifact was built from. */
  commit: string | null;
  /** Branch or tag, when the builder knew one. */
  ref: string | null;
  /** True when the working tree had uncommitted changes at build time. */
  dirty: boolean;
}

export interface BuilderProvenance {
  /** `github-actions`, `local`, or another CI identifier. */
  type: string;
  /** Workflow or run identifier, when there is one. */
  id: string | null;
  nodeVersion: string;
  platform: string;
}

export interface Provenance {
  schemaVersion: string;
  name: string;
  version: string;
  /** ISO-8601, second precision — nothing here needs milliseconds. */
  buildTime: string;
  source: SourceProvenance;
  builder: BuilderProvenance;
  artifacts: ArtifactDigest[];
  /** sha256 over the artifact digest list; identifies the build as a whole. */
  artifactsDigest: string;
}

/** What `buildProvenance` needs from its caller. */
export interface ProvenanceInput {
  manifest: Record<string, any>;
  /** Built files with their contents, in any order. */
  artifacts: { path: string; contents: Buffer | string }[];
  commit?: string | null;
  ref?: string | null;
  dirty?: boolean;
  /** Defaults to now. Injectable so tests are deterministic. */
  buildTime?: Date;
  env?: NodeJS.ProcessEnv;
}

/**
 * Normalise a package.json `repository` field to a plain https URL.
 *
 * npm accepts `git+https://….git`, `git://`, `github:owner/repo` and a bare
 * `owner/repo`; a provenance record that echoed all five spellings would be
 * useless for comparing two builds.
 */
export function normalizeRepositoryUrl(repository: unknown): string | null {
  const raw =
    typeof repository === "string"
      ? repository
      : typeof (repository as any)?.url === "string"
        ? (repository as any).url
        : null;
  if (!raw) return null;

  let url = raw.trim();
  if (!url) return null;

  url = url.replace(/^git\+/, "").replace(/\.git$/, "");
  if (url.startsWith("github:")) return `https://github.com/${url.slice("github:".length)}`;
  if (url.startsWith("git://")) return `https://${url.slice("git://".length)}`;
  if (url.startsWith("git@")) return `https://${url.slice("git@".length).replace(":", "/")}`;
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) return `https://github.com/${url}`;
  return url;
}

/** sha256 of a buffer or string, lowercase hex. */
export function sha256(contents: Buffer | string): string {
  return createHash("sha256").update(contents).digest("hex");
}

/**
 * Identify the builder from the environment.
 *
 * GitHub Actions is detected explicitly because it is what this repository
 * uses; anything else with `CI=1` is recorded as generic CI rather than
 * guessed at, and everything else is a local build. "Local" is a useful thing
 * to see in a published artifact — usually it means someone published by hand.
 */
export function detectBuilder(env: NodeJS.ProcessEnv = process.env): BuilderProvenance {
  const base = {
    nodeVersion: env[BUILD_ENV_VARS.userAgent]?.match(/node\/(\S+)/)?.[1] ?? process.version,
    platform: `${process.platform}-${process.arch}`,
  };

  if (env[BUILD_ENV_VARS.githubActions] === "true") {
    const repo = env[BUILD_ENV_VARS.githubRepository];
    const runId = env[BUILD_ENV_VARS.githubRunId];
    return {
      ...base,
      type: "github-actions",
      id: repo && runId ? `${repo}/actions/runs/${runId}` : (runId ?? null),
    };
  }

  if (env[BUILD_ENV_VARS.ci] === "true" || env[BUILD_ENV_VARS.ci] === "1") {
    return { ...base, type: "ci", id: null };
  }

  return { ...base, type: "local", id: null };
}

/** Read the commit and ref from CI environment variables, when present. */
export function detectSourceRef(env: NodeJS.ProcessEnv = process.env): {
  commit: string | null;
  ref: string | null;
} {
  return {
    commit: env[BUILD_ENV_VARS.githubSha]?.trim() || null,
    ref: env[BUILD_ENV_VARS.githubRefName]?.trim() || env[BUILD_ENV_VARS.githubRef]?.trim() || null,
  };
}

/**
 * Build the provenance document.
 *
 * Artifacts are sorted by path and the build time is truncated to whole
 * seconds, so two builds of identical inputs differ only in the fields that
 * genuinely differ.
 */
export function buildProvenance(input: ProvenanceInput): Provenance {
  const env = input.env ?? process.env;
  const detected = detectSourceRef(env);

  const artifacts: ArtifactDigest[] = input.artifacts
    .map(({ path, contents }) => ({
      path,
      sha256: sha256(contents),
      bytes: Buffer.byteLength(contents as any),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const buildTime = input.buildTime ?? new Date();

  return {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    name: String(input.manifest.name ?? ""),
    version: String(input.manifest.version ?? ""),
    buildTime: `${buildTime.toISOString().slice(0, 19)}Z`,
    source: {
      repository: normalizeRepositoryUrl(input.manifest.repository),
      commit: input.commit ?? detected.commit,
      ref: input.ref ?? detected.ref,
      dirty: input.dirty ?? false,
    },
    builder: detectBuilder(env),
    artifacts,
    artifactsDigest: digestArtifacts(artifacts),
  };
}

/**
 * One digest covering every artifact.
 *
 * Computed over `path:sha256` lines rather than the file bytes, so it changes
 * when a file is renamed, added or removed — not just when contents change.
 */
export function digestArtifacts(artifacts: ArtifactDigest[]): string {
  const canonical = [...artifacts]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((artifact) => `${artifact.path}:${artifact.sha256}`)
    .join("\n");
  return sha256(canonical);
}

/** Serialise deterministically — same input, byte-identical file. */
export function serializeProvenance(provenance: Provenance): string {
  return `${JSON.stringify(provenance, null, 2)}\n`;
}

/** Parse and shallowly validate a provenance document. */
export function parseProvenance(text: string): Provenance | null {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.schemaVersion !== "string") return null;
    if (!Array.isArray(parsed.artifacts)) return null;
    return parsed as Provenance;
  } catch {
    return null;
  }
}

// ── Pre-publish checks ────────────────────────────────────────────────────────

/**
 * Shape shared with `prepublish.ts`, restated here so this module does not
 * depend on it and can be tested in isolation.
 */
export interface ProvenanceCheckResult {
  name: string;
  status: "pass" | "fail";
  detail: string;
}

const HEX40 = /^[0-9a-f]{40}$/i;

/**
 * Check the provenance record that will ship with the tarball.
 *
 * The point is to catch a record that is present but wrong — a stale version, a
 * commit from a previous build, a digest that no longer matches what is in
 * `dist/`. A missing record fails loudly; a wrong one is worse than none,
 * because it is believed.
 */
export function checkProvenance(
  provenance: Provenance | null,
  manifest: Record<string, any>,
  packedFiles: string[],
): ProvenanceCheckResult[] {
  const results: ProvenanceCheckResult[] = [];
  const pass = (name: string, detail: string): ProvenanceCheckResult => ({
    name,
    status: "pass",
    detail,
  });
  const fail = (name: string, detail: string): ProvenanceCheckResult => ({
    name,
    status: "fail",
    detail,
  });

  results.push(
    packedFiles.includes(PROVENANCE_FILENAME)
      ? pass("provenance:packed", `${PROVENANCE_FILENAME} is included in the tarball`)
      : fail(
          "provenance:packed",
          `${PROVENANCE_FILENAME} is missing from the tarball — run \`pnpm provenance\` ` +
            `and add "${PROVENANCE_FILENAME}" to the "files" allowlist`,
        ),
  );

  if (!provenance) {
    results.push(
      fail(
        "provenance:present",
        `${PROVENANCE_FILENAME} is absent or unparseable — run \`pnpm provenance\``,
      ),
    );
    return results;
  }

  results.push(pass("provenance:present", `${PROVENANCE_FILENAME} parses`));

  results.push(
    provenance.schemaVersion === PROVENANCE_SCHEMA_VERSION
      ? pass("provenance:schema", `schema version ${provenance.schemaVersion}`)
      : fail(
          "provenance:schema",
          `schema version ${provenance.schemaVersion} is not the expected ` +
            `${PROVENANCE_SCHEMA_VERSION} — regenerate it`,
        ),
  );

  results.push(
    provenance.version === manifest.version
      ? pass("provenance:version", `records version ${provenance.version}`)
      : fail(
          "provenance:version",
          `records version ${provenance.version} but package.json says ${manifest.version} — ` +
            "the record is stale, regenerate it after bumping",
        ),
  );

  results.push(
    provenance.name === manifest.name
      ? pass("provenance:name", `records ${provenance.name}`)
      : fail(
          "provenance:name",
          `records ${provenance.name} but package.json says ${manifest.name}`,
        ),
  );

  results.push(
    provenance.source.commit && HEX40.test(provenance.source.commit)
      ? pass("provenance:commit", `built from ${provenance.source.commit.slice(0, 12)}`)
      : fail(
          "provenance:commit",
          "no source commit recorded — a release artifact must say what it was built from",
        ),
  );

  const expectedRepository = normalizeRepositoryUrl(manifest.repository);
  results.push(
    provenance.source.repository && provenance.source.repository === expectedRepository
      ? pass("provenance:repository", `repository is ${provenance.source.repository}`)
      : fail(
          "provenance:repository",
          `repository ${provenance.source.repository ?? "(none)"} does not match ` +
            `package.json (${expectedRepository ?? "(none)"})`,
        ),
  );

  results.push(
    provenance.source.dirty
      ? fail(
          "provenance:clean",
          "built from a dirty working tree — the commit does not describe what was published",
        )
      : pass("provenance:clean", "built from a clean working tree"),
  );

  results.push(
    provenance.artifacts.length > 0
      ? pass("provenance:artifacts", `${provenance.artifacts.length} artifact digest(s) recorded`)
      : fail("provenance:artifacts", "no artifact digests recorded"),
  );

  results.push(
    provenance.artifactsDigest === digestArtifacts(provenance.artifacts)
      ? pass("provenance:digest", "artifacts digest matches the recorded file list")
      : fail(
          "provenance:digest",
          "artifacts digest does not match the recorded files — the record was edited by hand " +
            "or written by an older tool",
        ),
  );

  return results;
}

/**
 * Compare a provenance record against the files actually in the tarball.
 *
 * A record listing files the tarball does not carry, or missing files it does,
 * describes a different build than the one being published.
 */
export function checkProvenanceCoverage(
  provenance: Provenance,
  packedFiles: string[],
): ProvenanceCheckResult {
  const recorded = new Set(provenance.artifacts.map((a) => a.path));
  const packedDist = packedFiles.filter((p) => p.startsWith("dist/") && p.endsWith(".js"));
  const missing = packedDist.filter((p) => !recorded.has(p));

  return missing.length === 0
    ? {
        name: "provenance:coverage",
        status: "pass",
        detail: `every packed dist/ file (${packedDist.length}) has a digest`,
      }
    : {
        name: "provenance:coverage",
        status: "fail",
        detail:
          `${missing.length} packed file(s) have no digest: ` +
          `${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""} — ` +
          "regenerate the record after building",
      };
}
