import { Router, type Router as RouterType } from "express";
import { getLogger } from "../lib/logger.js";
import { registryClient } from "../services/registryClient.js";
import { config } from "../config.js";

const router: RouterType = Router();

// GET /registry/status — public on-chain registry metadata + live resource count
router.get("/registry/status", async (_req, res) => {
  try {
    const tx = await registryClient.count();
    const resourceCount = Number(tx.result);

    const network = config.NETWORK.includes(":") ? config.NETWORK.split(":")[1]! : config.NETWORK;

    res.set("Cache-Control", "public, max-age=30");
    res.json({
      contractId: config.REGISTRY_CONTRACT_ID,
      network,
      resourceCount,
    });
  } catch (err) {
    getLogger().error({ err, event: "registry_status_failed" }, "GET /registry/status failed");
    res.status(503).json({
      error: "registry_unavailable",
      message: "Unable to fetch registry status. Please try again later.",
    });
  }
});

export default router;

// Issue #1034: catalog comparison across testnet and mainnet profiles
export function compareCatalogs(
  testnet: Array<{ id: string; price: string; title?: string }>,
  mainnet: Array<{ id: string; price: string; title?: string }>,
) {
  const tMap = new Map(testnet.map((r) => [r.id, r]));
  const mMap = new Map(mainnet.map((r) => [r.id, r]));
  const onlyTestnet = [...tMap.keys()].filter((k) => !mMap.has(k));
  const onlyMainnet = [...mMap.keys()].filter((k) => !tMap.has(k));
  const diffs: Array<{ id: string; testnet: any; mainnet: any }> = [];
  for (const id of tMap.keys()) {
    if (!mMap.has(id)) continue;
    const t = tMap.get(id)!;
    const m = mMap.get(id)!;
    if (t.price !== m.price || t.title !== m.title) {
      diffs.push({ id, testnet: t, mainnet: m });
    }
  }
  return {
    onlyTestnet,
    onlyMainnet,
    diffs,
    counts: { testnet: testnet.length, mainnet: mainnet.length },
  };
}
