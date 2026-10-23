import { Router, type Router as RouterType } from "express";
import { apiKeyAuth } from "../middleware/apiKeyAuth.js";
import { requestSignatureAuth } from "../middleware/requestSignatureAuth.js";
import { singleFileUpload, validateUploadContentType } from "../middleware/uploadGuards.js";
import { validate, validateFields } from "../middleware/validate.js";
import {
  filePublishBodySchema,
  catalogQuerySchema,
  linkPublishSchema,
  registerResourceSchema,
  preparePriceSchema,
  setPriceSchema,
  prepareOwnershipSchema,
  transferOwnershipSchema,
  CATALOG_DEFAULT_LIMIT,
} from "../schemas/requests.js";
import { dynamicPaywall } from "../middleware/dynamicPaywall.js";
import {
  createFileResource,
  createLinkResource,
  listCatalog,
  countCatalog,
  getResourceMeta,
  getVerificationDetails,
  delistResource,
  getResourceById,
} from "../services/resourceService.js";
import { downloadFile } from "../storage/supabaseStorage.js";
import { db } from "../db/client.js";
import { payments, resources } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { getLogger } from "../lib/logger.js";
import { publishIpRateLimit, publishWalletRateLimit } from "../middleware/rateLimiters.js";
import { getIdempotencyStore, idempotencyCacheKey } from "../lib/idempotency.js";
import { buildRegistrationFailureGuidance, explorerTxUrl } from "../lib/registrationGuidance.js";
import {
  NETWORK_PASSPHRASE,
  registryClient,
  registryKeypair,
  setPrice,
  transferOwnership,
  buildRegisterTx,
  submitSignedTx,
} from "../services/registryClient.js";
import { parsePayerFromXPayment } from "../lib/parseXPayment.js";

const router: RouterType = Router();

const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;

// POST /resources — publish a resource (authenticated)
router.post(
  "/resources",
  apiKeyAuth,
  publishIpRateLimit,
  publishWalletRateLimit,
  singleFileUpload("file"),
  validateUploadContentType,
  requestSignatureAuth,
  async (req, res) => {
    const publisher = req.publisher!;

    // Idempotency (#114): if the client supplies an Idempotency-Key, a retry
    // with the same key returns the original result instead of creating a
    // duplicate. Keys are scoped per publisher.
    const idemKey = req.header("Idempotency-Key");
    const store = getIdempotencyStore();
    const scopedKey = idemKey ? idempotencyCacheKey(publisher.id, idemKey) : null;

    if (scopedKey) {
      const existing = store.get(scopedKey);
      if (existing) {
        if (existing.inProgress) {
          // A concurrent request with the same key is still running.
          res.status(409).json({ error: "Idempotent request already in progress" });
          return;
        }
        res.status(existing.result.status).json(existing.result.body);
        return;
      }
      store.set(scopedKey, { inProgress: true });
    }

    // Records the final result under the idempotency key (when keyed), then responds.
    const sendResult = (status: number, body: unknown) => {
      if (scopedKey) store.set(scopedKey, { inProgress: false, result: { status, body } });
      res.status(status).json(body);
    };

    try {
      // File upload
      if (req.file) {
        const parsed = validateFields(filePublishBodySchema, req.body);
        if (!parsed.success) {
          // Validation failures aren't a committed result — release the key so
          // a corrected retry can proceed.
          if (scopedKey) store.delete(scopedKey);
          res.status(400).json({ error: parsed.error.format() });
          return;
        }

        const { title, description, price, walletAddress } = parsed.data;

        const resource = await createFileResource({
          publisherId: publisher.id,
          title,
          description,
          price,
          walletAddress: walletAddress || publisher.walletAddress,
          fileBuffer: req.file.buffer,
          filename: req.file.originalname,
          mimeType: req.file.mimetype,
        });

        sendResult(201, {
          ...resource,
          accessUrl: `${config.BASE_URL}/resources/${resource.id}`,
        });
        return;
      }

      // Link resource
      const parsed = linkPublishSchema.safeParse(req.body);
      if (!parsed.success) {
        if (scopedKey) store.delete(scopedKey);
        res.status(400).json({ error: parsed.error.format() });
        return;
      }

      const resource = await createLinkResource({
        publisherId: publisher.id,
        title: parsed.data.title,
        description: parsed.data.description,
        price: parsed.data.price,
        walletAddress: parsed.data.walletAddress || publisher.walletAddress,
        externalUrl: parsed.data.externalUrl,
      });

      sendResult(201, {
        ...resource,
        accessUrl: `${config.BASE_URL}/resources/${resource.id}`,
      });
    } catch (err) {
      // Publish failed — release the key so the client can retry rather than
      // being stuck behind a stale in-progress marker.
      if (scopedKey) store.delete(scopedKey);
      throw err;
    }
  },
);

