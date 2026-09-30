/**
 * Publish templates for known MindVault resource types.
 *
 * `mindvault_publish_template` is a read-only helper that returns a pre-filled
 * publish specification (metadata pointer hint, canonical discovery tags, and a
 * suggested USDC price) for a known resource type.  The agent reviews the
 * result and passes the fields — overriding any it wants — directly to
 * `mindvault_publish`.
 *
 * Supported resource types: dataset | code | prompt | model
 */

export type KnownResourceType = "dataset" | "code" | "prompt" | "model";

export const KNOWN_RESOURCE_TYPES: readonly KnownResourceType[] = [
  "dataset",
  "code",
  "prompt",
  "model",
];

/**
 * Per-type defaults that `applyPublishTemplate` merges with caller overrides.
 *
 * - `metadataPointer`: canonical format hint for the on-chain metadata field.
 *   The placeholder `<HASH>` must be replaced with the real content hash or
 *   IPFS/Arweave CID before calling `mindvault_publish`.
 * - `tags`: 1–8 lowercase discovery tags that match the type's domain.
 * - `suggestedPrice`: a USDC decimal string reflecting the typical value tier
 *   for this content category.
 * - `description`: a one-sentence description template the agent can expand.
 */
export interface ResourceTypeTemplate {
  metadataPointer: string;
  tags: string[];
  suggestedPrice: string;
  description: string;
}

export const RESOURCE_TYPE_TEMPLATES: Record<KnownResourceType, ResourceTypeTemplate> = {
  dataset: {
    metadataPointer: "sha256:<HASH>",
    tags: ["dataset", "data", "tabular"],
    suggestedPrice: "5.00",
    description: "A structured dataset suitable for analysis or machine-learning workloads.",
  },
  code: {
    metadataPointer: "sha256:<HASH>",
    tags: ["code", "library", "open-source"],
    suggestedPrice: "2.00",
    description: "A reusable code library, script, or software component.",
  },
  prompt: {
    metadataPointer: "sha256:<HASH>",
    tags: ["prompt", "llm", "ai"],
    suggestedPrice: "1.00",
    description: "A curated prompt or prompt template for large-language-model use.",
  },
  model: {
    metadataPointer: "ipfs://<CID>",
    tags: ["model", "ml", "weights"],
    suggestedPrice: "10.00",
    description: "A trained machine-learning model or model weights artifact.",
  },
};

// ── Public types ──────────────────────────────────────────────────────────────

export interface PublishTemplateInput {
  /** Known resource type to look up defaults for. */
  resourceType: KnownResourceType;
  /** Optional caller-supplied title to include in the output spec. */
  title?: string;
  /** Override the suggested price (decimal USDC string). */
  price?: string;
  /** Override the metadata pointer. */
  metadataPointer?: string;
  /** Override (replace, not merge) the default tags. */
  tags?: string[];
}

export interface PublishTemplateResult {
  /** The resource type the template was resolved for. */
  resourceType: KnownResourceType;
  /** Pre-filled title (the caller's title if supplied, otherwise empty). */
  title: string;
  /** Merged metadata pointer (caller override wins). */
  metadataPointer: string;
  /** Merged tags (caller override replaces defaults). */
  tags: string[];
  /** Merged price (caller override wins). */
  price: string;
  /** Description template the agent can expand. */
  description: string;
  /**
   * Human-readable hint explaining what to do next.
   * Lists which fields still contain placeholder values.
   */
  nextSteps: string[];
}

// ── Core function ─────────────────────────────────────────────────────────────

/**
 * Return a pre-filled publish spec for the given resource type.
 *
 * Caller-supplied values win over template defaults.  Fields that still
 * contain placeholder text are listed in `nextSteps` so the agent knows what
 * to fill in before calling `mindvault_publish`.
 */
export function applyPublishTemplate(input: PublishTemplateInput): PublishTemplateResult {
  const template = RESOURCE_TYPE_TEMPLATES[input.resourceType];

  const metadataPointer = input.metadataPointer ?? template.metadataPointer;
  const tags = input.tags ?? template.tags;
  const price = input.price ?? template.suggestedPrice;
  const title = input.title ?? "";
  const description = template.description;

  // Build next-step hints for any still-placeholder fields.
  const nextSteps: string[] = [];

  if (!title) {
    nextSteps.push("Supply a title before calling mindvault_publish.");
  }

  if (metadataPointer.includes("<HASH>") || metadataPointer.includes("<CID>")) {
    nextSteps.push(
      `Replace the placeholder in metadataPointer ("${metadataPointer}") with the real content hash or CID.`,
    );
  }

  if (nextSteps.length === 0) {
    nextSteps.push(
      "All required fields are filled — pass these values to mindvault_publish to proceed.",
    );
  }

  return {
    resourceType: input.resourceType,
    title,
    metadataPointer,
    tags,
    price,
    description,
    nextSteps,
  };
}
