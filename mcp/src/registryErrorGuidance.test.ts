/**
 * Tests for the contract-error explainer — issue #1021.
 *
 * A failed Soroban invocation reports a number and nothing else, so these
 * tests pin down that every code the contract defines comes back with a
 * description, a retry verdict, and a step that recovers — and that an
 * unknown code stays visible instead of being guessed at.
 */
import { describe, it, expect } from "vitest";

import { ERROR_DESCRIPTIONS, Errors } from "@mindvault/registry-client";

import {
  DESCRIBED_REGISTRY_ERROR_COUNT,
  GUIDED_REGISTRY_ERROR_COUNT,
  KNOWN_REGISTRY_ERROR_COUNT,
  REGISTRY_ERROR_GUIDANCE,
  explainRegistryError,
  knownRegistryErrors,
  registryErrorGuidance,
} from "./registryErrorGuidance.js";

describe("registry error guidance", () => {
  it("covers every error the contract defines", () => {
    const names = Object.values(Errors).map((error) => error.message);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(REGISTRY_ERROR_GUIDANCE[name], `${name} has no guidance`).toBeDefined();
    }
    expect(GUIDED_REGISTRY_ERROR_COUNT).toBe(KNOWN_REGISTRY_ERROR_COUNT);
  });

  it("gives every error a description", () => {
    for (const [code, description] of Object.entries(ERROR_DESCRIPTIONS)) {
      expect(description.length, `code ${code} has an empty description`).toBeGreaterThan(10);
    }
    expect(DESCRIBED_REGISTRY_ERROR_COUNT).toBe(KNOWN_REGISTRY_ERROR_COUNT);
  });

  it("gives every error a next step that says what to do", () => {
    for (const [name, guidance] of Object.entries(REGISTRY_ERROR_GUIDANCE)) {
      expect(guidance.nextSteps.length, `${name} has no next step`).toBeGreaterThan(20);
      expect(guidance.nextSteps.endsWith("."), `${name} next step is not a sentence`).toBe(true);
      expect(["safe", "unsafe", "conditional"]).toContain(guidance.retry);
    }
  });

  it("marks a paused registry as something a caller waits out", () => {
    // The one contract error where the same call can succeed later, so it
    // must not be lumped in with the argument errors.
    expect(registryErrorGuidance("ContractPaused")?.retry).toBe("conditional");
    expect(registryErrorGuidance("NotFound")?.retry).toBe("unsafe");
  });

  it("returns undefined for a name it does not know", () => {
    expect(registryErrorGuidance("NotARealError")).toBeUndefined();
  });
});

describe("explainRegistryError", () => {
  it("explains a code", () => {
    const explanation = explainRegistryError({ code: 2 });
    expect(explanation.known).toBe(true);
    expect(explanation.code).toBe(2);
    expect(explanation.name).toBe("NotFound");
    expect(explanation.description).toContain("No resource");
    expect(explanation.category).toBe("registration");
    expect(explanation.retry).toBe("unsafe");
    expect(explanation.nextSteps).toContain("mindvault_registry_lookup");
  });

  it("explains a name", () => {
    const explanation = explainRegistryError({ name: "ContractPaused" });
    expect(explanation.known).toBe(true);
    expect(explanation.code).toBe(40);
    expect(explanation.name).toBe("ContractPaused");
    expect(explanation.description).toContain("paused");
    expect(explanation.retry).toBe("conditional");
  });

  it("explains a code and the name that agrees with it", () => {
    const explanation = explainRegistryError({ code: 40, name: "ContractPaused" });
    expect(explanation.known).toBe(true);
    expect(explanation.code).toBe(40);
  });

  it("refuses a code and a name that disagree", () => {
    const explanation = explainRegistryError({ code: 2, name: "ContractPaused" });
    expect(explanation.known).toBe(false);
    expect(explanation.nextSteps).toContain("not both");
  });

  it("keeps an unknown code visible instead of guessing", () => {
    const explanation = explainRegistryError({ code: 9999 });
    expect(explanation.known).toBe(false);
    expect(explanation.code).toBe(9999);
    expect(explanation.name).toBeNull();
    expect(explanation.description).toBeNull();
    expect(explanation.retry).toBeNull();
    expect(explanation.nextSteps).toContain("9999");
  });

  it("lists the codes that do exist when the input was unknown", () => {
    const explanation = explainRegistryError({ code: 9999 });
    expect(explanation.knownCodes?.length).toBe(KNOWN_REGISTRY_ERROR_COUNT);
    expect(explanation.knownCodes?.some((entry) => entry.code === 2)).toBe(true);
  });

  it("keeps an unknown name visible too", () => {
    const explanation = explainRegistryError({ name: "SomethingElse" });
    expect(explanation.known).toBe(false);
    expect(explanation.name).toBeNull();
    expect(explanation.knownCodes?.length).toBe(KNOWN_REGISTRY_ERROR_COUNT);
  });

  it("says nothing at all when neither identifier was given", () => {
    const explanation = explainRegistryError({});
    expect(explanation.known).toBe(false);
    expect(explanation.code).toBeNull();
  });

  it("lists the known errors in code order", () => {
    const known = knownRegistryErrors();
    expect(known[0].code).toBe(1);
    expect(known[known.length - 1].name).toBe("RevisionOverflow");
  });
});