// GET /resources — browse catalog (public)
//
// Pagination (#162): `limit` (default 20, max 100) and `offset` control the page.
// Metadata for fetching the next page is returned via response headers rather
// than the body, so the response stays a plain array for existing clients:
//   X-Total-Count, X-Limit, X-Offset, X-Next-Offset (omitted on the last page)
//
// Sorting (#163): `sort` accepts newest (default), price_asc, price_desc, title.
router.get("/resources", async (req, res) => {
  const parsed = catalogQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid query params" });
    return;
  }

  const hasFilters = Object.values(parsed.data).some((v) => v !== undefined);
  const limit = parsed.data.limit ?? CATALOG_DEFAULT_LIMIT;
  const offset = parsed.data.offset ?? 0;

  const filters = { ...parsed.data, limit, offset };

  const [catalog, total] = await Promise.all([
    listCatalog(filters),
    countCatalog(hasFilters ? parsed.data : undefined),
  ]);

  const nextOffset = offset + catalog.length < total ? offset + catalog.length : null;

  res.setHeader("X-Total-Count", String(total));
  res.setHeader("X-Limit", String(limit));
  res.setHeader("X-Offset", String(offset));
  if (nextOffset !== null) res.setHeader("X-Next-Offset", String(nextOffset));

  res.json(
    catalog.map((r) => ({
      ...r,
      accessUrl: `${config.BASE_URL}/resources/${r.id}`,
    })),
  );
});

// GET /resources/:id/meta — resource preview (public)
router.get("/resources/:id/meta", async (req, res) => {
  const meta = await getResourceMeta(req.params.id as string);
  if (!meta) {
    res.status(404).json({ error: "Resource not found" });
    return;
  }
  res.json({
    ...meta,
    accessUrl: `${config.BASE_URL}/resources/${meta.id}`,
    ...(meta.mimeType?.startsWith("image/")
      ? { thumbnailUrl: `${config.BASE_URL}/resources/${meta.id}/thumbnail` }
      : {}),
  });
});

// GET /resources/:id/verification — verification status and details (public)
router.get("/resources/:id/verification", async (req, res) => {
  const details = await getVerificationDetails(req.params.id as string);
  if (!details) {
    res.status(404).json({ error: "Resource not found" });
    return;
  }
  res.json(details);
});

// GET /resources/:id/thumbnail — resource thumbnail (public)
router.get("/resources/:id/thumbnail", async (req, res) => {
  const resource = await getResourceById(req.params.id as string);
  if (!resource || !resource.storagePath || !resource.mimeType?.startsWith("image/")) {
    res.status(404).json({ error: "Thumbnail not found" });
    return;
  }

  const filename = resource.storagePath.split("/").pop();
  const thumbStoragePath = `${resource.id}/thumb_${filename}`;

  try {
    const { buffer, mimeType } = await downloadFile(thumbStoragePath);
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Cache-Control", "public, max-age=31536000");
    res.send(buffer);
  } catch (err) {
    res.status(404).json({ error: "Thumbnail not found" });
  }
});

// GET /resources/:id — access resource (x402 paywalled)
router.get("/resources/:id", dynamicPaywall, async (req, res) => {
  const resource = (req as any).resource;

  // Record payment — best-effort payer extraction, never blocks delivery
  let payerAddress = "unknown";
  const paymentHeader = req.headers["x-payment"];
  if (paymentHeader && typeof paymentHeader === "string") {
    const { payer, parseError } = parsePayerFromXPayment(paymentHeader);
    if (payer) {
      payerAddress = payer;
    } else if (parseError) {
      getLogger().warn(
        { event: "x_payment_parse_error", resourceId: resource.id, error: parseError },
        "failed to parse X-Payment header; payer recorded as unknown",
      );
    }
  }

  const [payment] = await db
    .insert(payments)
    .values({
      resourceId: resource.id,
      payerAddress,
      recipientAddress: resource.walletAddress,
      amount: resource.price,
    })
    .returning();

  if (resource.resourceType === "link") {
    res.json({
      url: resource.externalUrl,
      receipt: {
        paymentId: payment.id,
        amount: payment.amount,
        currency: "USDC",
        paidTo: payment.recipientAddress,
        paidAt: payment.paidAt,
      },
    });
    return;
  }

  // Stream file from Supabase Storage
  if (!resource.storagePath) {
    res.status(500).json({ error: "Resource file not found" });
    return;
  }

  // Add receipt info in headers for file downloads
  res.setHeader("X-Payment-Id", payment.id);
  res.setHeader("X-Payment-Amount", `${payment.amount} USDC`);
  res.setHeader("X-Payment-Recipient", payment.recipientAddress);

  const { buffer, mimeType } = await downloadFile(resource.storagePath);
  res.setHeader("Content-Type", mimeType);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${resource.storagePath.split("/").pop()}"`,
  );
  res.send(buffer);
});

