import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { capabilityTierSchema } from "./domain.js";
import { RouterError } from "./errors.js";

const secretReferenceSchema = z.string().regex(/^env:[A-Z][A-Z0-9_]*$/, {
  message: "Secret references must use env:VARIABLE_NAME"
});

const providerIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, {
  message: "Provider IDs must contain lowercase letters, numbers, and hyphens"
});

export const inferenceProviderConfigSchema = z
  .object({
    id: providerIdSchema,
    displayName: z.string().min(1).optional(),
    canonicalProviderId: providerIdSchema.optional(),
    baseUrl: z.url(),
    credentialRef: secretReferenceSchema.optional(),
    keyless: z.boolean().default(false),
    enabled: z.boolean().optional(),
    protocol: z.enum(["responses", "chat-completions", "anthropic-messages"]).optional(),
    requestProfile: z
      .enum([
        "generic-openai",
        "native-codex",
        "anthropic",
        "deepseek",
        "kimi",
        "qwen",
        "glm",
        "gemini",
        "minimax",
        "grok",
        "ollama",
        "github-copilot",
        "opencode",
        "command-code",
        "meta"
      ])
      .optional()
  })
  .superRefine((provider, context) => {
    const url = new URL(provider.baseUrl);
    const loopback = ["127.0.0.1", "::1", "localhost"].includes(url.hostname);
    if (url.username || url.password) {
      context.addIssue({
        code: "custom",
        path: ["baseUrl"],
        message: "Inference provider URLs cannot contain credentials"
      });
    }
    if (url.search || url.hash) {
      context.addIssue({
        code: "custom",
        path: ["baseUrl"],
        message: "Inference provider URLs cannot contain query strings or fragments"
      });
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      context.addIssue({
        code: "custom",
        path: ["baseUrl"],
        message: "Inference providers must use HTTPS unless they are loopback-local"
      });
    }
    if (provider.keyless && !loopback) {
      context.addIssue({
        code: "custom",
        path: ["keyless"],
        message: "Keyless inference providers must be loopback-local"
      });
    }
    if (provider.keyless && provider.credentialRef) {
      context.addIssue({
        code: "custom",
        path: ["credentialRef"],
        message: "Keyless inference providers cannot declare a credential reference"
      });
    }
    if (!provider.keyless && !provider.credentialRef) {
      context.addIssue({
        code: "custom",
        path: ["credentialRef"],
        message: "Authenticated inference providers require a credential reference"
      });
    }
  });

export const inferenceModelConfigSchema = z.object({
  id: z.string().min(1),
  providerId: providerIdSchema,
  upstreamModel: z.string().min(1),
  displayName: z.string().min(1).optional(),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional()
});

export const inferenceTranslationConfigSchema = z
  .object({
    baseUrl: z.url(),
    capabilityRef: secretReferenceSchema,
    healthPath: z.string().regex(/^\//).default("/health/liveliness"),
    requestTimeoutMs: z.number().int().positive().max(60_000).default(5_000)
  })
  .superRefine((translation, context) => {
    const url = new URL(translation.baseUrl);
    if (!["127.0.0.1", "::1", "localhost"].includes(url.hostname)) {
      context.addIssue({
        code: "custom",
        path: ["baseUrl"],
        message: "The LiteLLM translation core must be loopback-local"
      });
    }
    if (url.username || url.password || url.search || url.hash) {
      context.addIssue({
        code: "custom",
        path: ["baseUrl"],
        message: "The LiteLLM translation URL cannot contain credentials, query strings, or fragments"
      });
    }
  });

export const inferenceConfigSchema = z
  .object({
    callerTokenRef: secretReferenceSchema,
    host: z.enum(["127.0.0.1", "::1", "localhost"]).default("127.0.0.1"),
    port: z.number().int().min(0).max(65_535).default(4202),
    maxBodyBytes: z.number().int().positive().max(64 * 1024 * 1024).default(8 * 1024 * 1024),
    requestTimeoutMs: z.number().int().positive().max(60 * 60 * 1000).default(15 * 60 * 1000),
    preflightBytes: z.number().int().positive().max(1024 * 1024).default(64 * 1024),
    preflightTimeoutMs: z.number().int().positive().max(30_000).default(2_000),
    translation: inferenceTranslationConfigSchema.optional(),
    providers: z.array(inferenceProviderConfigSchema).min(1),
    models: z.array(inferenceModelConfigSchema).min(1)
  })
  .superRefine((inference, context) => {
    const providerIds = new Set<string>();
    for (const [index, provider] of inference.providers.entries()) {
      if (providerIds.has(provider.id)) {
        context.addIssue({
          code: "custom",
          path: ["providers", index, "id"],
          message: `Duplicate inference provider ID: ${provider.id}`
        });
      }
      providerIds.add(provider.id);
    }
    const modelIds = new Set<string>();
    for (const [index, model] of inference.models.entries()) {
      if (modelIds.has(model.id)) {
        context.addIssue({
          code: "custom",
          path: ["models", index, "id"],
          message: `Duplicate inference model ID: ${model.id}`
        });
      }
      modelIds.add(model.id);
      if (!providerIds.has(model.providerId)) {
        context.addIssue({
          code: "custom",
          path: ["models", index, "providerId"],
          message: `Unknown inference provider: ${model.providerId}`
        });
      }
    }
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
  inference: inferenceConfigSchema.optional(),
  runtimes: z.array(z.discriminatedUnion("adapter", [codexRuntimeConfigSchema, externalRuntimeConfigSchema]))
});

export type CodexRuntimeConfig = z.infer<typeof codexRuntimeConfigSchema>;
export type ExternalRuntimeConfig = z.infer<typeof externalRuntimeConfigSchema>;
export type RuntimeConfig = CodexRuntimeConfig | ExternalRuntimeConfig;
export type InferenceProviderConfig = z.infer<typeof inferenceProviderConfigSchema>;
export type InferenceModelConfig = z.infer<typeof inferenceModelConfigSchema>;
export type InferenceConfig = z.infer<typeof inferenceConfigSchema>;
export type InferenceTranslationConfig = z.infer<typeof inferenceTranslationConfigSchema>;
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
