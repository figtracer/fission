import { readFile, mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

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

// Source-backed routing, inspired by Bugraph. The small index points into the
// canonical guides; it does not duplicate their content or run an agent.
export async function guidance(query = "", options = {}) {
  const bytes = await readFile(new URL("../docs/taxonomy.json", import.meta.url));
  const corpus = JSON.parse(bytes);
  if (corpus.schemaVersion !== 1 || !corpus.revision || !Array.isArray(corpus.entries)) throw new Error("Invalid guidance index");
  const ids = new Set(), postings = new Map();
  const tokens = (text) => new Set(text.toLowerCase().match(/[a-z0-9]+/g) || []);
  for (const entry of corpus.entries) {
    const source = corpus.sources[entry.chain === "base" ? "base-reth" : entry.harness];
    if (!source || !/^[a-f0-9]{40}$/.test(source.revision) || !source.repository.startsWith("https://github.com/") || ids.has(entry.id) || !entry.id.startsWith(entry.harness + "/") ||
        entry.chain !== undefined && entry.chain !== "base" || !Array.isArray(entry.modes) || !Array.isArray(entry.tags))
      throw new Error("Invalid guidance ID, source revision or facets");
    ids.add(entry.id);
    for (const word of tokens([entry.id, entry.summary, ...entry.tags].join(" "))) {
      if (!postings.has(word)) postings.set(word, new Set());
      postings.get(word).add(entry.id);
    }
  }
  const words = tokens(query);
  const requestedChain = options.harness === "reth" ? options.chain || "ethereum" : undefined;
  const entries = corpus.entries.filter((entry) => (!options.harness || entry.harness === options.harness) &&
    (!requestedChain || (entry.chain || "ethereum") === requestedChain) && (!options.mode || entry.modes.includes(options.mode)) &&
    [...words].every((word) => postings.get(word)?.has(entry.id)));
  const source = corpus.sources[options.harness === "reth" && requestedChain === "base" ? "base-reth" : options.harness];
  return { schemaVersion: corpus.schemaVersion, revision: corpus.revision,
    sha256: createHash("sha256").update(bytes).digest("hex"), sources: corpus.sources, entries,
    requestedRevision: options.ref || null,
    revisionMatch: options.ref ? Boolean(source && options.repo?.replace(/\.git$/, "") === source.repository && options.ref === source.revision) : null,
    note: "Pinned guidance, not proof of current upstream capabilities. A different revision requires source/help verification. Updates are explicit: review sources and guide links, update pins/entries, and increment the corpus revision." };
}

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