// DELETE /resources/:id — delist a resource (authenticated, owner only)
router.delete("/resources/:id", apiKeyAuth, requestSignatureAuth, async (req, res) => {
  const resource = await delistResource(req.params.id as string, req.publisher!.id);
  if (!resource) {
    res.status(404).json({ error: "Resource not found or not owned by you" });
    return;
  }
  res.json({ message: "Resource delisted", id: resource.id });
});

// GET /resources/:id/register/prepare — get unsigned register tx (owner only)
router.get("/resources/:id/register/prepare", apiKeyAuth, async (req, res) => {
  const publisher = req.publisher!;
  const resourceId = req.params.id as string;

  const resource = await delistResource(resourceId, publisher.id);
  if (!resource) {
    res.status(404).json({ error: "Resource not found or not owned by publisher" });
    return;
  }

  res.json({ id: resource.id, listed: resource.listed });
});

// POST /resources/:id/register — register a verified resource on-chain (owner only)
// Can be called again to retry if onchainStatus is "failed".
router.post(
  "/resources/:id/register",
  apiKeyAuth,
  requestSignatureAuth,
  validate(registerResourceSchema),
  async (req, res) => {
    const publisher = req.publisher!;
    const resourceId = req.params.id as string;

    const resource = await getResourceById(resourceId);
    if (!resource) {
      res.status(404).json({ error: "Resource not found" });
      return;
    }
    if (resource.publisherId !== publisher.id) {
      res.status(403).json({ error: "Forbidden: you do not own this resource" });
      return;
    }
    if (resource.verificationStatus !== "verified") {
      res.status(400).json({ error: "Resource must be verified before registering on-chain" });
      return;
    }
    if (resource.onchainStatus === "registered") {
      res.status(409).json({
        error: "Resource is already registered on-chain",
        onchainTxHash: resource.onchainTxHash,
      });
      return;
    }
    // "pending" means a registration is already in-flight — don't double-submit
    if (resource.onchainStatus === "pending") {
      res.status(409).json({
        error: "Registration already in progress",
        message:
          "An on-chain registration for this resource is already pending. A background worker retries pending registrations automatically for a few minutes.",
        nextSteps: [
          "Wait for the pending registration to settle — re-check this resource's onchainStatus shortly.",
          `If it is still pending after several minutes, the retry worker marks it "failed", after which you can retry with POST /resources/${resourceId}/register.`,
          ...(resource.onchainTxHash
            ? [`Inspect the in-flight transaction: ${explorerTxUrl(resource.onchainTxHash)}`]
            : []),
        ],
        ...(resource.onchainTxHash ? { txHash: resource.onchainTxHash } : {}),
      });
      return;
    }
    // "none" or "failed" → proceed (failed is retryable)

    // Build and submit the registration transaction
    const metadata = `${config.BASE_URL}/resources/${resourceId}`;
    const unsignedXdr = await buildRegisterTx(
      resource.walletAddress,
      resourceId,
      resource.price,
      metadata,
    );
    const signedXdr = unsignedXdr; // We'll sign with the server's registry keypair
    // Actually sign it
    const { TransactionBuilder, Networks } = await import("@stellar/stellar-sdk");
    const { Keypair } = await import("@stellar/stellar-sdk");
    // For now, use the registry client approach
    try {
      if (signedXdr) {
        // New flow: submit signed XDR
        const result = await submitSignedTx(signedXdr);

        if (result.success) {
          getLogger().info(
            {
              event: "onchain_register",
              resourceId,
              txHash: result.txHash,
              success: true,
            },
            "on-chain resource registration succeeded",
          );
          const [updated] = await db
            .update(resources)
            .set({ onchainStatus: "registered", onchainTxHash: result.txHash })
            .where(eq(resources.id, resourceId))
            .returning();

          res.json({
            id: updated.id,
            onchainStatus: updated.onchainStatus,
            txHash: result.txHash,
          });
        } else {
          getLogger().warn(
            {
              event: "onchain_register",
              resourceId,
              txHash: result.txHash || undefined,
              success: false,
              error: result.error,
            },
            "on-chain resource registration failed",
          );
          await db
            .update(resources)
            .set({ onchainStatus: "failed" })
            .where(eq(resources.id, resourceId));
          const guidance = buildRegistrationFailureGuidance({
            resourceId,
            txHash: result.txHash,
            detail: result.error,
          });
          res.status(502).json({
            error: "On-chain registration failed",
            detail: result.error,
            txHash: result.txHash || undefined,
            ...guidance,
          });
        }
      } else {
        // Legacy flow: server signs and submits
        const priceStroops = BigInt(Math.round(parseFloat(resource.price) * 1_000_000_0));
        const tx = await (registryClient as any).register(
          {
            creator: resource.walletAddress,
            id: resourceId,
            price: priceStroops,
            metadata: JSON.stringify({
              title: resource.title,
              description: resource.description ?? "",
            }),
            tags: [],
          },
          { simulate: false },
        );

        const sentTx = await tx.signAndSend({
          signTransaction: async (xdr: string) => {
            const { Transaction } = await import("@stellar/stellar-sdk");
            const stellarTx = new Transaction(xdr, NETWORK_PASSPHRASE);
            stellarTx.sign(registryKeypair);
            return stellarTx.toXDR();
          },
        });

        const legacyTxHash = sentTx?.sendTransactionResponse?.hash ?? "";
        getLogger().info(
          {
            event: "onchain_register",
            resourceId,
            txHash: legacyTxHash,
            success: true,
            flow: "legacy",
          },
          "on-chain resource registration succeeded",
        );

        const [updated] = await db
          .update(resources)
          .set({
            onchainStatus: "registered",
            ...(legacyTxHash ? { onchainTxHash: legacyTxHash } : {}),
          })
          .where(eq(resources.id, resourceId))
          .returning();

        res.json({
          id: updated.id,
          onchainStatus: updated.onchainStatus,
          ...(legacyTxHash ? { txHash: legacyTxHash } : {}),
        });
      }
    } catch (err: any) {
      getLogger().error(
        { event: "onchain_register", resourceId, success: false, err },
        "on-chain resource registration failed",
      );
      // Mark failed but do NOT touch `listed` — resource stays available for purchase
      await db
        .update(resources)
        .set({ onchainStatus: "failed" })
        .where(eq(resources.id, resourceId));
      const guidance = buildRegistrationFailureGuidance({
        resourceId,
        detail: err?.message,
      });
      res.status(502).json({
        error: "On-chain registration failed",
        detail: err?.message,
        ...guidance,
      });
    }
  },
);

