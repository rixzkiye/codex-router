import { createHash } from "node:crypto";
import type { InferenceConfig } from "../config.js";
import type { ModelDefinition, ProviderDefinition, ProviderProtocol } from "./types.js";

interface ProviderSeed {
  id: string;
  name: string;
  owner: string;
  baseUrl?: string;
  env?: string;
  keys?: string[];
  protocol?: ProviderProtocol;
  canonical?: string;
  auth?: "oauth" | "cli" | "keyless" | "native";
  profile?: string;
  discovery?: ProviderDefinition["discovery"];
  usage?: ProviderDefinition["usageAuthority"];
  planNote?: string;
}

const PROVIDER_SEEDS: ProviderSeed[] = [
  { id: "native-codex", name: "Codex / ChatGPT", owner: "openai", auth: "native", protocol: "responses", discovery: "native-catalog", usage: "native-account", profile: "native-codex" },
  { id: "anthropic-api", name: "Anthropic API", owner: "anthropic", baseUrl: "https://api.anthropic.com/v1", keys: ["ANTHROPIC_API_KEY"], protocol: "anthropic-messages", profile: "anthropic" },
  { id: "cerebras", name: "Cerebras", owner: "cerebras", baseUrl: "https://api.cerebras.ai/v1", keys: ["CEREBRAS_API_KEY"] },
  { id: "chutes", name: "Chutes", owner: "chutes", baseUrl: "https://llm.chutes.ai/v1", keys: ["CHUTES_API_KEY"] },
  { id: "clinepass", name: "ClinePass", owner: "cline", baseUrl: "https://api.cline.bot/api/v1", keys: ["CLINE_API_KEY"] },
  { id: "commandcode", name: "Command Code", owner: "commandcode", baseUrl: "https://api.commandcode.ai/provider/v1", keys: ["COMMAND_CODE_API_KEY", "COMMANDCODE_API_KEY"], auth: "cli", profile: "command-code" },
  { id: "commandcode-messages", name: "Command Code Messages", owner: "commandcode", baseUrl: "https://api.commandcode.ai/provider/v1", keys: ["COMMAND_CODE_API_KEY", "COMMANDCODE_API_KEY"], canonical: "commandcode", protocol: "anthropic-messages", auth: "cli", profile: "command-code" },
  { id: "deepseek", name: "DeepSeek API", owner: "deepseek", baseUrl: "https://api.deepseek.com", keys: ["DEEPSEEK_API_KEY"], profile: "deepseek" },
  { id: "fireworks", name: "Fireworks AI", owner: "fireworks", baseUrl: "https://api.fireworks.ai/inference/v1", keys: ["FIREWORKS_API_KEY"] },
  { id: "gemini-api", name: "Google Gemini API", owner: "google", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"], profile: "gemini" },
  { id: "github-copilot", name: "GitHub Copilot", owner: "github", baseUrl: "https://api.individual.githubcopilot.com", keys: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"], protocol: "responses", auth: "cli", profile: "github-copilot", planNote: "Authentication does not prove Copilot API entitlement." },
  { id: "grok-api", name: "xAI Grok API", owner: "xai", baseUrl: "https://api.x.ai/v1", keys: ["XAI_API_KEY", "GROK_API_KEY"], profile: "grok" },
  { id: "grok-oauth", name: "xAI Grok OAuth", owner: "xai", env: "GROK_OAUTH_FORWARD_BASE_URL", auth: "oauth", profile: "grok" },
  { id: "groq", name: "Groq", owner: "groq", baseUrl: "https://api.groq.com/openai/v1", keys: ["GROQ_API_KEY"] },
  { id: "huggingface", name: "Hugging Face Router", owner: "huggingface", baseUrl: "https://router.huggingface.co/v1", keys: ["HF_TOKEN", "HUGGINGFACE_API_KEY"] },
  { id: "kimi-api", name: "Kimi Platform API", owner: "moonshot", baseUrl: "https://api.moonshot.ai/v1", keys: ["KIMI_API_KEY", "MOONSHOT_API_KEY"], profile: "kimi" },
  { id: "kimi-oauth", name: "Kimi Code OAuth", owner: "moonshot", env: "KIMI_OAUTH_FORWARD_BASE_URL", auth: "oauth", profile: "kimi" },
  { id: "local", name: "Local Ollama", owner: "local", baseUrl: "http://127.0.0.1:11434/v1", auth: "keyless", discovery: "local-runtime", profile: "ollama" },
  { id: "meta", name: "Meta Model API", owner: "meta", baseUrl: "https://api.meta.ai/v1", keys: ["META_API_KEY"], protocol: "responses", profile: "meta" },
  { id: "minimax-token-plan", name: "MiniMax Token Plan", owner: "minimax", baseUrl: "https://api.minimax.io/v1", keys: ["MINIMAX_API_KEY", "MINIMAX_TOKEN_PLAN_API_KEY"], profile: "minimax" },
  { id: "mistral", name: "Mistral AI", owner: "mistral", baseUrl: "https://api.mistral.ai/v1", keys: ["MISTRAL_API_KEY"] },
  { id: "nvidia-nim", name: "NVIDIA NIM", owner: "nvidia", baseUrl: "https://integrate.api.nvidia.com/v1", keys: ["NVIDIA_API_KEY", "NVIDIA_NIM_API_KEY"] },
  { id: "ollama-cloud", name: "Ollama Cloud", owner: "ollama", baseUrl: "https://ollama.com/v1", keys: ["OLLAMA_API_KEY", "OLLAMA_CLOUD_API_KEY"], profile: "ollama" },
  { id: "opencode-go", name: "opencode Go", owner: "opencode", baseUrl: "https://opencode.ai/zen/go/v1", keys: ["OPENCODE_API_KEY", "OPENCODE_GO_API_KEY"], profile: "opencode" },
  { id: "opencode-go-messages", name: "opencode Messages", owner: "opencode", baseUrl: "https://opencode.ai/zen/go/v1", keys: ["OPENCODE_API_KEY", "OPENCODE_GO_API_KEY"], canonical: "opencode-go", protocol: "anthropic-messages", profile: "opencode" },
  { id: "opencode-go-responses", name: "opencode Responses", owner: "opencode", baseUrl: "https://opencode.ai/zen/go/v1", keys: ["OPENCODE_API_KEY", "OPENCODE_GO_API_KEY"], canonical: "opencode-go", protocol: "responses", profile: "opencode" },
  { id: "opencode-zen", name: "opencode Zen", owner: "opencode", baseUrl: "https://opencode.ai/zen/v1", keys: ["OPENCODE_API_KEY", "OPENCODE_GO_API_KEY"], canonical: "opencode-go", profile: "opencode" },
  { id: "openrouter", name: "OpenRouter", owner: "openrouter", baseUrl: "https://openrouter.ai/api/v1", keys: ["OPENROUTER_API_KEY"] },
  { id: "qwen-plan", name: "Qwen / DashScope Plan", owner: "alibaba", baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", keys: ["QWEN_PLAN_API_KEY", "DASHSCOPE_API_KEY"], profile: "qwen" },
  { id: "siliconflow", name: "SiliconFlow", owner: "siliconflow", baseUrl: "https://api.siliconflow.cn/v1", keys: ["SILICONFLOW_API_KEY"] },
  { id: "together", name: "Together AI", owner: "together", baseUrl: "https://api.together.xyz/v1", keys: ["TOGETHER_API_KEY"] },
  { id: "zai-coding", name: "Z.ai GLM Coding Plan", owner: "zai", baseUrl: "https://api.z.ai/api/coding/paas/v4", keys: ["ZAI_API_KEY", "ZAI_CODING_API_KEY"], profile: "glm" }
];

export function builtinProviders(): ProviderDefinition[] {
  return PROVIDER_SEEDS.map((seed) => {
    const auth = seed.auth ?? "environment";
    const canonical = seed.canonical ?? seed.id;
    return {
      id: seed.id,
      displayName: seed.name,
      owner: seed.owner,
      canonicalProvider: canonical,
      kind: auth === "native" ? "native" : auth === "oauth" ? "oauth-forwarder" : auth === "cli" ? "cli-session" : auth === "keyless" ? "keyless-local" : "openai-compatible",
      protocol: seed.protocol ?? "chat-completions",
      baseUrl: seed.baseUrl ?? null,
      ...(seed.env ? { baseUrlEnvironment: seed.env } : {}),
      credential: {
        mechanism: auth === "native" ? "native-session" : auth === "oauth" ? "oauth-cli" : auth === "cli" ? "cli-session" : auth === "keyless" ? "keyless" : "environment",
        references: (seed.keys ?? []).map((key) => `env:${key}`),
        ...(canonical !== seed.id ? { sharedWith: canonical } : {}),
        interactiveTerminal: auth === "native" || auth === "oauth" || auth === "cli"
      },
      requestProfile: seed.profile ?? "generic-openai",
      discovery: seed.discovery ?? (auth === "oauth" ? "provider-api" : "provider-api"),
      usageAuthority: seed.usage ?? "rate-limit-headers",
      ...(seed.planNote ? { planNote: seed.planNote } : {}),
      localOnly: auth === "keyless",
      publication: seed.id === "native-codex" ? "generally-available" : seed.id === "local" ? "experimental" : "catalog-only"
    };
  });
}

export function configuredModels(config: InferenceConfig | undefined): ModelDefinition[] {
  if (!config) return [];
  return config.models.map((model) => {
    const provider = config.providers.find((entry) => entry.id === model.providerId);
    const profile = provider?.requestProfile ?? "generic-openai";
    const capabilities = model.capabilities;
    const compatibilityHash = createHash("sha256")
      .update(JSON.stringify({ model, profile, capabilities }))
      .digest("hex");
    return {
      publicSlug: model.id,
      gatewayId: model.id,
      upstreamId: model.upstreamModel,
      providerVariant: model.providerId,
      displayName: model.displayName ?? model.id,
      contextWindow: model.contextWindow ?? null,
      maxOutputTokens: model.maxOutputTokens ?? null,
      provenance: "checked-in",
      publication: model.publication,
      requestProfile: profile,
      compatibilityHash,
      capabilities,
      pricing: model.pricing
    };
  });
}

export function registryHash(providers: ProviderDefinition[], models: ModelDefinition[]): string {
  return createHash("sha256").update(JSON.stringify({ providers, models })).digest("hex");
}
