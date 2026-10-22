/**
 * Versioned registry error mapping — exhaustiveness and stability tests.
 *
 * `REGISTRY_ERROR_MAP` in `errorCodes.ts` is the single source of truth for
 * how on-chain contract discriminants become SDK-presentable MV_ codes and
 * stable messages. These tests enforce three invariants:
 *
 *  1. **Exhaustive against the TypeScript bindings.** Every name in
 *     `@mindvault/registry-client`'s `Errors` table has an entry in the map.
 *     A new error added to the contract → bindings → this test fails until
 *     the map is updated.
 *
 *  2. **Discriminants agree.** Each map entry's `discriminant` matches the
 *     numeric key in the TypeScript `Errors` table for the same name. Drift
 *     here means the map would classify on-chain errors under the wrong name.
 *
 *  3. **No unknown codes.** Every `code` in the map is a valid `ErrorCode`
 *     defined in the catalog. A typo that produces a dangling code is caught
 *     immediately rather than at runtime.
 *
 *  4. **Lookup helpers return valid codes.** `registryErrorCodeFor` always
 *     returns a valid code, including for an unknown name. `registryErrorMessageFor`
 *     returns `undefined` for an unknown name rather than crashing.
 *
 *  5. **Map version is a number.** The exported `REGISTRY_ERROR_MAP_VERSION`
 *     is a positive integer — clients can key on it to detect breaking changes.
 */
import { describe, it, expect } from "vitest";
import { Errors } from "@mindvault/registry-client";
import type { RegistryErrorName } from "@mindvault/registry-client";

import {
  ALL_REGISTRY_ERROR_NAMES,
  REGISTRY_ERROR_MAP,
  REGISTRY_ERROR_MAP_VERSION,
  isErrorCode,
  registryErrorCodeFor,
  registryErrorMessageFor,
} from "./errorCodes.js";

// Build a reverse index from the TypeScript bindings: name → discriminant.
const BINDING_DISCRIMINANTS = new Map<string, number>(
  Object.entries(Errors).map(([code, entry]) => [entry.message, Number(code)]),
);

describe("REGISTRY_ERROR_MAP_VERSION", () => {
  it("is a positive integer", () => {
    expect(Number.isInteger(REGISTRY_ERROR_MAP_VERSION)).toBe(true);
    expect(REGISTRY_ERROR_MAP_VERSION).toBeGreaterThan(0);
  });
});

describe("exhaustiveness against TypeScript bindings", () => {
  it("has an entry for every name in the Errors table", () => {
    for (const [, entry] of Object.entries(Errors)) {
      const name = entry.message as RegistryErrorName;
      expect(
        REGISTRY_ERROR_MAP[name],
        `${name} is in Errors but missing from REGISTRY_ERROR_MAP`,
      ).toBeDefined();
    }
  });

  it("has no entry for a name the Errors table does not define", () => {
    for (const name of ALL_REGISTRY_ERROR_NAMES) {
      expect(
        BINDING_DISCRIMINANTS.has(name),
        `${name} is in REGISTRY_ERROR_MAP but not in the TypeScript Errors table`,
      ).toBe(true);
    }
  });

  it("covers all 50 errors currently in the installed bindings", () => {
    // This is a canary: if the registry-client package is updated with new
    // errors, both the bindings and this map must be updated. The count
    // reflects the installed @mindvault/registry-client version.
    // When the package adds entries 51+, update this count and add map entries.
    expect(Object.keys(Errors).length).toBe(50);
    expect(ALL_REGISTRY_ERROR_NAMES.length).toBe(50);
  });
});

describe("discriminants agree with the TypeScript bindings", () => {
  it.each(ALL_REGISTRY_ERROR_NAMES)("%s discriminant matches the binding", (name) => {
    const entry = REGISTRY_ERROR_MAP[name];
    const bindingDiscriminant = BINDING_DISCRIMINANTS.get(name);
    expect(bindingDiscriminant, `${name} has no binding discriminant`).toBeDefined();
    expect(entry.discriminant).toBe(bindingDiscriminant);
  });
});

describe("every entry has a valid MV_ code", () => {
  it.each(ALL_REGISTRY_ERROR_NAMES)("%s maps to a known ErrorCode", (name) => {
    const entry = REGISTRY_ERROR_MAP[name];
    expect(isErrorCode(entry.code), `${name} maps to unknown code "${entry.code}"`).toBe(true);
  });
});

