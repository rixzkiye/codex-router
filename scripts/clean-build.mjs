import { readFile, rm } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = process.cwd();
const manifest = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
if (manifest.name !== "@rixzkiye/codex-router") {
  throw new Error("Refusing to clean build output outside the Codex Router package root");
}

await rm(path.join(repositoryRoot, "dist"), { recursive: true, force: true });
