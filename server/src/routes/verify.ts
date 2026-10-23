import { Router, type Router as RouterType } from "express";
import { paymentMiddleware } from "@x402/express";
import type { RoutesConfig } from "@x402/core/server";
import { eq, desc, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { resources, verifications } from "../db/schema.js";
import { checkOriginality } from "../services/verificationService.js";

import { config } from "../config.js";
import { getLogger } from "../lib/logger.js";
import { network, sharedX402ResourceServer } from "../lib/x402.js";
import { verifyIpRateLimit, verifyWalletRateLimit } from "../middleware/rateLimiters.js";
import { validate } from "../middleware/validate.js";
import { verifyContentSchema } from "../schemas/requests.js";

const router: RouterType = Router();

const verifyRoutes: RoutesConfig = {
  "POST /verify-content": {
    accepts: {
      scheme: "exact" as const,
      network,
      payTo: config.PAY_TO,
      price: `$${config.VERIFICATION_PRICE}`,
    },
    description: "AI content originality verification",
  },
};

const verifyPaywall = paymentMiddleware(verifyRoutes, sharedX402ResourceServer);

// POST /verify-content — AI originality check (x402 paywalled)
router.post(
  "/verify-content",
  verifyIpRateLimit,
  verifyPaywall,
  verifyWalletRateLimit,
  validate(verifyContentSchema),
  async (req, res) => {
    const { content, resourceId } = req.body;

    const result = await checkOriginality(content, "text");
    const { usage } = result;

    // Structured usage log so verification spend is visible (#283). No content
    // or secrets are logged — only token counts and the estimated cost.
    getLogger().info(
      {
        event: "verification_usage",
        resourceId: resourceId ?? null,
        model: config.OPENROUTER_MODEL,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        estimatedCostUsd: usage.estimatedCostUsd,
      },
      "verification token usage",
    );

    // If a resourceId is provided, save the verification result
    if (resourceId) {
      const [verification] = await db
        .insert(verifications)
        .values({
          resourceId,
          isOriginal: result.isOriginal,
          confidence: result.confidence,
          flags: JSON.stringify(result.flags),
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          estimatedCost: usage.estimatedCostUsd.toString(),
        })
        .returning();

      // Update resource status — listing is independent of on-chain registration
      await db
        .update(resources)
        .set({
          verificationStatus: result.isOriginal ? "verified" : "rejected",
          verificationId: verification.id,
          listed: result.isOriginal,
        })
        .where(eq(resources.id, resourceId));
    }

    res.json(result);
  },
);

// GET /agent/status — public agent stats
router.get("/agent/status", async (_req, res) => {
  // All verifications
  const allVerifications = await db
    .select({
      id: verifications.id,
      resourceId: verifications.resourceId,
      isOriginal: verifications.isOriginal,
      confidence: verifications.confidence,
      flags: verifications.flags,
      promptTokens: verifications.promptTokens,
      completionTokens: verifications.completionTokens,
      totalTokens: verifications.totalTokens,
      estimatedCost: verifications.estimatedCost,
      checkedAt: verifications.checkedAt,
    })
    .from(verifications)
    .orderBy(desc(verifications.checkedAt));

  // Get resource titles for recent activity in a single batched query
  const recentVerifications = allVerifications.slice(0, 10);
  const recentResourceIds = [...new Set(recentVerifications.map((v) => v.resourceId))];

  const titleRows =
    recentResourceIds.length > 0
      ? await db
          .select({ id: resources.id, title: resources.title })
          .from(resources)
          .where(inArray(resources.id, recentResourceIds))
      : [];
  const titleById = new Map(titleRows.map((r) => [r.id, r.title]));

  const recentWithTitles = recentVerifications.map((v) => ({
    id: v.id,
    resourceTitle: titleById.get(v.resourceId) || "Unknown",
    isOriginal: v.isOriginal,
    confidence: v.confidence,
    flags: v.flags ? JSON.parse(v.flags) : [],
    checkedAt: v.checkedAt,
  }));

  const totalVerifications = allVerifications.length;
  const verified = allVerifications.filter((v) => v.isOriginal).length;
  const rejected = allVerifications.filter((v) => !v.isOriginal).length;
  const pricePerVerification = parseFloat(config.VERIFICATION_PRICE);
  const totalEarned = totalVerifications * pricePerVerification;
  const avgConfidence =
    totalVerifications > 0
      ? allVerifications.reduce((sum, v) => sum + v.confidence, 0) / totalVerifications
      : 0;

  // Aggregate model token usage + estimated spend across all verifications (#283).
  const totalPromptTokens = allVerifications.reduce((sum, v) => sum + (v.promptTokens ?? 0), 0);
  const totalCompletionTokens = allVerifications.reduce(
    (sum, v) => sum + (v.completionTokens ?? 0),
    0,
  );
  const totalTokens = allVerifications.reduce((sum, v) => sum + (v.totalTokens ?? 0), 0);
  const totalEstimatedCost = allVerifications.reduce(
    (sum, v) => sum + (v.estimatedCost ? Number(v.estimatedCost) : 0),
    0,
  );

  res.json({
    agent: {
      name: "MindVault Verification Agent",
      walletAddress: config.PAY_TO,
      network: config.NETWORK,
      endpoint: `${config.BASE_URL}/verify-content`,
      pricePerVerification: config.VERIFICATION_PRICE,
      currency: "USDC",
      status: "active",
    },
    stats: {
      totalVerifications,
      verified,
      rejected,
      totalEarned: totalEarned.toFixed(4),
      avgConfidence: avgConfidence.toFixed(2),
    },
    usage: {
      totalPromptTokens,
      totalCompletionTokens,
      totalTokens,
      estimatedCostUsd: totalEstimatedCost.toFixed(6),
      model: config.OPENROUTER_MODEL,
    },
    recentActivity: recentWithTitles,
  });
});

export default router;

// Issue #1030: bounded cancellation support for long-running verification
import type { Request, Response } from "express";

export function withTimeout(ms: number, abortController?: AbortController) {
  const controller = abortController ?? new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("timeout")), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout),
  };
}

export async function cancelableRequest<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<{ status: "ok"; result: T } | { status: "canceled"; reason: string }> {
  const { signal, clear } = withTimeout(ms);
  try {
    const result = await fn(signal);
    clear();
    return { status: "ok", result };
  } catch (err: any) {
    clear();
    if (err?.name === "AbortError" || signal.aborted) {
      return { status: "canceled", reason: "timeout" };
    }
    throw err;
  }
}