// POST /resources/:id/price/prepare — prepare unsigned set_price tx (publisher only)
router.post(
  "/resources/:id/price/prepare",
  apiKeyAuth,
  requestSignatureAuth,
  validate(preparePriceSchema),
  async (req, res) => {
    const publisher = req.publisher!;
    const resourceId = req.params.id as string;

    const resource = await getResourceById(resourceId);
    if (!resource) {
      res.status(404).json({ error: "Resource not found" });
      return;
    }
    if (resource.publisherId !== publisher.id) {
      res.status(403).json({ error: "Forbidden: you do not own this resource" });
      return;
    }

    const { newPrice } = req.body;

    const unsignedXdr = await setPrice(resourceId, newPrice);
    res.json({ unsignedXdr, networkPassphrase: NETWORK_PASSPHRASE });
  },
);

// POST /resources/:id/price — submit signed set_price tx and sync DB price
router.post(
  "/resources/:id/price",
  apiKeyAuth,
  requestSignatureAuth,
  validate(setPriceSchema),
  async (req, res) => {
    const publisher = req.publisher!;
    const resourceId = req.params.id as string;

    const resource = await getResourceById(resourceId);
    if (!resource) {
      res.status(404).json({ error: "Resource not found" });
      return;
    }
    if (resource.publisherId !== publisher.id) {
      res.status(403).json({ error: "Forbidden: you do not own this resource" });
      return;
    }

    const { signedXdr, price } = req.body;

    // Submit the signed transaction via the registry client's underlying RPC server
    const { rpc: StellarRpc, Transaction: StellarTransaction } =
      await import("@stellar/stellar-sdk");
    const rpcServer = new StellarRpc.Server(config.SOROBAN_RPC_URL);
    const signedTx = new StellarTransaction(signedXdr, NETWORK_PASSPHRASE);
    const sendResult = await rpcServer.sendTransaction(signedTx);

    if (sendResult.status !== "PENDING") {
      res.status(502).json({ error: "Transaction rejected", detail: sendResult.status });
      return;
    }

    // Poll for confirmation
    const txHash = sendResult.hash;
    let confirmed = false;
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const txResult = await rpcServer.getTransaction(txHash);
      if (txResult.status === StellarRpc.Api.GetTransactionStatus.SUCCESS) {
        confirmed = true;
        break;
      }
      if (txResult.status === StellarRpc.Api.GetTransactionStatus.FAILED) {
        res.status(502).json({ error: "Transaction failed on-chain" });
        return;
      }
    }
    if (!confirmed) {
      res.status(504).json({ error: "Transaction confirmation timed out" });
      return;
    }

    // Sync the DB price to match the on-chain value
    const [updated] = await db
      .update(resources)
      .set({ price })
      .where(eq(resources.id, resourceId))
      .returning();

    res.json({ id: updated.id, price: updated.price, status: "confirmed" });
  },
);

