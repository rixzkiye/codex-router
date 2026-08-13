import { randomBytes } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { once } from "node:events";
import { ZodError } from "zod";
import {
  agentCancelRequestSchema,
  agentContinueRequestSchema,
  agentHandoffRequestSchema,
  agentRespondRequestSchema,
  agentStartRequestSchema,
  agentSteerRequestSchema
} from "../domain.js";
import { asRouterError, RouterError } from "../errors.js";
import type { RouterApplicationService } from "../application.js";
import { newId, type Logger, type SecretRedactor } from "../security.js";

const MAX_BODY_BYTES = 256 * 1024;
const SESSION_COOKIE = "codex_router_session";
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()"
};

export interface WebGatewayOptions {
  host?: string;
  port?: number;
  assetRoot: string;
  bootstrapToken?: string;
  sessionIdleMs?: number;
  sessionAbsoluteMs?: number;
}

export interface WebGateway {
  readonly url: string;
  readonly bootstrapUrl: string;
  readonly bootstrapToken: string;
  close(): Promise<void>;
}

interface WebSession {
  id: string;
  csrfToken: string;
  role: "administrator";
  createdAt: number;
  lastSeenAt: number;
}

export async function startWebGateway(
  application: RouterApplicationService,
  redactor: SecretRedactor,
  logger: Logger,
  options: WebGatewayOptions
): Promise<WebGateway> {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopback(host)) {
    throw new RouterError(
      "unauthorized",
      "The built-in Web Console binds to loopback only. Put an authenticated TLS reverse proxy in front of a separately configured remote gateway."
    );
  }
  const assetRoot = path.resolve(options.assetRoot);
  const indexPath = path.join(assetRoot, "index.html");
  if (!existsSync(indexPath)) {
    throw new RouterError("not_found", `Web Console assets were not found at ${assetRoot}. Run pnpm build:web first.`);
  }

  const oneTimeToken = options.bootstrapToken ?? randomBytes(32).toString("base64url");
  let bootstrapAvailable = true;
  const sessions = new Map<string, WebSession>();
  const idleMs = options.sessionIdleMs ?? 60 * 60 * 1000;
  const absoluteMs = options.sessionAbsoluteMs ?? 12 * 60 * 60 * 1000;
  let origin = "";

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
      const operationId = newId("op");
      const normalized = asWebError(error);
      logger.warn(
        redactor.redact({ operation_id: operationId, code: normalized.code, error: normalized.message }),
        "Web Console request failed"
      );
      if (!response.headersSent) {
        sendError(response, normalized, operationId);
      } else if (!response.writableEnded) {
        response.end();
      }
    });
  });

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    setSecurityHeaders(response);
    const url = new URL(request.url ?? "/", origin || "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) response.setHeader("Cache-Control", "no-store");

    if (request.method === "POST" && url.pathname === "/api/v1/session") {
      assertOrigin(request, origin);
      const body = await readJson(request);
      if (!bootstrapAvailable || body.bootstrapToken !== oneTimeToken) {
        throw new RouterError("unauthorized", "Bootstrap token is invalid or has already been used");
      }
      bootstrapAvailable = false;
      const now = Date.now();
      const session: WebSession = {
        id: randomBytes(32).toString("base64url"),
        csrfToken: randomBytes(24).toString("base64url"),
        role: "administrator",
        createdAt: now,
        lastSeenAt: now
      };
      sessions.set(session.id, session);
      response.setHeader(
        "Set-Cookie",
        `${SESSION_COOKIE}=${session.id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(absoluteMs / 1000)}`
      );
      sendJson(response, 200, { csrfToken: session.csrfToken, role: session.role });
      return;
    }

    if (url.pathname.startsWith("/api/v1/")) {
      const session = requireSession(request, sessions, idleMs, absoluteMs);
      if (isMutation(request.method)) {
        assertOrigin(request, origin);
        if (request.headers["x-csrf-token"] !== session.csrfToken) {
          throw new RouterError("unauthorized", "CSRF token is missing or invalid");
        }
      }
      if (request.method === "DELETE" && url.pathname === "/api/v1/session") {
        sessions.delete(session.id);
        response.setHeader(
          "Set-Cookie",
          `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`
        );
        sendJson(response, 200, { signedOut: true });
        return;
      }
      await handleApi(application, request, response, url, session);
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      throw new RouterError("not_found", "Route not found");
    }
    await serveAsset(request, response, assetRoot, indexPath, url.pathname);
  }

  server.listen(options.port ?? 0, host);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Web gateway did not expose a TCP address");
  origin = `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`;
  return {
    url: origin,
    bootstrapUrl: `${origin}/#bootstrap=${oneTimeToken}`,
    bootstrapToken: oneTimeToken,
    close: async () => {
      sessions.clear();
      server.close();
      await once(server, "close");
    }
  };
}

