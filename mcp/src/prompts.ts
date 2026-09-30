/**
 * MCP prompts capability for MindVault.
 *
 * Provides guided publish and buy workflows that agents can follow step-by-step.
 * Each prompt references only tools that exist in the current tool list.
 */

export interface PromptArgument {
  name: string;
  description: string;
  required: boolean;
}

export interface PromptDefinition {
  name: string;
  description: string;
  arguments: PromptArgument[];
}

export const PROMPT_DEFINITIONS: PromptDefinition[] = [
  {
    name: "publish",
    description:
      "Guided workflow for publishing a resource to MindVault. Walks through wallet setup, publisher registration, and the publish flow with verification.",
    arguments: [
      {
        name: "title",
        description: "Resource title (1–256 characters).",
        required: true,
      },
      {
        name: "price",
        description: "Price in USDC as a decimal string, e.g. '5.00'.",
        required: true,
      },
      {
        name: "externalUrl",
        description: "Public http(s) URL buyers receive after payment.",
        required: true,
      },
      {
        name: "description",
        description: "Optional detailed description (max 2048 characters).",
        required: false,
      },
    ],
  },
  {
    name: "buy",
    description:
      "Guided workflow for purchasing a resource from MindVault. Walks through wallet setup, balance check, and the buy flow with x402 payment.",
    arguments: [
      {
        name: "resourceId",
        description: "The resource ID to buy (from mindvault_browse or mindvault_search).",
        required: true,
      },
    ],
  },
];

/**
 * Resolve a prompt by name with argument substitution.
 * Returns the prompt messages for the agent to follow.
 */
export function getPrompt(
  name: string,
  args: Record<string, string | undefined>,
): {
  description: string;
  messages: Array<{ role: string; content: { type: string; text: string } }>;
} {
  const title = args.title ?? "<title>";
  const price = args.price ?? "<price>";
  const externalUrl = args.externalUrl ?? "<url>";
  const description = args.description ?? "";
  const resourceId = args.resourceId ?? "<resourceId>";

  switch (name) {
    case "publish":
      return {
        description: "Guided publish workflow for MindVault",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `I want to publish a resource to MindVault.`,
                `Title: ${title}`,
                `Price: ${price} USDC`,
                `URL: ${externalUrl}`,
                description ? `Description: ${description}` : null,
                ``,
                `Please walk me through the publish process step by step.`,
              ]
                .filter(Boolean)
                .join("\n"),
            },
          },
          {
            role: "assistant",
            content: {
              type: "text",
              text: [
                `I'll help you publish to MindVault. Here's the step-by-step process:`,
                ``,
                `**Step 1: Set up a wallet**`,
                `First, we need a Stellar wallet to receive payments. Run:`,
                `\`mindvault_setup_wallet\``,
                `This creates a sponsored Stellar account and persists it.`,
                ``,
                `**Step 2: Check wallet balance**`,
                `Verify the wallet has USDC for the verification fee (~$0.10):`,
                `\`mindvault_wallet_info\``,
                `If USDC balance is zero, fund the wallet address shown.`,
                ``,
                `**Step 3: Register as a publisher**`,
                `\`mindvault_register\` with your name and email.`,
                `This registers you on the MindVault API and stores the API key.`,
                ``,
                `**Step 4: Publish the resource**`,
                `\`mindvault_publish\` with:`,
                `  - title: "${title}"`,
                `  - price: "${price}"`,
                `  - externalUrl: "${externalUrl}"`,
                description ? `  - description: "${description}"` : null,
                ``,
                `The publish call will:`,
                `1. Create the resource record on the API`,
                `2. Pay the verification fee via x402 (~$0.10 USDC)`,
                `3. If verified, register on-chain automatically`,
                ``,
                `**Step 5: Check publish status**`,
                `After publishing, check verification and on-chain status:`,
                `\`mindvault_publish_status\` with the resource ID from step 4.`,
                ``,
                `**Step 6: Verify listing**`,
                `Confirm the resource appears in the catalog:`,
                `\`mindvault_browse\` or \`mindvault_search\``,
              ]
                .filter(Boolean)
                .join("\n"),
            },
          },
        ],
      };

    case "buy":
      return {
        description: "Guided buy workflow for MindVault",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `I want to buy resource "${resourceId}" from MindVault. Walk me through the process.`,
            },
          },
          {
            role: "assistant",
            content: {
              type: "text",
              text: [
                `I'll help you buy that resource. Here's the process:`,
                ``,
                `**Step 1: Set up a wallet**`,
                `If you don't have one yet:`,
                `\`mindvault_setup_wallet\``,
                ``,
                `**Step 2: Check your balance**`,
                `\`mindvault_wallet_info\``,
                `Make sure you have enough USDC to cover the resource price.`,
                `If balance is insufficient, fund the wallet address shown.`,
                ``,
                `**Step 3: Preview the resource**`,
                `Before buying, check what you're getting:`,
                `\`mindvault_preview\` with resourceId: "${resourceId}"`,
                `This shows title, description, price, and verification status.`,
                ``,
                `**Step 4: Buy the resource**`,
                `\`mindvault_buy\` with resourceId: "${resourceId}"`,
                `This pays via x402 and returns the access URL.`,
                ``,
                `**Step 5: Access your purchase**`,
                `After a successful buy, the response includes the access URL.`,
                `You can also check your purchase history:`,
                `\`mindvault_purchase_history\``,
              ].join("\n"),
            },
          },
        ],
      };

    default:
      throw new Error(`Unknown prompt: ${name}. Available prompts: publish, buy.`);
  }
}

/**
 * Validate prompt arguments against `PROMPT_DEFINITIONS`.
 * Returns an array of error messages (empty when valid).
 */
export function validatePromptArgs(name: string, args: Record<string, unknown>): string[] {
  const def = PROMPT_DEFINITIONS.find((p) => p.name === name);
  if (!def) return [`Unknown prompt: ${name}`];

  const issues: string[] = [];
  for (const param of def.arguments) {
    const val = (args as Record<string, unknown>)[param.name];
    if (param.required) {
      if (val === undefined || val === null || (typeof val === "string" && val.trim() === "")) {
        issues.push(`Missing required argument: ${param.name}`);
      }
    }
  }
  return issues;
}
