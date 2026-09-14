import { statfs, access, stat } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { root } from "./state.mjs";

export const storageRoot = (path) => resolve(path || process.env.FISSION_STORAGE_DIR || join(root, ".cache"));

export async function storage(path, required = 0) {
  if (!Number.isSafeInteger(required) || required < 0) throw new Error("Storage size must be a nonnegative integer number of bytes.");
  const directory = storageRoot(path);
  if (path || process.env.FISSION_STORAGE_DIR) {
    try { if (!(await stat(directory)).isDirectory()) throw new Error("Not a directory"); }
    catch { throw new Error("The selected storage directory must exist. Mount the drive or create the directory first."); }
  }
  let existing = directory;
  while (true) {
    try { await access(existing); break; }
    catch (error) {
      if (error.code !== "ENOENT" || dirname(existing) === existing) throw error;
      existing = dirname(existing);
    }
  }
  const info = await statfs(existing);
  const availableBytes = info.bavail * info.bsize;
  return { mode: "local", directory, availableBytes, requiredBytes: required, fits: required <= availableBytes,
    recurringStorageCharge: "0", custody: "Files remain in your chosen directory after rental cleanup.",
    configure: "Use --storage-dir PATH or set FISSION_STORAGE_DIR. External drives and user-mounted storage work as local paths." };
}
