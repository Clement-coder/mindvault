/**
 * Tests for package provenance metadata (#586).
 *
 * A provenance record is only worth shipping if it is deterministic (two
 * builds of the same bytes agree), tamper-evident in the cheap sense (an
 * edited file list stops matching its own digest), and checked before publish
 * — a record that is present but stale is worse than none, because it is
 * believed.
 */
import { describe, it, expect } from "vitest";

import {
  PROVENANCE_FILENAME,
  PROVENANCE_SCHEMA_VERSION,
  buildProvenance,
  checkProvenance,
  checkProvenanceCoverage,
  detectBuilder,
  detectSourceRef,
  digestArtifacts,
  normalizeRepositoryUrl,
  parseProvenance,
  serializeProvenance,
  sha256,
} from "./provenance.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

const MANIFEST = {
  name: "@mindvault/mcp",
  version: "1.0.0",
  repository: {
    type: "git",
    url: "git+https://github.com/distributed-nerd/mindvault.git",
    directory: "mcp",
  },
};

const ARTIFACTS = [
  { path: "dist/index.js", contents: "console.log(1);" },
  { path: "dist/tools.js", contents: "export const tools = [];" },
];

function build(overrides: Record<string, unknown> = {}) {
  return buildProvenance({
    manifest: MANIFEST,
    artifacts: ARTIFACTS,
    commit: COMMIT,
    ref: "main",
    buildTime: new Date("2026-08-29T12:00:00.000Z"),
    env: {},
    ...overrides,
  });
}

describe("normalizeRepositoryUrl", () => {
  it("strips the git+ prefix and .git suffix", () => {
    expect(normalizeRepositoryUrl("git+https://github.com/owner/repo.git")).toBe(
      "https://github.com/owner/repo",
    );
  });

  it("reads the object form", () => {
    expect(normalizeRepositoryUrl({ url: "git+https://github.com/owner/repo.git" })).toBe(
      "https://github.com/owner/repo",
    );
  });

  it("expands the github: shorthand", () => {
    expect(normalizeRepositoryUrl("github:owner/repo")).toBe("https://github.com/owner/repo");
  });

  it("expands a bare owner/repo", () => {
    expect(normalizeRepositoryUrl("owner/repo")).toBe("https://github.com/owner/repo");
  });

  it("converts git:// and scp-style URLs", () => {
    expect(normalizeRepositoryUrl("git://github.com/owner/repo.git")).toBe(
      "https://github.com/owner/repo",
    );
    expect(normalizeRepositoryUrl("git@github.com:owner/repo.git")).toBe(
      "https://github.com/owner/repo",
    );
  });

  it("normalises every spelling to the same string", () => {
    // A record that echoed five spellings would be useless for comparing builds.
    const forms = [
      "git+https://github.com/owner/repo.git",
      "github:owner/repo",
      "owner/repo",
      "git://github.com/owner/repo.git",
      "git@github.com:owner/repo.git",
    ];
    const normalised = new Set(forms.map(normalizeRepositoryUrl));

    expect(normalised.size).toBe(1);
  });

  it("returns null when there is nothing to normalise", () => {
    expect(normalizeRepositoryUrl(undefined)).toBeNull();
    expect(normalizeRepositoryUrl("")).toBeNull();
    expect(normalizeRepositoryUrl({})).toBeNull();
  });
});

describe("detectBuilder", () => {
  it("identifies GitHub Actions with a run link", () => {
    const builder = detectBuilder({
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_RUN_ID: "42",
    });

    expect(builder.type).toBe("github-actions");
    expect(builder.id).toBe("owner/repo/actions/runs/42");
  });

  it("identifies generic CI", () => {
    expect(detectBuilder({ CI: "true" }).type).toBe("ci");
  });

  it("identifies a local build", () => {
    // Worth seeing in a published artifact: usually it means a manual publish.
    expect(detectBuilder({}).type).toBe("local");
  });

  it("always records the toolchain", () => {
    const builder = detectBuilder({});

    expect(builder.nodeVersion).toBeTruthy();
    expect(builder.platform).toContain("-");
  });
});

describe("detectSourceRef", () => {
  it("reads the CI commit and ref", () => {
    expect(detectSourceRef({ GITHUB_SHA: COMMIT, GITHUB_REF_NAME: "main" })).toEqual({
      commit: COMMIT,
      ref: "main",
    });
  });

  it("is null outside CI", () => {
    expect(detectSourceRef({})).toEqual({ commit: null, ref: null });
  });
});

