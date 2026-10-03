import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { runProcess } from "./provider.mjs";

// Empty local encryption should finish immediately; bound a broken tool during planning.
const recipientCheckMs = 10000;

export async function validateRecipient(recipient) {
  // Native X25519 recipients need no identity, plugin, prompt or network access.
  if (typeof recipient !== "string" || !/^age1[0-9a-z]{58}$/.test(recipient))
    throw new Error("--encrypt-to requires a native age public recipient (age1…). Keep the private identity elsewhere.");
  let result;
  try {
    // An empty local encryption checks the installed tool and recipient checksum.
    result = await runProcess("age", ["--encrypt", "--recipient", recipient], { timeoutMs: recipientCheckMs });
  } catch { throw new Error("Install age locally before using --encrypt-to. No payment submitted."); }
  if (result.code !== 0) throw new Error("age could not validate the public recipient. No payment submitted.");
}

export function encryptStream(recipient, outputFd, options) {
  const stream = new PassThrough();
  const child = spawn("age", ["--encrypt", "--recipient", recipient], { stdio: ["pipe", outputFd, "ignore"] });
  const abort = () => { stream.destroy(new Error("Encrypted export interrupted.")); child.kill("SIGKILL"); };
  const timeout = setTimeout(abort, Math.max(1, Math.min(180000, (options.deadline || Infinity) - Date.now())));
  options.signal?.addEventListener("abort", abort, { once: true });
  const exited = new Promise((resolve, reject) => {
    child.once("error", () => reject(new Error("Could not start age for encrypted export.")));
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error("age encryption did not finish.")));
  });
  const done = Promise.all([exited, pipeline(stream, child.stdin)]).catch((error) => {
    abort(); throw error;
  }).finally(() => { clearTimeout(timeout); options.signal?.removeEventListener("abort", abort); });
  // The transfer may fail before its caller reaches await done.
  done.catch(() => {});
  if (options.signal?.aborted) abort();
  return { stream, done, abort };
}
