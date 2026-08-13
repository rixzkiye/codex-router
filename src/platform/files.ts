import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { RouterError } from "../errors.js";
import { newId } from "../security.js";
import type { GeneratedPlatformArtifacts } from "./artifacts.js";

const OWNER = "codex-router-platform";

export async function installGeneratedArtifacts(root: string, artifacts: GeneratedPlatformArtifacts) {
  const target = path.resolve(root);
  const existing = await lstatOrNull(target);
  if (existing?.isSymbolicLink()) throw new RouterError("unauthorized", "Generated artifact root cannot be a symbolic link");
  if (existing && !existing.isDirectory()) throw new RouterError("invalid_request", "Generated artifact root must be a directory");
  await mkdir(target, { recursive: true, mode: 0o700 });

  const manifestPath = path.join(target, "manifest.json");
  const previousManifest = await readJson(manifestPath);
  if (previousManifest && previousManifest.owner !== OWNER) {
    throw new RouterError("conflict", "Generated artifact root belongs to another installation");
  }
  const managedFiles = ["litellm.yaml", "routes.json", "manifest.json"];
  if (!previousManifest) {
    const collisions = (await Promise.all(managedFiles.map(async (file) =>
      await lstatOrNull(path.join(target, file)).then((present) => present ? file : null)
    ))).filter((file): file is string => Boolean(file));
    if (collisions.length > 0) {
      throw new RouterError("conflict", `Generated artifact paths are not owned by Codex Router: ${collisions.join(", ")}`);
    }
  }

  const staging = path.join(target, `.stage-${newId("artifacts")}`);
  await mkdir(staging, { mode: 0o700 });
  const manifest = {
    owner: OWNER,
    checkout: process.cwd(),
    generated: artifacts.manifest,
    files: ["litellm.yaml", "routes.json"]
  };
  try {
    await Promise.all([
      writeFile(path.join(staging, "litellm.yaml"), artifacts.litellmConfig, { encoding: "utf8", mode: 0o600 }),
      writeFile(path.join(staging, "routes.json"), `${JSON.stringify(artifacts.routes, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }),
      writeFile(path.join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
    ]);
    await replaceOwnedFiles(target, staging, managedFiles);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  const readback = await readJson(manifestPath);
  if (readback?.generated?.registryHash !== artifacts.manifest.registryHash) {
    throw new RouterError("internal", "Generated artifact manifest failed authoritative readback");
  }
  return { root: target, manifest: readback };
}

async function replaceOwnedFiles(target: string, staging: string, files: string[]): Promise<void> {
  const backups: Array<{ destination: string; backup: string }> = [];
  const installed: string[] = [];
  try {
    for (const file of files) {
      const destination = path.join(target, file);
      const present = await lstatOrNull(destination);
      if (present?.isSymbolicLink()) throw new RouterError("unauthorized", `Managed artifact ${file} cannot be a symbolic link`);
      if (present) {
        const backup = path.join(target, `.backup-${newId("artifacts")}-${file}`);
        await rename(destination, backup);
        backups.push({ destination, backup });
      }
      await rename(path.join(staging, file), destination);
      installed.push(destination);
    }
    await Promise.all(backups.map(({ backup }) => rm(backup, { force: true })));
  } catch (error) {
    await Promise.all(installed.map((file) => rm(file, { force: true })));
    for (const { destination, backup } of backups.reverse()) {
      await rename(backup, destination).catch(() => undefined);
    }
    throw error;
  }
}

export async function writeSupportBundle(outputPath: string, snapshot: Record<string, unknown>) {
  const target = path.resolve(outputPath);
  const parent = path.dirname(target);
  const parentState = await lstatOrNull(parent);
  if (parentState?.isSymbolicLink()) throw new RouterError("unauthorized", "Support bundle parent cannot be a symbolic link");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const safe = sanitize(snapshot);
  await writeFile(target, `${JSON.stringify(safe, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return { path: target, included: Object.keys(safe), uploaded: false };
}

async function readJson(file: string): Promise<any | null> {
  try { return JSON.parse(await readFile(file, "utf8")); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new RouterError("invalid_request", `Unreadable generated manifest at ${file}`);
  }
}

async function lstatOrNull(file: string) {
  try {
    return await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function sanitize(snapshot: Record<string, unknown>) {
  const platform = snapshot.platform as Record<string, any> | undefined;
  return {
    createdAt: new Date().toISOString(),
    uploaded: false,
    router: snapshot.router,
    summary: snapshot.summary,
    platform: platform ? {
      registry: platform.registry,
      summary: platform.summary,
      diagnostics: platform.diagnostics,
      providers: Array.isArray(platform.providers) ? platform.providers.map((provider: any) => ({
        id: provider.id,
        enabled: provider.enabled,
        publication: provider.publication,
        authentication: { state: provider.authentication?.state, checkedAt: provider.authentication?.checkedAt },
        entitlement: { state: provider.entitlement?.state, checkedAt: provider.entitlement?.checkedAt },
        health: provider.health,
        catalog: provider.catalog
      })) : [],
      operations: Array.isArray(platform.operations) ? platform.operations.map((operation: any) => ({
        id: operation.id,
        kind: operation.kind,
        targetType: operation.targetType,
        targetId: operation.targetId,
        state: operation.state,
        message: operation.message,
        error: operation.error,
        createdAt: operation.createdAt,
        completedAt: operation.completedAt
      })) : []
    } : null
  };
}
