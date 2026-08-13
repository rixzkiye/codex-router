import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = process.cwd();
const temporary = await mkdtemp(path.join(os.tmpdir(), "codex-router-package-"));

try {
  const dryRun = await run("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], { cwd: root, maxBuffer: 10 * 1024 * 1024 });
  const dryRunMetadata = JSON.parse(dryRun.stdout)[0];
  const files = new Set(dryRunMetadata.files.map((entry) => entry.path));
  for (const required of ["dist/index.js", "dist/console/index.html", "package.json", "README.md"]) {
    if (!files.has(required)) throw new Error(`Packed npm file list is missing ${required}`);
  }

  const packed = await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary], { cwd: root, maxBuffer: 10 * 1024 * 1024 });
  const metadata = JSON.parse(packed.stdout)[0];
  const tarball = path.join(temporary, metadata.filename);
  await access(tarball);
  const listing = await run("tar", ["-tvzf", tarball], { maxBuffer: 10 * 1024 * 1024 });
  const binLine = listing.stdout.split("\n").find((line) => line.endsWith(" package/dist/index.js"));
  if (!binLine?.startsWith("-rwx")) throw new Error("Packed dist/index.js is not executable");

  const prefix = path.join(temporary, "install");
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", prefix, tarball], { maxBuffer: 20 * 1024 * 1024 });
  const executable = path.join(prefix, "node_modules", ".bin", process.platform === "win32" ? "codex-router.cmd" : "codex-router");
  const before = await stat(executable);
  if (process.platform !== "win32" && (before.mode & 0o111) === 0) throw new Error("Installed codex-router bin is not executable");
  const help = await run(executable, ["--help"], {
    env: {
      ...process.env,
      XDG_CONFIG_HOME: path.join(temporary, "xdg-config"),
      XDG_STATE_HOME: path.join(temporary, "xdg-state")
    },
    maxBuffer: 10 * 1024 * 1024
  });
  if (!help.stdout.includes("codex-router mcp")) throw new Error("Installed codex-router bin did not produce CLI help");
  await access(path.join(temporary, "xdg-config", "codex-router", "config.json")).then(
    () => { throw new Error("Viewing CLI help unexpectedly created managed configuration"); },
    (error) => { if (error.code !== "ENOENT") throw error; }
  );

  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (manifest.private) throw new Error("The npm package is still private");
  if (manifest.publishConfig?.access !== "public") throw new Error("Scoped npm package must publish with public access");
  process.stdout.write(`Verified ${metadata.filename}: dry-run contents, executable mode, installed bin, and mutation-free help.\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
