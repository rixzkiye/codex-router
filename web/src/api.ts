import type { ApiErrorBody, BootstrapDto, ConnectionState } from "./types";

export class ConsoleApiError extends Error {
  constructor(readonly payload: ApiErrorBody["error"]) {
    super(payload.message);
    this.name = "ConsoleApiError";
  }
}

export class ConsoleApi {
  #csrfToken = "";

  async initialize(): Promise<BootstrapDto> {
    const bootstrapToken = readAndClearBootstrapToken();
    if (bootstrapToken) {
      const response = await fetch("/api/v1/session", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bootstrapToken })
      });
      await parseResponse<{ csrfToken: string }>(response);
    }
    const bootstrap = await this.get<BootstrapDto>("/api/v1/bootstrap");
    this.#csrfToken = bootstrap.csrfToken;
    return bootstrap;
  }

  get<T>(pathname: string): Promise<T> {
    return this.#request<T>(pathname, { method: "GET" });
  }

  mutate<T>(pathname: string, method: "POST" | "PUT" | "PATCH" | "DELETE", body: unknown): Promise<T> {
    return this.#request<T>(pathname, {
      method,
      headers: { "Content-Type": "application/json", "X-CSRF-Token": this.#csrfToken },
      body: JSON.stringify(body)
    });
  }

  connectStream(
    afterVersion: number,
    onSnapshot: (snapshot: BootstrapDto) => void,
    onState: (state: ConnectionState) => void
  ): () => void {
    const source = new EventSource(`/api/v1/stream?afterVersion=${afterVersion}`, { withCredentials: true });
    let staleTimer: number | undefined;
    source.onopen = () => {
      if (staleTimer !== undefined) window.clearTimeout(staleTimer);
      onState("live");
    };
    source.addEventListener("snapshot", (event) => {
      const snapshot = JSON.parse((event as MessageEvent<string>).data) as BootstrapDto;
      snapshot.csrfToken = this.#csrfToken;
      onSnapshot(snapshot);
      onState("live");
    });
    source.onerror = () => {
      onState(navigator.onLine ? "reconnecting" : "offline");
      if (staleTimer !== undefined) window.clearTimeout(staleTimer);
      staleTimer = window.setTimeout(() => onState(navigator.onLine ? "stale" : "offline"), 8_000);
    };
    const online = () => onState("reconnecting");
    const offline = () => onState("offline");
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      source.close();
      if (staleTimer !== undefined) window.clearTimeout(staleTimer);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }

  async #request<T>(pathname: string, init: RequestInit): Promise<T> {
    const response = await fetch(pathname, { ...init, credentials: "same-origin" });
    return parseResponse<T>(response);
  }
}

export function newIdempotencyKey(): string {
  return `web:${crypto.randomUUID()}`;
}

async function parseResponse<T>(response: Response): Promise<T> {
  const value = (await response.json().catch(() => ({
    error: {
      code: "invalid_response",
      message: `The gateway returned ${response.status} without a JSON body.`,
      operationId: "unavailable",
      retryable: response.status >= 500
    }
  }))) as T | ApiErrorBody;
  if (!response.ok) throw new ConsoleApiError((value as ApiErrorBody).error);
  return value as T;
}

function readAndClearBootstrapToken(): string | null {
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const token = fragment.get("bootstrap");
  if (token) history.replaceState(history.state, "", `${window.location.pathname}${window.location.search}`);
  return token;
}
