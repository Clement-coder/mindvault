import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, renameSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RotatingJsonlWriter, rotatedPath } from "./auditLogRotation.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-restart-"));
  dirs.push(dir);
  return join(dir, "audit.jsonl");
};
const entries = (path: string) => existsSync(path)
  ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line).id)
  : [];

describe("audit log rotation restart boundaries (#1043)", () => {
  it("resumes after the live file was renamed to generation one", () => {
    const path = setup();
    writeFileSync(path, '{"id":"before"}\n');
    renameSync(path, rotatedPath(path, 1));
    const writer = new RotatingJsonlWriter({ path, maxBytes: 1024, maxFiles: 3 });
    writer.write({ id: "after" });
    expect(entries(rotatedPath(path, 1))).toEqual(["before"]);
    expect(entries(path)).toEqual(["after"]);
  });

  it("resumes after older generations shifted but before the live rename", () => {
    const path = setup();
    writeFileSync(path, '{"id":"live"}\n');
    writeFileSync(rotatedPath(path, 1), '{"id":"previous"}\n');
    renameSync(rotatedPath(path, 1), rotatedPath(path, 2));
    const writer = new RotatingJsonlWriter({ path, maxBytes: 1024, maxFiles: 3 });
    writer.write({ id: "after" });
    expect(entries(rotatedPath(path, 2))).toEqual(["previous"]);
    expect(entries(path)).toEqual(["live", "after"]);
  });

  it("preserves pre-existing entries after a normal restart", () => {
    const path = setup();
    const config = { path, maxBytes: 1024, maxFiles: 2 };
    new RotatingJsonlWriter(config).write({ id: "before" });
    new RotatingJsonlWriter(config).write({ id: "after" });
    expect(entries(path)).toEqual(["before", "after"]);
  });
});

describe("journal recovery at rotation boundaries", () => {
  for (const phase of ["staging", "publishing"] as const) {
    for (const step of [0, 1, 2, 3]) {
      it(`recovers phase ${phase} after ${step} renames`, () => {
        const path = setup();
        const config = { path, maxBytes: 1024, maxFiles: 3 };
        writeFileSync(path, '{"id":"live"}\\n');
        writeFileSync(rotatedPath(path, 1), '{"id":"one"}\\n');
        writeFileSync(rotatedPath(path, 2), '{"id":"two"}\\n');
        writeFileSync(path + ".rotation-journal", phase);
        const sources = [0, 1, 2].map((n) => n === 0 ? path : rotatedPath(path, n));
        const staged = (n: number) => path + ".rotation-stage-" + n;
        if (phase === "staging") {
          for (const n of [2, 1, 0].slice(0, step)) renameSync(sources[n], staged(n));
        } else {
          for (const n of [2, 1, 0]) renameSync(sources[n], staged(n));
          for (const n of [2, 1, 0].slice(0, step)) renameSync(staged(n), rotatedPath(path, n + 1));
        }
        new RotatingJsonlWriter(config).write({ id: "new" });
        expect(entries(path)).toEqual(["new"]);
        expect(entries(rotatedPath(path, 1))).toEqual(["live"]);
        expect(entries(rotatedPath(path, 2))).toEqual(["one"]);
        expect(entries(rotatedPath(path, 3))).toEqual(["two"]);
      });
    }
  }
});
