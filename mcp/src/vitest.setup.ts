import { beforeEach } from "vitest";
import { _clearCatalogCache } from "./catalogCache.js";

// The #556 offline catalog cache is shared module state. Clear it before every
// test so an earlier test's successful read never contaminates a later one that
// expects the "no cache" (network-failure still throws) path.
beforeEach(() => {
  _clearCatalogCache();
});
