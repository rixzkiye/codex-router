import { createHash, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { InferenceConfig, InferenceModelConfig, InferenceProviderConfig } from "../config.js";
import { resolveSecretReference } from "../config.js";
import { RouterError } from "../errors.js";
import { newId, type Logger, type SecretRedactor } from "../security.js";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

const RESPONSE_HEADERS = ["content-type", "retry-after", "x-request-id"] as const;

export interface InferenceGatewayOptions {
  host?: string;
  port?: number;
}

export interface InferenceGateway {
  readonly url: string;
  close(): Promise<void>;
}

interface RoutedRequest {
  body: Buffer;
  model: InferenceModelConfig;
  provider: InferenceProviderConfig;
}

export async function startInferenceGateway(
  config: InferenceConfig,
  redactor: SecretRedactor,
  logger: Logger,
  options: InferenceGatewayOptions = {}
): Promise<InferenceGateway> {
  const host = options.host ?? config.host;
  if (!isLoopback(host)) {
    throw new RouterError("unauthorized", "The inference gateway binds to loopback only");
  }

  const callerToken = resolveSecretReference(config.callerTokenRef);
  if (Buffer.byteLength(callerToken, "utf8") < 32) {
    throw new RouterError("unauthorized", "The inference caller token must contain at least 32 bytes");
  }
  redactor.addSecret(callerToken);
  const providers = new Map(config.providers.map((provider) => [provider.id, provider]));
  const models = new Map(config.models.map((model) => [model.id, model]));
  const activeRequests = new Set<AbortController>();
  let origin = "";
  let closePromise: Promise<void> | undefined;

  const server = createServer((request, response) => {
    const requestId = newId("inference");
    response.setHeader("X-Codex-Router-Request-Id", requestId);
    void handleRequest(request, response, requestId).catch((error: unknown) => {
      const normalized = normalizeError(error);
      logger.warn(
        redactor.redact({ request_id: requestId, code: normalized.code, error: normalized.message }),
        "Inference gateway request failed"
      );
      if (!response.headersSent) {
        sendError(response, normalized.status, normalized.code, normalized.message, requestId);
      } else if (!response.writableEnded) {
        response.end();
      }
    });
  });

  async function handleRequest(request: IncomingMessage, response: ServerResponse, requestId: string): Promise<void> {
    const url = new URL(request.url ?? "/", origin || "http://127.0.0.1");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");

    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, {
        status: "ok",
        providers: config.providers.length,
        models: config.models.length
      });
      return;
    }

    rejectBrowserRequest(request);
    requireCallerAuth(request, callerToken);

    if (request.method === "GET" && ["/models", "/v1/models"].includes(url.pathname)) {
      sendJson(response, 200, {
        object: "list",
        data: config.models.map((model) => ({
          id: model.id,
          object: "model",
          created: 0,
          owned_by: model.providerId
        }))
      });
      return;
    }

    const upstreamRoute = responseRoute(url.pathname);
    if (request.method !== "POST" || !upstreamRoute) {
      throw new GatewayError(404, "not_found", "Inference route not found");
    }

    const startedAt = Date.now();
    const routed = await routeRequest(request, config.maxBodyBytes, models, providers);
    const controller = new AbortController();
    activeRequests.add(controller);
    const timeout = setTimeout(
      () => controller.abort(new GatewayError(504, "upstream_timeout", "Inference provider request timed out")),
      config.requestTimeoutMs
    );
    timeout.unref();
    const abortOnDisconnect = () => {
      if (!response.writableFinished) {
        controller.abort(new GatewayError(499, "caller_disconnected", "Inference caller disconnected"));
      }
    };
    response.once("close", abortOnDisconnect);

    let status = 502;
    try {
      const upstream = await fetch(responseUrl(routed.provider.baseUrl, upstreamRoute), {
        method: "POST",
        headers: upstreamHeaders(request.headers, routed, redactor),
        body: routed.body,
        redirect: "manual",
        signal: controller.signal
      });
      status = upstream.status;
      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel().catch(() => undefined);
        throw new GatewayError(502, "upstream_redirect", "Inference provider returned an unexpected redirect");
      }
      if (!upstream.ok) {
        const detail = redactor.redact((await upstream.text()).slice(0, 16 * 1024));
        logger.warn(
          { request_id: requestId, provider: routed.provider.id, status: upstream.status, detail },
          "Inference provider rejected request"
        );
        sendError(
          response,
          upstream.status,
          "provider_error",
          `Inference provider ${routed.provider.id} returned status ${upstream.status}`,
          requestId
        );
        return;
      }

      copyResponseHeaders(upstream.headers, response);
      response.writeHead(upstream.status);
      if (!upstream.body) {
        response.end();
        return;
      }
      await pipeline(Readable.fromWeb(upstream.body), response);
    } catch (error) {
      const abortReason = controller.signal.reason;
      if (abortReason instanceof GatewayError) {
        status = abortReason.code === "caller_disconnected" ? 0 : abortReason.status;
        if (abortReason.code === "caller_disconnected") return;
        throw abortReason;
      }
      if (error instanceof GatewayError) status = error.status;
      if (response.headersSent && !response.writableFinished) status = 502;
      throw error;
    } finally {
      clearTimeout(timeout);
      activeRequests.delete(controller);
      response.off("close", abortOnDisconnect);
      logger.info(
        {
          request_id: requestId,
          model: routed.model.id,
          provider: routed.provider.id,
          status,
          duration_ms: Date.now() - startedAt
        },
        "Inference request completed"
      );
    }
  }

  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;
  server.requestTimeout = 0;
  server.listen(options.port ?? config.port, host);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Inference gateway did not expose a TCP address");
  origin = `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`;
  return {
    url: origin,
    close: async () => {
      closePromise ??= (async () => {
        for (const controller of activeRequests) {
          controller.abort(new GatewayError(503, "server_shutdown", "Inference gateway is shutting down"));
        }
        const closed = once(server, "close");
        server.close();
        server.closeAllConnections();
        await closed;
      })();
      await closePromise;
    }
  };
}

