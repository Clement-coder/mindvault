import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ERROR_DESCRIPTIONS,
  Errors,
  registryErrorCodeForName,
  registryErrorDescription,
  registryErrorName,
} from "./errors.js";

/**
 * The contract's error enum is not spec-exported (it has more than the 50
 * cases the XDR spec allows), so the generated bindings carry no error table
 * and `@mindvault/registry-client` mirrors it by hand. This test fails when
 * the mirror drifts from the contract's `ERROR_SCHEMA`, which is the single
 * source of truth.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const contractSource = readFileSync(
  resolve(repoRoot, "contract/contracts/vault-registry/src/lib.rs"),
  "utf-8",
);

function contractErrorSchema(): Map<number, string> {
  const start = contractSource.indexOf("pub const ERROR_SCHEMA");
  expect(start).toBeGreaterThan(-1);
  const end = contractSource.indexOf("\n];", start);
  const body = contractSource.slice(start, end);
  const entries = [...body.matchAll(/\(\s*(\d+),\s*"([A-Za-z]+)"/g)];
  return new Map(entries.map(([, code, name]) => [Number(code), name]));
}

/**
 * The contract's error descriptions, parsed from the third element of each
 * `ERROR_SCHEMA` triple.
 */
function contractErrorDescriptions(): Map<number, string> {
  const start = contractSource.indexOf("pub const ERROR_SCHEMA");
  expect(start).toBeGreaterThan(-1);
  const end = contractSource.indexOf("\n];", start);
  const body = contractSource.slice(start, end);
  const entries = [...body.matchAll(/\(\s*(\d+),\s*"([A-Za-z]+)",\s*"((?:[^"\\]|\\.)*)"\s*\)/g)];
  return new Map(entries.map(([, code, , description]) => [Number(code), description]));
}

describe("Errors", () => {
  it("mirrors the contract's ERROR_SCHEMA exactly", () => {
    const schema = contractErrorSchema();
    expect(schema.size).toBeGreaterThan(0);

    const mirrored = new Map(
      Object.entries(Errors).map(([code, error]) => [Number(code), error.message]),
    );
    expect(mirrored).toEqual(schema);
  });

  it("mirrors the contract's error descriptions exactly", () => {
    const schema = contractErrorDescriptions();
    expect(schema.size).toBeGreaterThan(0);

    const mirrored = new Map(
      Object.entries(ERROR_DESCRIPTIONS).map(([code, description]) => [Number(code), description]),
    );
    expect(mirrored).toEqual(schema);
  });

  it("describes exactly the codes it names", () => {
    // A description without a name, or a name without a description, would
    // leave an agent with half an explanation for a failed invocation.
    expect(
      Object.keys(ERROR_DESCRIPTIONS)
        .map(Number)
        .sort((a, b) => a - b),
    ).toEqual(
      Object.keys(Errors)
        .map(Number)
        .sort((a, b) => a - b),
    );
  });

  it("keeps the historic codes stable", () => {
    // Consumers match on these names; renaming one silently changes what a
    // failed invocation looks like to a caller.
    expect(Errors[2].message).toBe("NotFound");
    expect(Errors[6].message).toBe("Unauthorized");
  });
});

describe("error lookups", () => {
  it("resolves a code to its name and description", () => {
    expect(registryErrorName(2)).toBe("NotFound");
    expect(registryErrorDescription(2)).toContain("No resource");
  });

  it("resolves a name back to its code", () => {
    expect(registryErrorCodeForName("NotFound")).toBe(2);
    expect(registryErrorCodeForName("ContractPaused")).toBe(40);
  });

  it("returns undefined for codes and names it does not know", () => {
    expect(registryErrorName(9999)).toBeUndefined();
    expect(registryErrorDescription(9999)).toBeUndefined();
    expect(registryErrorCodeForName("NotARealError")).toBeUndefined();
  });
});
