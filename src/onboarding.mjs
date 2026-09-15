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

export const guideTopics = ["rental", "harnesses", "reth", "workloads"];

export async function guide(name) {
  const [topic, section, extra] = name?.split("/") || [];
  if (name !== undefined && (!guideTopics.includes(topic) || extra !== undefined || section === ""))
    throw new Error("Use fission help guides to choose a topic or topic/section.");
  const documents = await Promise.all((topic ? [topic] : guideTopics).map(async (key) => {
    const text = await readFile(new URL(`../docs/${key}.md`, import.meta.url), "utf8");
    if (topic && !section) return text;
    const headings = [...text.matchAll(/^## (.+)$/gm)];
    const sections = headings.map((heading, index) => ({
      id: heading[1].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      text: text.slice(heading.index, headings[index + 1]?.index),
    }));
    if (!topic) return `${key} — ${text.split("\n", 1)[0].replace(/^# /, "")}\n${sections.map(({ id }) => `  ${key}/${id}`).join("\n")}`;
    const selected = sections.find(({ id }) => id === section);
    if (!selected) throw new Error(`Unknown guide section: ${name}. Use fission help guides for the index.`);
    return `${text.split("\n", 1)[0]}\n\n${selected.text}`;
  }));
  return topic ? documents[0] : `Read a topic or complete section with fission help TOPIC[/SECTION].\n\n${documents.join("\n\n")}`;
}
