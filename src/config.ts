import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { capabilityTierSchema } from "./domain.js";
import { RouterError } from "./errors.js";

const secretReferenceSchema = z.string().regex(/^env:[A-Z][A-Z0-9_]*$/, {
  message: "Secret references must use env:VARIABLE_NAME"
});

const runtimeBase = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  capabilityTiers: z.array(capabilityTierSchema).min(1),
  allowedModels: z.array(z.string().min(1)).min(1),
  maxConcurrency: z.number().int().positive(),
  policyTags: z.array(z.string()).default([]),
  enabled: z.boolean().default(true)
});

export const codexRuntimeConfigSchema = runtimeBase.extend({
  adapter: z.literal("codex_app_server"),
  codexHomeRef: secretReferenceSchema,
  command: z.string().min(1).default("codex"),
  args: z.array(z.string()).default(["app-server"]),
  protocolVersion: z.string().min(1),
  defaultModel: z.string().optional(),
  approvalPolicy: z.enum(["untrusted", "on-request", "never"]).default("on-request"),
  networkAccess: z.boolean().default(false)
});

export const externalRuntimeConfigSchema = runtimeBase.extend({
  adapter: z.literal("external_provider"),
  credentialRef: secretReferenceSchema.optional(),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  capabilities: z.object({
    steer: z.boolean().default(false),
    interrupt: z.boolean().default(true),
    resume: z.boolean().default(true),
    approvals: z.boolean().default(false)
  })
});

export const routerConfigSchema = z.object({
  databasePath: z.string().min(1),
  allowedWorktreeRoots: z.array(z.string().min(1)).min(1),
  maxWaitMs: z.number().int().positive().max(300_000).default(30_000),
  leaseTtlMs: z.number().int().positive().default(120_000),
  idempotencyTtlMs: z.number().int().positive().default(7 * 24 * 60 * 60 * 1000),
  runtimes: z.array(z.discriminatedUnion("adapter", [codexRuntimeConfigSchema, externalRuntimeConfigSchema]))
});

export type CodexRuntimeConfig = z.infer<typeof codexRuntimeConfigSchema>;
export type ExternalRuntimeConfig = z.infer<typeof externalRuntimeConfigSchema>;
export type RuntimeConfig = CodexRuntimeConfig | ExternalRuntimeConfig;
export type RouterConfig = z.infer<typeof routerConfigSchema>;

export async function loadConfig(configPath: string): Promise<RouterConfig> {
  const absoluteConfigPath = path.resolve(configPath);
  const raw = await readFile(absoluteConfigPath, "utf8");
  const parsed = routerConfigSchema.parse(JSON.parse(raw));
  const base = path.dirname(absoluteConfigPath);
  return {
    ...parsed,
    databasePath: path.resolve(base, parsed.databasePath),
    allowedWorktreeRoots: parsed.allowedWorktreeRoots.map((root) => path.resolve(base, root))
  };
}
export function resolveSecretReference(reference: string): string {
  const variable = reference.slice("env:".length);
  const value = process.env[variable];
  if (!value) {
    throw new RouterError(
      "runtime_unavailable",
      `Required runtime environment variable ${variable} is not set`
    );
  }
  return value;
}