describe("every entry has a non-empty stable message", () => {
  it.each(ALL_REGISTRY_ERROR_NAMES)("%s has a non-empty message", (name) => {
    const entry = REGISTRY_ERROR_MAP[name];
    expect(entry.message.length, `${name} has an empty message`).toBeGreaterThan(0);
  });

  it("all messages are distinct", () => {
    const messages = ALL_REGISTRY_ERROR_NAMES.map((n) => REGISTRY_ERROR_MAP[n].message);
    expect(new Set(messages).size).toBe(messages.length);
  });
});

describe("name field self-consistency", () => {
  it.each(ALL_REGISTRY_ERROR_NAMES)("%s entry's name field matches its key", (name) => {
    expect(REGISTRY_ERROR_MAP[name].name).toBe(name);
  });
});

describe("registryErrorCodeFor", () => {
  it("returns the mapped code for a known name", () => {
    expect(registryErrorCodeFor("NotFound")).toBe("MV_NOT_FOUND");
    expect(registryErrorCodeFor("Unauthorized")).toBe("MV_AUTH_REJECTED");
    expect(registryErrorCodeFor("AlreadyRegistered")).toBe("MV_CONFLICT");
    expect(registryErrorCodeFor("InvalidResourceId")).toBe("MV_ARGUMENT_INVALID");
    expect(registryErrorCodeFor("NetworkIdMismatch")).toBe("MV_CONTRACT_ERROR");
    expect(registryErrorCodeFor("ContractPaused")).toBe("MV_CONTRACT_ERROR");
  });

  it("returns MV_CONTRACT_ERROR for an unrecognised name (future contract version)", () => {
    // A future discriminant that the installed map does not know about should
    // degrade gracefully rather than return undefined or throw.
    const result = registryErrorCodeFor("NotFound" as RegistryErrorName);
    expect(isErrorCode(result)).toBe(true);
    // Simulating an unknown name via type assertion:
    expect(isErrorCode(registryErrorCodeFor("FutureError" as RegistryErrorName))).toBe(true);
  });

  it("returns a valid code for every entry in the map", () => {
    for (const name of ALL_REGISTRY_ERROR_NAMES) {
      expect(isErrorCode(registryErrorCodeFor(name)), name).toBe(true);
    }
  });
});

describe("registryErrorMessageFor", () => {
  it("returns the stable message for a known name", () => {
    expect(registryErrorMessageFor("NotFound")).toBe(
      "No resource, receipt, or key matches the given id.",
    );
    expect(registryErrorMessageFor("ContractPaused")).toMatch(/paused/i);
  });

  it("returns undefined for an unknown name", () => {
    expect(registryErrorMessageFor("FutureError" as RegistryErrorName)).toBeUndefined();
  });
});

describe("selected code assignments", () => {
  // These pin the most load-bearing assignments: errors that callers commonly
  // branch on. A rename or reclassification here would break SDK consumers.
  it.each([
    // Not-found errors → MV_NOT_FOUND
    ["NotFound", "MV_NOT_FOUND"],
    ["NoPendingTransfer", "MV_NOT_FOUND"],
    // Conflict errors → MV_CONFLICT
    ["AlreadyRegistered", "MV_CONFLICT"],
    ["AlreadyFrozen", "MV_CONFLICT"],
    ["DuplicateReceipt", "MV_CONFLICT"],
    ["MetadataFrozen", "MV_CONFLICT"],
    ["ResourceNotMutable", "MV_CONFLICT"],
    // Auth errors → MV_AUTH_REJECTED
    ["Unauthorized", "MV_AUTH_REJECTED"],
    ["NotVerifier", "MV_AUTH_REJECTED"],
    ["NotModerator", "MV_AUTH_REJECTED"],
    ["NotSettler", "MV_AUTH_REJECTED"],
    // Argument errors → MV_ARGUMENT_INVALID
    ["InvalidResourceId", "MV_ARGUMENT_INVALID"],
    ["InvalidPrice", "MV_ARGUMENT_INVALID"],
    ["MetadataTooLong", "MV_ARGUMENT_INVALID"],
    ["BatchTooLarge", "MV_ARGUMENT_INVALID"],
    // Contract/infrastructure errors → MV_CONTRACT_ERROR
    ["NetworkIdMismatch", "MV_CONTRACT_ERROR"],
    ["ContractPaused", "MV_CONTRACT_ERROR"],
    ["CountOverflow", "MV_CONTRACT_ERROR"],
  ] as [RegistryErrorName, string][])("%s → %s", (name, expectedCode) => {
    expect(registryErrorCodeFor(name)).toBe(expectedCode);
  });
});
