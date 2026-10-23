import fs from "node:fs";
import path from "node:path";
import { writeFileAtomicSync } from "./atomicWrite.js";

export function backupStateFile(statePath: string, backupPath?: string) {
  const backup = backupPath ?? `${statePath}.bak.${Date.now()}`;
  const dir = path.dirname(backup);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(statePath)) {
    throw new Error("state file does not exist");
  }
  const data = fs.readFileSync(statePath);
  writeFileAtomicSync(backup, data);
  try {
    fs.chmodSync(backup, 0o600);
  } catch {
    // best effort
  }
  return backup;
}