async function handleApi(
  application: RouterApplicationService,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  session: WebSession
): Promise<void> {
  const method = request.method ?? "GET";
  const pathName = url.pathname;
  const callerScope = `web:${session.id}`;

  if (method === "GET" && pathName === "/api/v1/bootstrap") {
    sendJson(response, 200, { ...application.bootstrap(session.role), csrfToken: session.csrfToken });
    return;
  }
  if (method === "GET" && pathName === "/api/v1/stream") {
    await streamSnapshots(application, request, response, parseInteger(url.searchParams.get("afterVersion"), 0));
    return;
  }
  if (method === "GET" && pathName === "/api/v1/agents") {
    sendJson(response, 200, {
      agents: application.agents({
        ...(url.searchParams.get("status") ? { status: url.searchParams.get("status")! } : {}),
        ...(url.searchParams.get("projectKey") ? { projectKey: url.searchParams.get("projectKey")! } : {}),
        ...(url.searchParams.get("runtimeId") ? { runtimeId: url.searchParams.get("runtimeId")! } : {}),
        ...(url.searchParams.get("worktree") ? { worktree: url.searchParams.get("worktree")! } : {}),
        limit: parseInteger(url.searchParams.get("limit"), 100)
      }),
      registryVersion: application.router.registry.registryVersion
    });
    return;
  }
  if (method === "POST" && pathName === "/api/v1/agents") {
    const requestBody = agentStartRequestSchema.parse(await readJson(request));
    sendJson(response, 202, await application.start(callerScope, requestBody));
    return;
  }

  const agentMatch = pathName.match(/^\/api\/v1\/agents\/([^/]+)(?:\/(.*))?$/);
  if (agentMatch) {
    const agentId = decodeURIComponent(agentMatch[1]!);
    const child = agentMatch[2] ?? "";
    if (method === "GET" && child === "") {
      sendJson(response, 200, application.agent(agentId));
      return;
    }
    if (method === "GET" && child === "events") {
      sendJson(response, 200, { events: application.agentEvents(agentId, parseInteger(url.searchParams.get("limit"), 100)) });
      return;
    }
    if (method === "GET" && child === "results") {
      sendJson(response, 200, { results: application.results(agentId) });
      return;
    }
    const resultMatch = child.match(/^results\/(\d+)$/);
    if (method === "GET" && resultMatch) {
      sendJson(response, 200, application.result(agentId, Number(resultMatch[1]), "evidence"));
      return;
    }
    if (method === "GET" && child === "evidence") {
      sendJson(response, 200, application.result(agentId, undefined, "evidence"));
      return;
    }
    if (method === "POST" && child === "steer") {
      const body = await readJson(request);
      sendJson(response, 202, await application.steer(callerScope, agentSteerRequestSchema.parse({ ...body, agentId })));
      return;
    }
    if (method === "POST" && child === "continue") {
      const body = await readJson(request);
      sendJson(response, 202, await application.continue(callerScope, agentContinueRequestSchema.parse({ ...body, agentId })));
      return;
    }
    if (method === "POST" && child === "cancel") {
      const body = await readJson(request);
      sendJson(response, 202, await application.cancel(callerScope, agentCancelRequestSchema.parse({ ...body, agentId })));
      return;
    }
    if (method === "POST" && child === "handoff") {
      const body = await readJson(request);
      sendJson(response, 202, await application.handoff(callerScope, agentHandoffRequestSchema.parse({ ...body, agentId })));
      return;
    }
  }

  if (method === "GET" && pathName === "/api/v1/interactions") {
    const rawState = url.searchParams.get("state");
    const state = rawState === "pending" || rawState === "resolved" || rawState === "expired" ? rawState : undefined;
    sendJson(response, 200, { interactions: application.interactions(state) });
    return;
  }
  const interactionMatch = pathName.match(/^\/api\/v1\/interactions\/([^/]+)\/respond$/);
  if (method === "POST" && interactionMatch) {
    const interactionId = decodeURIComponent(interactionMatch[1]!);
    const interaction = application.router.registry.getPendingInteraction(interactionId);
    const body = await readJson(request);
    sendJson(
      response,
      202,
      await application.respond(
        callerScope,
        agentRespondRequestSchema.parse({ ...body, agentId: interaction.agentId, interactionId })
      )
    );
    return;
  }
  if (method === "GET" && pathName === "/api/v1/runtimes") {
    sendJson(response, 200, { runtimes: application.runtimes() });
    return;
  }
  const runtimeMatch = pathName.match(/^\/api\/v1\/runtimes\/([^/]+)(?:\/(.*))?$/);
  if (runtimeMatch) {
    const runtimeId = decodeURIComponent(runtimeMatch[1]!);
    const child = runtimeMatch[2] ?? "";
    if (method === "GET" && child === "") {
      sendJson(response, 200, application.runtime(runtimeId));
      return;
    }
    if (method === "GET" && child === "models") {
      sendJson(response, 200, application.models(runtimeId)[0]);
      return;
    }
    if (method === "GET" && child === "auth") {
      sendJson(response, 200, application.runtime(runtimeId).authentication);
      return;
    }
    if (isMutation(method)) {
      throw new RouterError(
        "unsupported",
        "This runtime adapter does not expose the requested administrative operation. No local-only state was fabricated."
      );
    }
  }
  if (method === "GET" && pathName === "/api/v1/models") {
    sendJson(response, 200, { runtimes: application.models() });
    return;
  }
  if (method === "GET" && pathName === "/api/v1/worktrees") {
    sendJson(response, 200, { worktrees: application.worktrees() });
    return;
  }
  if (method === "GET" && pathName === "/api/v1/events") {
    sendJson(response, 200, {
      events: application.events({
        ...(url.searchParams.get("agentId") ? { agentId: url.searchParams.get("agentId")! } : {}),
        ...(url.searchParams.get("runtimeId") ? { runtimeId: url.searchParams.get("runtimeId")! } : {}),
        ...(url.searchParams.get("eventType") ? { eventType: url.searchParams.get("eventType")! } : {}),
        ...(url.searchParams.get("beforeSequence")
          ? { beforeSequence: parseInteger(url.searchParams.get("beforeSequence"), 0) }
          : {}),
        limit: parseInteger(url.searchParams.get("limit"), 100)
      })
    });
    return;
  }
  if (method === "GET" && pathName === "/api/v1/diagnostics") {
    sendJson(response, 200, application.diagnostics());
    return;
  }
  if (method === "GET" && pathName === "/api/v1/config") {
    sendJson(response, 200, application.config());
    return;
  }
  if (pathName.startsWith("/api/v1/config") && isMutation(method)) {
    throw new RouterError(
      "unsupported",
      "Atomic configuration writes are unavailable until a persistent configuration adapter is installed. Current configuration remains unchanged."
    );
  }
  throw new RouterError("not_found", "API route not found");
}

