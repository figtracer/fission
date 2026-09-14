import { readFile, mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

export async function installSkill(output) {
  const directory = resolve(output || join(homedir(), ".agents", "skills", "fission"));
  const destination = join(directory, "SKILL.md");
  const source = await readFile(new URL("../skills/fission/SKILL.md", import.meta.url), "utf8");
  await mkdir(directory, { recursive: true });
  let file;
  try { file = await open(destination, "wx", 0o600); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (await readFile(destination, "utf8") !== source)
      throw new Error(`A different skill exists at ${destination}. Preserve it or choose --output DIRECTORY.`);
    return { installed: destination, changed: false };
  }
  try { await file.writeFile(source); await file.sync(); }
  finally { await file.close(); }
  return { installed: destination, changed: true };
}

export async function guide(name) {
  if (!["rental", "harnesses", "reth"].includes(name)) throw new Error("Choose guide rental, harnesses, or reth.");
  return readFile(new URL(`../docs/${name}.md`, import.meta.url), "utf8");
}
