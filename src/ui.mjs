import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function ui() {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("Open fission in an interactive terminal. Use fission help for commands or fission list --json for agents.");
  const binary = fileURLToPath(new URL("../tui/target/release/fission-tui", import.meta.url));
  try { await access(binary); }
  catch { throw new Error("Build the Rust TUI with npm run build in the Fission repository, then run fission."); }
  const child = spawn(binary, [process.execPath, fileURLToPath(new URL("./ui-data.mjs", import.meta.url))], { stdio: "inherit" });
  const interrupt = () => {}; // The Rust frontend or SSH owns terminal interrupts.
  const terminate = () => child.kill("SIGTERM");
  process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
  } finally { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); }
}