async function streamSnapshots(
  application: RouterApplicationService,
  request: IncomingMessage,
  response: ServerResponse,
  afterVersion: number
): Promise<void> {
  response.writeHead(200, {
    ...SECURITY_HEADERS,
    "Cache-Control": "no-store",
    "Content-Type": "text/event-stream; charset=utf-8",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  let version = afterVersion;
  let closed = false;
  request.once("close", () => {
    closed = true;
  });
  response.write(`retry: 1000\n\n`);
  while (!closed && !response.writableEnded) {
    const current = application.router.registry.registryVersion;
    if (current > version) {
      version = current;
      const writable = response.write(
        `id: ${version}\nevent: snapshot\ndata: ${JSON.stringify(application.bootstrap())}\n\n`
      );
      if (!writable) await once(response, "drain");
      continue;
    }
    const next = await application.waitForVersion(version, 20_000);
    if (closed) break;
    if (next === version) response.write(`: keepalive ${Date.now()}\n\n`);
  }
}

async function serveAsset(
  request: IncomingMessage,
  response: ServerResponse,
  assetRoot: string,
  indexPath: string,
  pathname: string
): Promise<void> {
  const decoded = decodeURIComponent(pathname);
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const candidate = path.resolve(assetRoot, relative);
  let filePath = candidate.startsWith(`${assetRoot}${path.sep}`) || candidate === assetRoot ? candidate : indexPath;
  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat?.isFile()) filePath = indexPath;
  const finalStat = await stat(filePath);
  response.statusCode = 200;
  response.setHeader("Content-Type", contentType(filePath));
  response.setHeader(
    "Cache-Control",
    filePath === indexPath ? "no-store" : /\.[a-f0-9]{8,}\./i.test(filePath) ? "public, max-age=31536000, immutable" : "public, max-age=3600"
  );
  response.setHeader("Content-Length", finalStat.size);
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(filePath).pipe(response);
}

function requireSession(
  request: IncomingMessage,
  sessions: Map<string, WebSession>,
  idleMs: number,
  absoluteMs: number
): WebSession {
  const id = parseCookies(request.headers.cookie ?? "")[SESSION_COOKIE];
  const session = id ? sessions.get(id) : undefined;
  const now = Date.now();
  if (!session || now - session.lastSeenAt > idleMs || now - session.createdAt > absoluteMs) {
    if (id) sessions.delete(id);
    throw new RouterError("unauthorized", "Web Console session is missing or expired");
  }
  session.lastSeenAt = now;
  return session;
}

function assertOrigin(request: IncomingMessage, expectedOrigin: string): void {
  const supplied = request.headers.origin;
  if (supplied !== expectedOrigin) throw new RouterError("unauthorized", "Request origin is not allowed");
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new RouterError("invalid_request", "Request body exceeds the allowed size");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RouterError("invalid_request", "Request body is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RouterError("invalid_request", "JSON request body must be an object");
  }
  return parsed as Record<string, unknown>;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}

function sendError(response: ServerResponse, error: RouterError, operationId: string): void {
  const status = errorStatus(error);
  sendJson(response, status, {
    error: {
      code: error.code,
      message: error.message,
      details: error.details,
      operationId,
      retryable: status === 429 || status === 503
    }
  });
}

function errorStatus(error: RouterError): number {
  if (error.code === "not_found") return 404;
  if (error.code === "unauthorized") return 403;
  if (error.code === "runtime_unavailable") return 503;
  if (error.code === "internal") return 500;
  if (error.code === "invalid_request" || error.code === "unsupported") return 422;
  if (["stale_incarnation", "stale_turn", "conflict", "idempotency_conflict", "invalid_transition"].includes(error.code)) {
    return 409;
  }
  return 422;
}

function asWebError(error: unknown): RouterError {
  if (error instanceof ZodError) {
    return new RouterError("invalid_request", "Request validation failed", {
      issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
    });
  }
  return asRouterError(error);
}

function setSecurityHeaders(response: ServerResponse): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
}

function parseCookies(value: string): Record<string, string> {
  return Object.fromEntries(
    value
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf("=");
        return separator < 0
          ? [decodeURIComponent(part), ""]
          : [decodeURIComponent(part.slice(0, separator)), decodeURIComponent(part.slice(separator + 1))];
      })
  );
}

function isMutation(method: string | undefined): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function parseInteger(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function contentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".js" || extension === ".mjs") return "text/javascript; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".woff2") return "font/woff2";
  if (extension === ".json") return "application/json; charset=utf-8";
  return "application/octet-stream";
}