async function routeRequest(
  request: IncomingMessage,
  maxBodyBytes: number,
  models: ReadonlyMap<string, InferenceModelConfig>,
  providers: ReadonlyMap<string, InferenceProviderConfig>
): Promise<RoutedRequest> {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new GatewayError(415, "unsupported_media_type", "Inference requests require application/json");
  }
  const body = await readBody(request, maxBodyBytes);
  let payload: unknown;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    throw new GatewayError(400, "invalid_json", "Inference request body is not valid JSON");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new GatewayError(400, "invalid_request", "Inference request JSON must be an object");
  }
  const record = payload as Record<string, unknown>;
  const requestedModel = typeof record.model === "string" ? record.model : "";
  const model = models.get(requestedModel);
  if (!model) {
    throw new GatewayError(400, "unknown_model", `Unknown inference model: ${requestedModel || "missing"}`);
  }
  const provider = providers.get(model.providerId);
  if (!provider) throw new GatewayError(500, "invalid_registry", `Model ${model.id} has no provider`);
  record.model = model.upstreamModel;
  delete record.client_metadata;
  return { body: Buffer.from(JSON.stringify(record), "utf8"), model, provider };
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new GatewayError(413, "body_too_large", `Inference request exceeds ${maxBytes} bytes`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new GatewayError(413, "body_too_large", `Inference request exceeds ${maxBytes} bytes`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function upstreamHeaders(
  incoming: IncomingHttpHeaders,
  routed: RoutedRequest,
  redactor: SecretRedactor
): Headers {
  const headers = new Headers({
    Accept: typeof incoming.accept === "string" ? incoming.accept : "text/event-stream",
    "Content-Type": "application/json",
    "User-Agent": "codex-router/0.1"
  });
  if (!routed.provider.keyless) {
    const credential = resolveSecretReference(routed.provider.credentialRef!);
    redactor.addSecret(credential);
    headers.set("Authorization", `Bearer ${credential}`);
  }
  return headers;
}

function responseRoute(pathname: string): "responses" | "responses/compact" | null {
  if (["/responses", "/v1/responses"].includes(pathname)) return "responses";
  if (["/responses/compact", "/v1/responses/compact"].includes(pathname)) return "responses/compact";
  return null;
}

function responseUrl(baseUrl: string, route: "responses" | "responses/compact"): URL {
  return new URL(route, `${baseUrl.replace(/\/+$/, "")}/`);
}

function copyResponseHeaders(source: Headers, target: ServerResponse): void {
  for (const name of RESPONSE_HEADERS) {
    const value = source.get(name);
    if (value && !HOP_BY_HOP_HEADERS.has(name)) target.setHeader(name, value);
  }
}

function rejectBrowserRequest(request: IncomingMessage): void {
  if (request.headers.origin || request.headers["sec-fetch-site"]) {
    throw new GatewayError(403, "browser_request_rejected", "Browser-originated inference requests are not allowed");
  }
}

function requireCallerAuth(request: IncomingMessage, expectedToken: string): void {
  const header = request.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!secretEqual(token, expectedToken)) {
    throw new GatewayError(401, "unauthorized", "Inference caller authentication failed");
  }
}

function secretEqual(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.writableEnded) return;
  const body = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.length)
  });
  response.end(body);
}

function sendError(response: ServerResponse, status: number, code: string, message: string, requestId: string): void {
  sendJson(response, status, {
    error: { type: "router_error", code, message, request_id: requestId }
  });
}

function normalizeError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof GatewayError) return error;
  if (error instanceof RouterError) return { status: 500, code: error.code, message: error.message };
  if (error instanceof Error && error.name === "AbortError") {
    return { status: 504, code: "upstream_timeout", message: "Inference provider request was cancelled" };
  }
  return {
    status: 502,
    code: "upstream_unavailable",
    message: "Inference provider request failed before a response was available"
  };
}

class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