// POST /resources/:id/ownership/prepare — build unsigned transfer_ownership tx (owner only)
router.post(
  "/resources/:id/ownership/prepare",
  apiKeyAuth,
  requestSignatureAuth,
  validate(prepareOwnershipSchema),
  async (req, res) => {
    const publisher = req.publisher!;
    const resourceId = req.params.id as string;

    const resource = await getResourceById(resourceId);
    if (!resource) {
      res.status(404).json({ error: "Resource not found" });
      return;
    }
    if (resource.publisherId !== publisher.id) {
      res.status(403).json({ error: "Forbidden: you do not own this resource" });
      return;
    }

    const { newCreator } = req.body;

    const unsignedXdr = await transferOwnership(resourceId, newCreator);
    res.json({ unsignedXdr, networkPassphrase: NETWORK_PASSPHRASE });
  },
);

// POST /resources/:id/ownership — submit signed transfer_ownership tx and sync DB
router.post(
  "/resources/:id/ownership",
  apiKeyAuth,
  requestSignatureAuth,
  validate(transferOwnershipSchema),
  async (req, res) => {
    const publisher = req.publisher!;
    const resourceId = req.params.id as string;

    const resource = await getResourceById(resourceId);
    if (!resource) {
      res.status(404).json({ error: "Resource not found" });
      return;
    }
    if (resource.publisherId !== publisher.id) {
      res.status(403).json({ error: "Forbidden: you do not own this resource" });
      return;
    }

    const { signedXdr, newCreator } = req.body;

    const { rpc: StellarRpc, Transaction: StellarTransaction } =
      await import("@stellar/stellar-sdk");
    const rpcServer = new StellarRpc.Server(config.SOROBAN_RPC_URL);
    const signedTx = new StellarTransaction(signedXdr, NETWORK_PASSPHRASE);
    const sendResult = await rpcServer.sendTransaction(signedTx);

    if (sendResult.status !== "PENDING") {
      res.status(502).json({ error: "Transaction rejected", detail: sendResult.status });
      return;
    }

    const txHash = sendResult.hash;
    let confirmed = false;
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const txResult = await rpcServer.getTransaction(txHash);
      if (txResult.status === StellarRpc.Api.GetTransactionStatus.SUCCESS) {
        confirmed = true;
        break;
      }
      if (txResult.status === StellarRpc.Api.GetTransactionStatus.FAILED) {
        res.status(502).json({ error: "Transaction failed on-chain" });
        return;
      }
    }
    if (!confirmed) {
      res.status(504).json({ error: "Transaction confirmation timed out" });
      return;
    }

    const [updated] = await db
      .update(resources)
      .set({ walletAddress: newCreator })
      .where(eq(resources.id, resourceId))
      .returning();

    res.json({ id: updated.id, newCreator: updated.walletAddress, status: "confirmed" });
  },
);

export default router;