describe("buildProvenance", () => {
  it("records the package identity", () => {
    const provenance = build();

    expect(provenance.name).toBe("@mindvault/mcp");
    expect(provenance.version).toBe("1.0.0");
    expect(provenance.schemaVersion).toBe(PROVENANCE_SCHEMA_VERSION);
  });

  it("records the source", () => {
    const provenance = build();

    expect(provenance.source.commit).toBe(COMMIT);
    expect(provenance.source.ref).toBe("main");
    expect(provenance.source.repository).toBe("https://github.com/distributed-nerd/mindvault");
    expect(provenance.source.dirty).toBe(false);
  });

  it("records a digest for every artifact", () => {
    const provenance = build();

    expect(provenance.artifacts).toHaveLength(2);
    expect(provenance.artifacts[0].sha256).toBe(sha256("console.log(1);"));
  });

  it("records each artifact's size", () => {
    const provenance = build();
    const index = provenance.artifacts.find((a) => a.path === "dist/index.js");

    expect(index?.bytes).toBe("console.log(1);".length);
  });

  it("sorts artifacts by path", () => {
    const provenance = buildProvenance({
      manifest: MANIFEST,
      artifacts: [...ARTIFACTS].reverse(),
      buildTime: new Date("2026-08-29T12:00:00.000Z"),
      env: {},
    });

    expect(provenance.artifacts.map((a) => a.path)).toEqual(["dist/index.js", "dist/tools.js"]);
  });

  it("truncates the build time to whole seconds", () => {
    const provenance = buildProvenance({
      manifest: MANIFEST,
      artifacts: ARTIFACTS,
      buildTime: new Date("2026-08-29T12:00:00.987Z"),
      env: {},
    });

    expect(provenance.buildTime).toBe("2026-08-29T12:00:00Z");
  });

  it("falls back to CI environment for commit and ref", () => {
    const provenance = buildProvenance({
      manifest: MANIFEST,
      artifacts: ARTIFACTS,
      buildTime: new Date("2026-08-29T12:00:00.000Z"),
      env: { GITHUB_SHA: COMMIT, GITHUB_REF_NAME: "release" },
    });

    expect(provenance.source.commit).toBe(COMMIT);
    expect(provenance.source.ref).toBe("release");
  });

  it("flags a dirty working tree", () => {
    expect(build({ dirty: true }).source.dirty).toBe(true);
  });
});

describe("determinism", () => {
  it("two builds of the same inputs are byte-identical", () => {
    expect(serializeProvenance(build())).toBe(serializeProvenance(build()));
  });

  it("artifact order does not change the document", () => {
    const forwards = buildProvenance({
      manifest: MANIFEST,
      artifacts: ARTIFACTS,
      commit: COMMIT,
      ref: "main",
      buildTime: new Date("2026-08-29T12:00:00.000Z"),
      env: {},
    });
    const backwards = buildProvenance({
      manifest: MANIFEST,
      artifacts: [...ARTIFACTS].reverse(),
      commit: COMMIT,
      ref: "main",
      buildTime: new Date("2026-08-29T12:00:00.000Z"),
      env: {},
    });

    expect(serializeProvenance(forwards)).toBe(serializeProvenance(backwards));
  });

  it("a changed file changes the digest", () => {
    const changed = build({
      artifacts: [{ path: "dist/index.js", contents: "console.log(2);" }, ARTIFACTS[1]],
    });

    expect(changed.artifactsDigest).not.toBe(build().artifactsDigest);
  });

  it("a renamed file changes the digest", () => {
    // Computed over path:sha lines, so a rename is visible even though every
    // byte is unchanged.
    const renamed = build({
      artifacts: [{ path: "dist/main.js", contents: "console.log(1);" }, ARTIFACTS[1]],
    });

    expect(renamed.artifactsDigest).not.toBe(build().artifactsDigest);
  });

  it("a removed file changes the digest", () => {
    expect(build({ artifacts: [ARTIFACTS[0]] }).artifactsDigest).not.toBe(build().artifactsDigest);
  });

  it("digestArtifacts ignores list order", () => {
    const provenance = build();

    expect(digestArtifacts([...provenance.artifacts].reverse())).toBe(provenance.artifactsDigest);
  });
});

describe("serialisation", () => {
  it("round-trips", () => {
    const provenance = build();

    expect(parseProvenance(serializeProvenance(provenance))).toEqual(provenance);
  });

  it("ends with a newline", () => {
    expect(serializeProvenance(build()).endsWith("\n")).toBe(true);
  });

  it("returns null for unparseable input", () => {
    expect(parseProvenance("{ not json")).toBeNull();
  });

  it("returns null for JSON that is not a provenance record", () => {
    expect(parseProvenance('{"hello":"world"}')).toBeNull();
    expect(parseProvenance("[]")).toBeNull();
  });
});

