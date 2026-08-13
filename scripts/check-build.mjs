import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

const requiredArtifacts = [
  "dist/index.js",
  "dist/inference/server.js",
  "dist/web/server.js",
  "dist/console/index.html"
];

for (const artifact of requiredArtifacts) {
  try {
    await access(path.resolve(artifact));
  } catch {
    throw new Error(`Required build artifact is missing: ${artifact}`);
  }
}

if (process.platform !== "win32") await access(path.resolve("dist/index.js"), constants.X_OK);
