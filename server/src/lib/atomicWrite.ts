import fs from "node:fs";
import path from "node:path";

export function writeFileAtomicSync(targetPath: string, data: string | Buffer) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(
    dir,
    `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  try {
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      // fs.writeSync overloads don't accept string|Buffer as a union; cast to
      // the shared NodeJS.ArrayBufferView | string supertype via unknown.
      fs.writeSync(fd, data as unknown as string);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {
      // best effort on platforms that don't support chmod
    }
    fs.renameSync(tmp, targetPath);
    try {
      fs.chmodSync(targetPath, 0o600);
    } catch {
      // best effort
    }
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore cleanup errors
    }
    throw err;
  }
}

export function restoreFileSync(backupPath: string, targetPath: string) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const data = fs.readFileSync(backupPath);
  writeFileAtomicSync(targetPath, data);
  try {
    fs.chmodSync(targetPath, 0o600);
  } catch {
    // best effort
  }
}