describe("checkProvenance", () => {
  const packed = ["package.json", PROVENANCE_FILENAME, "dist/index.js", "dist/tools.js"];

  function statuses(results: { name: string; status: string }[]) {
    return Object.fromEntries(results.map((r) => [r.name, r.status]));
  }

  it("passes for a correct record", () => {
    const results = checkProvenance(build(), MANIFEST, packed);

    expect(results.every((r) => r.status === "pass")).toBe(true);
  });

  it("fails when the record is missing from the tarball", () => {
    const results = checkProvenance(build(), MANIFEST, ["package.json", "dist/index.js"]);

    expect(statuses(results)["provenance:packed"]).toBe("fail");
  });

  it("tells the operator how to fix a missing record", () => {
    const results = checkProvenance(null, MANIFEST, []);
    const detail = results.find((r) => r.name === "provenance:present")?.detail ?? "";

    expect(detail).toContain("pnpm provenance");
  });

  it("fails when the recorded version is stale", () => {
    // The failure this check exists for: bumping the version and forgetting to
    // regenerate.
    const results = checkProvenance(build(), { ...MANIFEST, version: "1.1.0" }, packed);

    expect(statuses(results)["provenance:version"]).toBe("fail");
  });

  it("fails when the recorded name disagrees", () => {
    const results = checkProvenance(build(), { ...MANIFEST, name: "@other/pkg" }, packed);

    expect(statuses(results)["provenance:name"]).toBe("fail");
  });

  it("fails when no commit was recorded", () => {
    const results = checkProvenance(build({ commit: null }), MANIFEST, packed);

    expect(statuses(results)["provenance:commit"]).toBe("fail");
  });

  it("fails when the commit is not a full sha", () => {
    const results = checkProvenance(build({ commit: "abc123" }), MANIFEST, packed);

    expect(statuses(results)["provenance:commit"]).toBe("fail");
  });

  it("fails when the repository disagrees with package.json", () => {
    const results = checkProvenance(
      build(),
      { ...MANIFEST, repository: "github:someone/else" },
      packed,
    );

    expect(statuses(results)["provenance:repository"]).toBe("fail");
  });

  it("accepts an equivalent repository spelling", () => {
    const results = checkProvenance(
      build(),
      { ...MANIFEST, repository: "distributed-nerd/mindvault" },
      packed,
    );

    expect(statuses(results)["provenance:repository"]).toBe("pass");
  });

  it("fails a build from a dirty tree", () => {
    const results = checkProvenance(build({ dirty: true }), MANIFEST, packed);

    expect(statuses(results)["provenance:clean"]).toBe("fail");
  });

  it("fails when there are no artifacts", () => {
    const results = checkProvenance(build({ artifacts: [] }), MANIFEST, packed);

    expect(statuses(results)["provenance:artifacts"]).toBe("fail");
  });

  it("detects a hand-edited file list", () => {
    const tampered = build();
    tampered.artifacts = tampered.artifacts.slice(0, 1);

    const results = checkProvenance(tampered, MANIFEST, packed);

    expect(statuses(results)["provenance:digest"]).toBe("fail");
  });

  it("detects a schema from an older tool", () => {
    const old = { ...build(), schemaVersion: "0.1.0" };

    expect(statuses(checkProvenance(old, MANIFEST, packed))["provenance:schema"]).toBe("fail");
  });
});

describe("checkProvenanceCoverage", () => {
  it("passes when every packed dist file has a digest", () => {
    const result = checkProvenanceCoverage(build(), [
      "package.json",
      "dist/index.js",
      "dist/tools.js",
    ]);

    expect(result.status).toBe("pass");
  });

  it("fails when the tarball carries a file the record does not know", () => {
    // The record describes a different build than the one being published.
    const result = checkProvenanceCoverage(build(), [
      "dist/index.js",
      "dist/tools.js",
      "dist/extra.js",
    ]);

    expect(result.status).toBe("fail");
    expect(result.detail).toContain("dist/extra.js");
  });

  it("ignores non-dist files", () => {
    const result = checkProvenanceCoverage(build(), [
      "package.json",
      "README.md",
      "dist/index.js",
      "dist/tools.js",
    ]);

    expect(result.status).toBe("pass");
  });
});

describe("package wiring", () => {
  it("ships the record in the tarball allowlist", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf-8"));

    // Without this the record is generated and then silently left behind.
    expect(manifest.files).toContain(PROVENANCE_FILENAME);
  });

  it("exposes a script to generate it", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf-8"));

    expect(manifest.scripts.provenance).toBeTruthy();
  });
});
