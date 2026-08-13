import { createHash, randomUUID } from "node:crypto";

const SECRET_KEY = /(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|bearer[_-]?token|password|secret|credential|auth\.json|codexhome)/i;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const API_TOKEN = /\b(?:sk|sess|key)-[A-Za-z0-9_-]{12,}\b/g;

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortValue(record[key])])
    );
  }
  return value;
}

export function requestHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export class SecretRedactor {
  readonly #knownSecrets = new Set<string>();

  addSecret(secret: string | undefined): void {
    if (secret && secret.length >= 4) this.#knownSecrets.add(secret);
  }

  redact<T>(value: T): T {
    return redactValue(value, this.#knownSecrets) as T;
  }
}

function redactValue(value: unknown, knownSecrets: ReadonlySet<string>): unknown {
  if (typeof value === "string") {
    let redacted = value.replace(BEARER, "Bearer [REDACTED]").replace(API_TOKEN, "[REDACTED]");
    for (const secret of knownSecrets) redacted = redacted.split(secret).join("[REDACTED]");
    return redacted;
  }
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, knownSecrets));
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SECRET_KEY.test(key) ? "[REDACTED]" : redactValue(entry, knownSecrets);
    }
    return result;
  }
  return value;
}

export interface Logger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export function createJsonLogger(redactor: SecretRedactor): Logger {
  const write = (level: string, fields: Record<string, unknown>, message: string) => {
    const output = redactor.redact({
      level,
      time: new Date().toISOString(),
      message,
      ...fields
    });
    process.stderr.write(`${JSON.stringify(output)}\n`);
  };
  return {
    info: (fields, message) => write("info", fields, message),
    warn: (fields, message) => write("warn", fields, message),
    error: (fields, message) => write("error", fields, message)
  };
}
