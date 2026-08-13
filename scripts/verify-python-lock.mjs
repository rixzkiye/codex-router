import { readFile } from "node:fs/promises";

const direct = await readFile(new URL("../requirements/litellm.in", import.meta.url), "utf8");
const lock = await readFile(new URL("../requirements/litellm.txt", import.meta.url), "utf8");
const required = [...direct.matchAll(/^([a-zA-Z0-9_.-]+)(?:\[[^\]]+\])?==([^\s#]+)/gm)];
if (required.length === 0) throw new Error("No pinned direct Python requirements were found");
for (const [, name, version] of required) {
  const normalized = name.toLowerCase().replaceAll("_", "-");
  const pattern = new RegExp(`^${normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}==${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\\\`, "mi");
  if (!pattern.test(lock)) throw new Error(`Python lock is missing ${name}==${version}`);
}
if (!lock.includes("--hash=sha256:")) throw new Error("Python lock has no hashes");
if (!lock.includes("litellm==")) throw new Error("Python lock does not contain the LiteLLM closure");
process.stdout.write(`Verified ${required.length} direct pins and the hash-locked LiteLLM dependency closure.\n`);
