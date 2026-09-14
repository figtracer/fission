import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const platform = `${process.platform}-${process.arch}`;
if (!["darwin-arm64", "darwin-x64", "linux-x64"].includes(platform))
  throw new Error(`No release target for ${platform}.`);
const output = resolve(process.argv[2] || join(root, "dist"));
const staging = await mkdtemp(join(tmpdir(), "fission-package-"));
try {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  delete manifest.scripts;
  manifest.os = [process.platform];
  manifest.cpu = [process.arch];
  await writeFile(join(staging, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  for (const path of ["src", "recipes", "harness", "skills", "docs", "README.md", "AGENTS.md", "llms.txt"])
    await cp(join(root, path), join(staging, path), { recursive: true });
  const binary = "tui/target/release/fission-tui";
  await mkdir(join(staging, "tui/target/release"), { recursive: true });
  await cp(join(root, binary), join(staging, binary));
  const [packed] = JSON.parse(execFileSync("npm", ["pack", "--offline", "--ignore-scripts", "--json"], { cwd: staging, encoding: "utf8" }));
  if (!packed.files.some(file => file.path === binary)) throw new Error("Package is missing its compiled TUI.");
  await mkdir(output, { recursive: true });
  const name = `fission-${manifest.version}-${platform}.tgz`;
  const archive = await readFile(join(staging, packed.filename));
  // Exclusive writes preserve existing release artifacts.
  await writeFile(join(output, name), archive, { flag: "wx" });
  await writeFile(join(output, `${name}.sha256`), `${createHash("sha256").update(archive).digest("hex")}  ${name}\n`, { flag: "wx" });
  console.log(join(output, name));
} finally {
  await rm(staging, { recursive: true, force: true });
}
