import { EventEmitter } from "node:events";
import type Database from "better-sqlite3";
import type {
  AgentRecord,
  AgentResult,
  AgentStartRequest,
  AgentStatus,
  CheckpointQuality,
  IncarnationRecord,
  IncarnationStatus,
  NormalizedRuntimeEvent,
  PendingInteraction,
  RateLimitSnapshot,
  RoutingDecision,
  RuntimeHealth,
  RuntimeProfile
} from "../domain.js";
import { isTerminalStatus } from "../domain.js";
import { RouterError, type RouterErrorCode } from "../errors.js";
import { newId, requestHash } from "../security.js";
import type { RouterDatabase } from "./database.js";

type Row = Record<string, unknown>;

export interface IdempotencyClaim<T> {
  state: "new" | "replay" | "pending";
  result?: T;
}

export interface WorktreeRegistration {
  canonicalPath: string;
  repositoryId: string | null;
  headSha: string | null;
  baseSha: string | null;
  dirty: boolean;
  status: string;
}

export class Registry {
  readonly #db: Database.Database;
  readonly #events = new EventEmitter();

  constructor(database: RouterDatabase) {
    this.#db = database.connection;
    this.#events.setMaxListeners(1_000);
  }

  get registryVersion(): number {
    return Number((this.#db.prepare("SELECT value FROM meta WHERE key = 'registry_version'").get() as { value: string }).value);
  }

  registerRuntime(profile: RuntimeProfile): void {
    const now = new Date().toISOString();
    const health: RuntimeHealth = {
      state: "offline",
      initialized: false,
      activeCount: 0,
      failureRate: 0,
      eventLagMs: 0,
      quota: null,
      updatedAt: now
    };
    this.#db
      .prepare(
        `INSERT INTO runtime_profiles(id, profile_json, health_json, state, enabled, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           profile_json = excluded.profile_json,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`
      )
      .run(profile.id, json(profile), json(health), health.state, profile.enabled ? 1 : 0, now);
  }

  updateRuntimeHealth(runtimeId: string, patch: Partial<RuntimeHealth>): RuntimeHealth {
    const current = this.getRuntime(runtimeId);
    const updated: RuntimeHealth = {
      ...current.health,
      ...patch,
      quota: patch.quota === undefined ? current.health.quota : patch.quota,
      updatedAt: new Date().toISOString()
    };
    const version = this.#transactionVersion(() => {
      this.#db
        .prepare("UPDATE runtime_profiles SET health_json = ?, state = ?, updated_at = ? WHERE id = ?")
        .run(json(updated), updated.state, updated.updatedAt, runtimeId);
    });
    this.#emitVersion(version);
    return updated;
  }

  mergeRateLimit(runtimeId: string, sparse: Partial<RateLimitSnapshot>): RateLimitSnapshot {
    const runtime = this.getRuntime(runtimeId);
    const previous = runtime.health.quota;
    const primary = mergeDefined(previous?.primary, sparse.primary);
    const secondary = mergeDefined(previous?.secondary, sparse.secondary);
    const credits = mergeDefined(previous?.credits, sparse.credits);
    const next: RateLimitSnapshot = {
      ...(previous ?? { snapshotVersion: 0, updatedAt: new Date(0).toISOString() }),
      ...sparse,
      ...(primary ? { primary } : {}),
      ...(secondary ? { secondary } : {}),
      ...(credits ? { credits } : {}),
      snapshotVersion: (previous?.snapshotVersion ?? 0) + 1,
      updatedAt: new Date().toISOString()
    };
    this.updateRuntimeHealth(runtimeId, { quota: next });
    return next;
  }

  getRuntime(runtimeId: string): { profile: RuntimeProfile; health: RuntimeHealth } {
    const row = this.#db.prepare("SELECT * FROM runtime_profiles WHERE id = ?").get(runtimeId) as Row | undefined;
    if (!row) throw new RouterError("not_found", `Runtime ${runtimeId} was not found`);
    return {
      profile: parseJson<RuntimeProfile>(row.profile_json),
      health: parseJson<RuntimeHealth>(row.health_json)
    };
  }

  listRuntimes(): Array<{ profile: RuntimeProfile; health: RuntimeHealth; activeCount: number }> {
    const rows = this.#db
      .prepare(
        `SELECT r.*,
           (SELECT COUNT(*) FROM incarnations i
             WHERE i.runtime_id = r.id AND i.status IN ('allocating','thread_ready','turn_running','quiescing')) active_count
         FROM runtime_profiles r ORDER BY r.id`
      )
      .all() as Row[];
    return rows.map((row) => ({
      profile: parseJson<RuntimeProfile>(row.profile_json),
      health: parseJson<RuntimeHealth>(row.health_json),
      activeCount: Number(row.active_count)
    }));
  }

  createAgent(
    callerScope: string,
    request: AgentStartRequest,
    canonicalWorktreePath: string,
    idempotencyTtlMs: number
  ): { agent: AgentRecord; replay: boolean } {
    const hash = requestHash({ ...request, worktree: { ...request.worktree, path: canonicalWorktreePath } });
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + idempotencyTtlMs).toISOString();
    let createdAgentId = "";
    let replay = false;

    const transaction = this.#db.transaction(() => {
      const existing = this.#db
        .prepare(
          `SELECT request_hash, result_json FROM idempotency_records
           WHERE caller_scope = ? AND tool_name = 'agent_start' AND idempotency_key = ?`
        )
        .get(callerScope, request.idempotencyKey) as Row | undefined;
      if (existing) {
        if (existing.request_hash !== hash) {
          throw new RouterError("idempotency_conflict", "Idempotency key was reused with a conflicting start payload");
        }
        const result = parseJson<{ agentId: string }>(existing.result_json);
        createdAgentId = result.agentId;
        replay = true;
        this.#incrementMetric("duplicate_command_suppression_total");
        return;
      }

      createdAgentId = newId("agent");
      const version = this.#bumpVersion();
      this.#db
        .prepare(
          `INSERT INTO agents(
             id, caller_scope, task, project_key, worktree_path, worktree_mode,
             routing_json, authority_json, recovery_policy, labels_json, status,
             registry_version, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`
        )
        .run(
          createdAgentId,
          callerScope,
          request.task,
          request.projectKey,
          canonicalWorktreePath,
          request.worktree.mode,
          json(request.routing ?? {}),
          json(request.authority ?? defaultAuthority()),
          request.recoveryPolicy,
          json(request.labels),
          version,
          now,
          now
        );
      this.#db
        .prepare(
          `INSERT INTO idempotency_records(
             caller_scope, tool_name, idempotency_key, request_hash,
             operation_state, result_json, created_at, expires_at
           ) VALUES (?, 'agent_start', ?, ?, 'accepted', ?, ?, ?)`
        )
        .run(callerScope, request.idempotencyKey, hash, json({ agentId: createdAgentId }), now, expiresAt);
      const sequence = this.#insertEvent({
        eventId: newId("event"),
        runtimeId: "router",
        agentId: createdAgentId,
        type: "router_command",
        payload: { command: "agent_start", state: "accepted" },
        occurredAt: now
      });
      this.#db
        .prepare("UPDATE agents SET last_event_sequence = ? WHERE id = ?")
        .run(sequence, createdAgentId);
    });
    transaction();
    if (!replay) this.#emitVersion(this.registryVersion);
    return { agent: this.getAgent(createdAgentId), replay };
  }

  claimIdempotency<T>(
    callerScope: string,
    toolName: string,
    key: string,
    request: unknown,
    ttlMs: number
  ): IdempotencyClaim<T> {
    const hash = requestHash(request);
    const existing = this.#db
      .prepare(
        `SELECT request_hash, operation_state, result_json FROM idempotency_records
         WHERE caller_scope = ? AND tool_name = ? AND idempotency_key = ?`
      )
      .get(callerScope, toolName, key) as Row | undefined;
    if (existing) {
      if (existing.request_hash !== hash) {
        throw new RouterError("idempotency_conflict", `Idempotency key conflicts for ${toolName}`);
      }
      if (existing.operation_state === "completed") {
        this.#incrementMetric("duplicate_command_suppression_total");
        return { state: "replay", result: parseJson<T>(existing.result_json) };
      }
      if (existing.operation_state === "failed" && existing.result_json) {
        this.#incrementMetric("duplicate_command_suppression_total");
        const failure = parseJson<{ code?: RouterErrorCode; message?: string; details?: Record<string, unknown> }>(
          existing.result_json
        );
        throw new RouterError(
          failure.code ?? "conflict",
          failure.message ?? `Previous ${toolName} attempt failed`,
          failure.details ?? {}
        );
      }
      this.#incrementMetric("duplicate_command_suppression_total");
      return { state: "pending" };
    }
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO idempotency_records(
           caller_scope, tool_name, idempotency_key, request_hash,
           operation_state, created_at, expires_at
         ) VALUES (?, ?, ?, ?, 'in_progress', ?, ?)`
      )
      .run(callerScope, toolName, key, hash, now, new Date(Date.now() + ttlMs).toISOString());
    return { state: "new" };
  }

  completeIdempotency(callerScope: string, toolName: string, key: string, result: unknown): void {
    this.#db
      .prepare(
        `UPDATE idempotency_records SET operation_state = 'completed', result_json = ?
         WHERE caller_scope = ? AND tool_name = ? AND idempotency_key = ?`
      )
      .run(json(result), callerScope, toolName, key);
  }

  failIdempotency(callerScope: string, toolName: string, key: string, result: unknown): void {
    this.#db
      .prepare(
        `UPDATE idempotency_records SET operation_state = 'failed', result_json = ?
         WHERE caller_scope = ? AND tool_name = ? AND idempotency_key = ?`
      )
      .run(json(result), callerScope, toolName, key);
  }

  createIncarnation(agentId: string, runtimeId: string): IncarnationRecord {
    const id = newId("inc");
    const now = new Date().toISOString();
    const version = this.#transactionVersion(() => {
      this.#db
        .prepare(
          `INSERT INTO incarnations(id, agent_id, runtime_id, status, created_at, updated_at)
           VALUES (?, ?, ?, 'allocating', ?, ?)`
        )
        .run(id, agentId, runtimeId, now, now);
      const sequence = this.#insertEvent({
        eventId: newId("event"),
        runtimeId,
        agentId,
        incarnationId: id,
        type: "router_command",
        payload: { command: "allocate_incarnation" },
        occurredAt: now
      });
      this.#db
        .prepare(
          `UPDATE agents SET current_incarnation_id = ?, status = 'starting', registry_version = ?,
             last_event_sequence = ?, updated_at = ? WHERE id = ?`
        )
        .run(id, this.#currentTransactionVersion(), sequence, now, agentId);
    });
    this.#emitVersion(version);
    return this.getIncarnation(id);
  }

  setIncarnationLease(incarnationId: string, fencingToken: number): void {
    this.#db.prepare("UPDATE incarnations SET fencing_token = ? WHERE id = ?").run(fencingToken, incarnationId);
  }

  setRuntimeIdentifiers(
    incarnationId: string,
    identifiers: { threadId?: string | null; turnId?: string | null; status?: IncarnationStatus }
  ): IncarnationRecord {
    const current = this.getIncarnation(incarnationId);
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `UPDATE incarnations SET thread_id = ?, turn_id = ?, status = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        identifiers.threadId === undefined ? current.threadId : identifiers.threadId,
        identifiers.turnId === undefined ? current.turnId : identifiers.turnId,
        identifiers.status ?? current.status,
        now,
        incarnationId
      );
    return this.getIncarnation(incarnationId);
  }

  transitionAgent(
    agentId: string,
    expected: AgentStatus[],
    next: AgentStatus,
    command: string,
    payload: Record<string, unknown> = {}
  ): AgentRecord {
    const current = this.getAgent(agentId);
    if (!expected.includes(current.status)) {
      throw new RouterError("invalid_transition", `Cannot transition ${current.status} to ${next}`, {
        currentStatus: current.status,
        registryVersion: current.registryVersion
      });
    }
    const now = new Date().toISOString();
    const version = this.#transactionVersion(() => {
      const sequence = this.#insertEvent({
        eventId: newId("event"),
        runtimeId: "router",
        agentId,
        ...(current.currentIncarnationId ? { incarnationId: current.currentIncarnationId } : {}),
        type: "router_command",
        payload: { command, previousStatus: current.status, nextStatus: next, ...payload },
        occurredAt: now
      });
      this.#db
        .prepare(
          `UPDATE agents SET status = ?, registry_version = ?, last_event_sequence = ?, updated_at = ? WHERE id = ?`
        )
        .run(next, this.#currentTransactionVersion(), sequence, now, agentId);
    });
    this.#emitVersion(version);
    return this.getAgent(agentId);
  }

  registerWorktree(registration: WorktreeRegistration): void {
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO worktrees(
           canonical_path, repository_id, head_sha, base_sha, dirty_at_registration,
           registration_status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(canonical_path) DO UPDATE SET
           repository_id = excluded.repository_id,
           head_sha = excluded.head_sha,
           base_sha = excluded.base_sha,
           registration_status = excluded.registration_status,
           updated_at = excluded.updated_at`
      )
      .run(
        registration.canonicalPath,
        registration.repositoryId,
        registration.headSha,
        registration.baseSha,
        registration.dirty ? 1 : 0,
        registration.status,
        now,
        now
      );
  }

  acquireWriteLease(
    canonicalPath: string,
    agentId: string,
    incarnationId: string,
    ttlMs: number
  ): number {
    let token = 0;
    const now = new Date();
    const transaction = this.#db.transaction(() => {
      const existing = this.#db
        .prepare("SELECT * FROM worktree_leases WHERE canonical_path = ?")
        .get(canonicalPath) as Row | undefined;
      if (existing && new Date(String(existing.expires_at)).getTime() > now.getTime()) {
        if (existing.agent_id === agentId && existing.incarnation_id === incarnationId) {
          token = Number(existing.fencing_token);
          return;
        }
        throw new RouterError("worktree_conflict", `Worktree already has an active writer`, {
          canonicalPath,
          ownerAgentId: existing.agent_id,
          ownerIncarnationId: existing.incarnation_id
        });
      }
      const worktree = this.#db
        .prepare("SELECT fencing_counter FROM worktrees WHERE canonical_path = ?")
        .get(canonicalPath) as Row | undefined;
      if (!worktree) throw new RouterError("invalid_worktree", "Worktree must be registered before lease acquisition");
      token = Number(worktree.fencing_counter) + 1;
      const timestamp = now.toISOString();
      const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
      this.#db
        .prepare("UPDATE worktrees SET fencing_counter = ?, updated_at = ? WHERE canonical_path = ?")
        .run(token, timestamp, canonicalPath);
      this.#db
        .prepare(
          `INSERT INTO worktree_leases(
             canonical_path, agent_id, incarnation_id, fencing_token, expires_at, acquired_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(canonical_path) DO UPDATE SET
             agent_id = excluded.agent_id,
             incarnation_id = excluded.incarnation_id,
             fencing_token = excluded.fencing_token,
             expires_at = excluded.expires_at,
             acquired_at = excluded.acquired_at,
             updated_at = excluded.updated_at`
        )
        .run(canonicalPath, agentId, incarnationId, token, expiresAt, timestamp, timestamp);
      this.#db.prepare("UPDATE incarnations SET fencing_token = ? WHERE id = ?").run(token, incarnationId);
    });
    transaction();
    return token;
  }

  renewWriteLease(canonicalPath: string, incarnationId: string, fencingToken: number, ttlMs: number): void {
    const result = this.#db
      .prepare(
        `UPDATE worktree_leases SET expires_at = ?, updated_at = ?
         WHERE canonical_path = ? AND incarnation_id = ? AND fencing_token = ?`
      )
      .run(
        new Date(Date.now() + ttlMs).toISOString(),
        new Date().toISOString(),
        canonicalPath,
        incarnationId,
        fencingToken
      );
    if (result.changes !== 1) throw new RouterError("worktree_conflict", "Writer lease has been fenced");
  }

  releaseWriteLease(canonicalPath: string, incarnationId: string, fencingToken: number): boolean {
    const result = this.#db
      .prepare(
        `DELETE FROM worktree_leases
         WHERE canonical_path = ? AND incarnation_id = ? AND fencing_token = ?`
      )
      .run(canonicalPath, incarnationId, fencingToken);
    return result.changes === 1;
  }

  getLease(canonicalPath: string): Row | null {
    return (
      (this.#db.prepare("SELECT * FROM worktree_leases WHERE canonical_path = ?").get(canonicalPath) as
        | Row
        | undefined) ?? null
    );
  }

  getLeaseForIncarnation(incarnationId: string): {
    canonicalPath: string;
    agentId: string;
    incarnationId: string;
    fencingToken: number;
    expiresAt: string;
  } | null {
    const row = this.#db
      .prepare("SELECT * FROM worktree_leases WHERE incarnation_id = ?")
      .get(incarnationId) as Row | undefined;
    if (!row) return null;
    return {
      canonicalPath: String(row.canonical_path),
      agentId: String(row.agent_id),
      incarnationId: String(row.incarnation_id),
      fencingToken: Number(row.fencing_token),
      expiresAt: String(row.expires_at)
    };
  }

  appendAndProject(event: NormalizedRuntimeEvent): { inserted: boolean; sequence?: number; version?: number } {
    let inserted = false;
    let sequence: number | undefined;
    let version: number | undefined;
    const transaction = this.#db.transaction(() => {
      const duplicate = this.#db
        .prepare(
          `SELECT sequence FROM event_journal WHERE event_id = ? OR (backend_event_key IS NOT NULL AND backend_event_key = ?)`
        )
        .get(event.eventId, event.backendEventKey ?? null) as Row | undefined;
      if (duplicate) return;
      sequence = this.#insertEvent(event);
      inserted = true;

      if (event.type === "rate_limits_updated") {
        const runtime = this.getRuntime(event.runtimeId);
        const sparse = event.payload as Partial<RateLimitSnapshot>;
        const previous = runtime.health.quota;
        const primary = mergeDefined(previous?.primary, sparse.primary);
        const secondary = mergeDefined(previous?.secondary, sparse.secondary);
        const credits = mergeDefined(previous?.credits, sparse.credits);
        const quota: RateLimitSnapshot = {
          ...(previous ?? { snapshotVersion: 0, updatedAt: new Date(0).toISOString() }),
          ...sparse,
          ...(primary ? { primary } : {}),
          ...(secondary ? { secondary } : {}),
          ...(credits ? { credits } : {}),
          snapshotVersion: (previous?.snapshotVersion ?? 0) + 1,
          updatedAt: event.occurredAt
        };
        const health = { ...runtime.health, quota, updatedAt: event.occurredAt };
        this.#db
          .prepare("UPDATE runtime_profiles SET health_json = ?, updated_at = ? WHERE id = ?")
          .run(json(health), event.occurredAt, event.runtimeId);
        version = this.#bumpVersion();
        return;
      }

      const agentId = event.agentId ?? this.#findAgentId(event);
      if (!agentId) return;
      const agent = this.getAgent(agentId);
      const incarnationId = event.incarnationId ?? agent.currentIncarnationId;
      const incarnation = incarnationId ? this.getIncarnation(incarnationId) : null;
      const staleIncarnation = Boolean(
        incarnationId && agent.currentIncarnationId && incarnationId !== agent.currentIncarnationId
      );
      const staleTurn = Boolean(event.turnId && incarnation?.turnId && event.turnId !== incarnation.turnId);
      version = this.#bumpVersion();
      const updates: Record<string, unknown> = {
        registry_version: version,
        last_event_sequence: sequence,
        updated_at: event.occurredAt
      };

      if (staleIncarnation) {
        if (event.type === "semantic_output") updates.semantic_output_seen = 1;
        if (["command_started", "file_change", "turn_diff_updated"].includes(event.type)) {
          updates.side_effects_seen = 1;
        }
        if (event.type === "interaction_resolved") {
          const interactionId = String(event.payload.interactionId ?? "");
          if (interactionId) {
            this.#db
              .prepare("UPDATE pending_interactions SET state = 'resolved', resolved_at = ? WHERE id = ?")
              .run(event.occurredAt, interactionId);
          }
        }
        if (event.type === "turn_completed" && incarnationId) {
          const terminal = terminalStatus(event.payload);
          this.#updateIncarnation(incarnationId, {
            status: terminal.incarnation,
            terminal_reason: stringField(event.payload, "terminalReason") ?? terminal.agent,
            updated_at: event.occurredAt
          });
          this.#expirePendingInteractions(incarnationId, event.occurredAt);
        }
        this.#updateAgentColumns(agentId, updates);
        return;
      }

      switch (event.type) {
        case "thread_started":
          updates.status = "starting";
          if (incarnationId) {
            this.#updateIncarnation(incarnationId, {
              thread_id: event.threadId ?? stringField(event.payload, "threadId"),
              status: "thread_ready",
              updated_at: event.occurredAt
            });
          }
          break;
        case "turn_started":
          if (staleTurn && incarnation?.status === "turn_running") break;
          updates.status = agent.pendingInteractionId ? "needs_attention" : "running";
          if (incarnationId) {
            this.#updateIncarnation(incarnationId, {
              thread_id: event.threadId ?? undefined,
              turn_id: event.turnId ?? stringField(event.payload, "turnId"),
              status: "turn_running",
              updated_at: event.occurredAt
            });
          }
          break;
        case "semantic_output":
          updates.semantic_output_seen = 1;
          break;
        case "command_started":
        case "file_change":
        case "turn_diff_updated":
          updates.side_effects_seen = 1;
          break;
        case "pending_interaction": {
          if (staleTurn) break;
          if (!incarnationId) break;
          if (!["starting", "running", "needs_attention"].includes(agent.status)) break;
          const interactionId = String(event.payload.interactionId ?? newId("interaction"));
          this.#db
            .prepare(
              `INSERT INTO pending_interactions(
                 id, agent_id, incarnation_id, runtime_id, backend_request_id,
                 method, kind, params_json, state, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
               ON CONFLICT(id) DO NOTHING`
            )
            .run(
              interactionId,
              agentId,
              incarnationId,
              event.runtimeId,
              json(event.payload.backendRequestId ?? ""),
              String(event.payload.method ?? "unknown"),
              event.payload.kind === "user_input" ? "user_input" : "approval",
              json(event.payload.params ?? {}),
              event.occurredAt
            );
          updates.status = "needs_attention";
          updates.pending_interaction_id = interactionId;
          break;
        }
        case "interaction_resolved": {
          if (staleTurn) break;
          const interactionId = String(event.payload.interactionId ?? agent.pendingInteractionId ?? "");
          if (interactionId) {
            this.#db
              .prepare(
                `UPDATE pending_interactions SET state = 'resolved', resolved_at = ? WHERE id = ?`
              )
              .run(event.occurredAt, interactionId);
          }
          if (agent.status === "needs_attention" && agent.pendingInteractionId === interactionId) {
            updates.status = "running";
            updates.pending_interaction_id = null;
          }
          break;
        }
        case "turn_completed": {
          if (staleTurn) break;
          const terminal = terminalStatus(event.payload);
          updates.status = terminal.agent;
          updates.pending_interaction_id = null;
          if (incarnationId) {
            this.#updateIncarnation(incarnationId, {
              status: terminal.incarnation,
              terminal_reason: stringField(event.payload, "terminalReason") ?? terminal.agent,
              updated_at: event.occurredAt
            });
            this.#expirePendingInteractions(incarnationId, event.occurredAt);
          }
          break;
        }
        case "runtime_error":
          break;
        case "runtime_disconnected":
          break;
        default:
          break;
      }
      this.#updateAgentColumns(agentId, updates);
    });
    transaction();
    if (!inserted) this.#incrementMetric("duplicate_event_suppression_total");
    if (version !== undefined) this.#emitVersion(version);
    return { inserted, ...(sequence === undefined ? {} : { sequence }), ...(version === undefined ? {} : { version }) };
  }

  createCheckpoint(
    agentId: string,
    incarnationId: string,
    quality: CheckpointQuality,
    payload: Record<string, unknown>
  ): string {
    const id = newId("checkpoint");
    const now = new Date().toISOString();
    const version = this.#transactionVersion(() => {
      const sequence = this.#insertEvent({
        eventId: newId("event"),
        runtimeId: "router",
        agentId,
        incarnationId,
        type: "checkpoint_created",
        payload: { checkpointId: id, quality },
        occurredAt: now
      });
      this.#db
        .prepare(
          "INSERT INTO checkpoints(id, agent_id, incarnation_id, quality, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run(id, agentId, incarnationId, quality, json(payload), now);
      this.#db
        .prepare(
          `UPDATE agents SET checkpoint_quality = ?, registry_version = ?, last_event_sequence = ?, updated_at = ? WHERE id = ?`
        )
        .run(quality, this.#currentTransactionVersion(), sequence, now, agentId);
    });
    this.#emitVersion(version);
    return id;
  }

  getLatestCheckpoint(agentId: string): { id: string; incarnationId: string; quality: CheckpointQuality; payload: Record<string, unknown> } | null {
    const row = this.#db
      .prepare("SELECT * FROM checkpoints WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(agentId) as Row | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      incarnationId: String(row.incarnation_id),
      quality: row.quality as CheckpointQuality,
      payload: parseJson<Record<string, unknown>>(row.payload_json)
    };
  }

  saveResult(result: Omit<AgentResult, "resultVersion">): AgentResult {
    const latest = this.#db
      .prepare("SELECT COALESCE(MAX(version), 0) version FROM results WHERE agent_id = ?")
      .get(result.agentId) as { version: number };
    const withVersion: AgentResult = { ...result, resultVersion: Number(latest.version) + 1 };
    const now = new Date().toISOString();
    const version = this.#transactionVersion(() => {
      this.#db
        .prepare("INSERT INTO results(agent_id, version, payload_json, created_at) VALUES (?, ?, ?, ?)")
        .run(withVersion.agentId, withVersion.resultVersion, json(withVersion), now);
      this.#db
        .prepare("UPDATE agents SET registry_version = ?, updated_at = ? WHERE id = ?")
        .run(this.#currentTransactionVersion(), now, result.agentId);
    });
    this.#emitVersion(version);
    return withVersion;
  }

  getResult(agentId: string, version?: number): AgentResult {
    const row = version
      ? (this.#db.prepare("SELECT payload_json FROM results WHERE agent_id = ? AND version = ?").get(agentId, version) as Row | undefined)
      : (this.#db.prepare("SELECT payload_json FROM results WHERE agent_id = ? ORDER BY version DESC LIMIT 1").get(agentId) as Row | undefined);
    if (!row) throw new RouterError("not_found", `No result exists for agent ${agentId}`);
    return parseJson<AgentResult>(row.payload_json);
  }

  latestResultVersion(agentId: string): number {
    const row = this.#db
      .prepare("SELECT COALESCE(MAX(version), 0) version FROM results WHERE agent_id = ?")
      .get(agentId) as { version: number };
    return Number(row.version);
  }

  recordRoutingDecision(agentId: string, incarnationId: string | null, decision: RoutingDecision): void {
    const now = new Date().toISOString();
    const version = this.#transactionVersion(() => {
      this.#db
        .prepare("INSERT INTO routing_decisions(agent_id, incarnation_id, decision_json, created_at) VALUES (?, ?, ?, ?)")
        .run(agentId, incarnationId, json(decision), now);
      const sequence = this.#insertEvent({
        eventId: newId("event"),
        runtimeId: decision.selectedRuntimeId,
        agentId,
        ...(incarnationId ? { incarnationId } : {}),
        type: "routing_decision",
        payload: decision as unknown as Record<string, unknown>,
        occurredAt: now
      });
      this.#db
        .prepare("UPDATE agents SET registry_version = ?, last_event_sequence = ?, updated_at = ? WHERE id = ?")
        .run(this.#currentTransactionVersion(), sequence, now, agentId);
    });
    this.#emitVersion(version);
  }

  getAgent(agentId: string): AgentRecord {
    const row = this.#db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as Row | undefined;
    if (!row) throw new RouterError("not_found", `Agent ${agentId} was not found`);
    return mapAgent(row);
  }

  listAgents(): AgentRecord[] {
    return (this.#db.prepare("SELECT * FROM agents ORDER BY created_at DESC, id DESC").all() as Row[]).map(mapAgent);
  }

  getIncarnation(incarnationId: string): IncarnationRecord {
    const row = this.#db.prepare("SELECT * FROM incarnations WHERE id = ?").get(incarnationId) as Row | undefined;
    if (!row) throw new RouterError("not_found", `Incarnation ${incarnationId} was not found`);
    return mapIncarnation(row);
  }

  getIncarnations(agentId: string): IncarnationRecord[] {
    return (this.#db.prepare("SELECT * FROM incarnations WHERE agent_id = ? ORDER BY created_at").all(agentId) as Row[]).map(mapIncarnation);
  }

  getPendingInteraction(interactionId: string): PendingInteraction {
    const row = this.#db.prepare("SELECT * FROM pending_interactions WHERE id = ?").get(interactionId) as Row | undefined;
    if (!row) throw new RouterError("not_found", `Interaction ${interactionId} was not found`);
    return mapInteraction(row);
  }

  listInteractions(state?: PendingInteraction["state"]): PendingInteraction[] {
    const rows = state
      ? (this.#db
          .prepare("SELECT * FROM pending_interactions WHERE state = ? ORDER BY created_at DESC")
          .all(state) as Row[])
      : (this.#db
          .prepare("SELECT * FROM pending_interactions ORDER BY created_at DESC")
          .all() as Row[]);
    return rows.map(mapInteraction);
  }

  resolveInteraction(interactionId: string, response: unknown): void {
    const interaction = this.getPendingInteraction(interactionId);
    const agent = this.getAgent(interaction.agentId);
    if (
      interaction.state !== "pending" ||
      agent.status !== "needs_attention" ||
      agent.currentIncarnationId !== interaction.incarnationId ||
      agent.pendingInteractionId !== interaction.id
    ) {
      throw new RouterError("conflict", "Interaction is no longer current for this agent");
    }
    const now = new Date().toISOString();
    const version = this.#transactionVersion(() => {
      const sequence = this.#insertEvent({
        eventId: newId("event"),
        runtimeId: interaction.runtimeId,
        agentId: interaction.agentId,
        incarnationId: interaction.incarnationId,
        type: "interaction_resolved",
        payload: { interactionId },
        occurredAt: now
      });
      this.#db
        .prepare(
          `UPDATE pending_interactions SET state = 'resolved', response_json = ?, resolved_at = ? WHERE id = ? AND state = 'pending'`
        )
        .run(json(response), now, interactionId);
      this.#db
        .prepare(
          `UPDATE agents SET status = 'running', pending_interaction_id = NULL,
             registry_version = ?, last_event_sequence = ?, updated_at = ? WHERE id = ?`
        )
        .run(this.#currentTransactionVersion(), sequence, now, interaction.agentId);
    });
    this.#emitVersion(version);
  }

  getEvents(agentId: string, limit = 100): Array<Record<string, unknown>> {
    return (this.#db
      .prepare("SELECT * FROM event_journal WHERE agent_id = ? ORDER BY sequence DESC LIMIT ?")
      .all(agentId, limit) as Row[]).map(mapEvent);
  }

  listEvents(input: {
    agentId?: string;
    runtimeId?: string;
    eventType?: string;
    beforeSequence?: number;
    limit?: number;
  } = {}): Array<Record<string, unknown>> {
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (input.agentId) {
      clauses.push("agent_id = ?");
      values.push(input.agentId);
    }
    if (input.runtimeId) {
      clauses.push("runtime_id = ?");
      values.push(input.runtimeId);
    }
    if (input.eventType) {
      clauses.push("event_type = ?");
      values.push(input.eventType);
    }
    if (input.beforeSequence !== undefined) {
      clauses.push("sequence < ?");
      values.push(input.beforeSequence);
    }
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return (this.#db
      .prepare(`SELECT * FROM event_journal ${where} ORDER BY sequence DESC LIMIT ?`)
      .all(...values, limit) as Row[]).map(mapEvent);
  }

  listResults(agentId: string): AgentResult[] {
    return (this.#db
      .prepare("SELECT payload_json FROM results WHERE agent_id = ? ORDER BY version DESC")
      .all(agentId) as Row[]).map((row) => parseJson<AgentResult>(row.payload_json));
  }

  listRoutingDecisions(agentId: string): Array<{ decision: RoutingDecision; createdAt: string }> {
    return (this.#db
      .prepare("SELECT decision_json, created_at FROM routing_decisions WHERE agent_id = ? ORDER BY id DESC")
      .all(agentId) as Row[]).map((row) => ({
      decision: parseJson<RoutingDecision>(row.decision_json),
      createdAt: String(row.created_at)
    }));
  }

  listWorktrees(): Array<Record<string, unknown>> {
    const rows = this.#db
      .prepare(
        `SELECT w.*, l.agent_id lease_agent_id, l.incarnation_id lease_incarnation_id,
                l.fencing_token lease_fencing_token, l.expires_at lease_expires_at,
                l.acquired_at lease_acquired_at, l.updated_at lease_updated_at
         FROM worktrees w
         LEFT JOIN worktree_leases l ON l.canonical_path = w.canonical_path
         ORDER BY w.updated_at DESC`
      )
      .all() as Row[];
    return rows.map((row) => ({
      canonicalPath: String(row.canonical_path),
      repositoryId: row.repository_id ? String(row.repository_id) : null,
      headSha: row.head_sha ? String(row.head_sha) : null,
      baseSha: row.base_sha ? String(row.base_sha) : null,
      dirtyAtRegistration: Boolean(row.dirty_at_registration),
      registrationStatus: String(row.registration_status),
      fencingCounter: Number(row.fencing_counter),
      updatedAt: String(row.updated_at),
      lease: row.lease_agent_id
        ? {
            agentId: String(row.lease_agent_id),
            incarnationId: String(row.lease_incarnation_id),
            fencingToken: Number(row.lease_fencing_token),
            expiresAt: String(row.lease_expires_at),
            acquiredAt: String(row.lease_acquired_at),
            updatedAt: String(row.lease_updated_at)
          }
        : null
    }));
  }

  diagnostics(): Record<string, unknown> {
    const agentStatuses = this.#db
      .prepare("SELECT status, COUNT(*) count FROM agents GROUP BY status ORDER BY status")
      .all() as Row[];
    const eventCounts = this.#db
      .prepare("SELECT event_type, COUNT(*) count FROM event_journal GROUP BY event_type ORDER BY event_type")
      .all() as Row[];
    const metrics = this.#db.prepare("SELECT name, value FROM metrics ORDER BY name").all() as Row[];
    const leases = this.#db
      .prepare(
        `SELECT canonical_path, agent_id, incarnation_id, fencing_token, expires_at
         FROM worktree_leases ORDER BY canonical_path`
      )
      .all() as Row[];
    const interactions = this.#db
      .prepare(
        `SELECT id, agent_id, runtime_id, method, kind, created_at
         FROM pending_interactions WHERE state = 'pending' ORDER BY created_at`
      )
      .all() as Row[];
    return {
      registryVersion: this.registryVersion,
      agentsByStatus: Object.fromEntries(agentStatuses.map((row) => [String(row.status), Number(row.count)])),
      eventsByType: Object.fromEntries(eventCounts.map((row) => [String(row.event_type), Number(row.count)])),
      counters: Object.fromEntries(metrics.map((row) => [String(row.name), Number(row.value)])),
      runtimes: this.listRuntimes().map((entry) => ({
        id: entry.profile.id,
        provider: entry.profile.provider,
        adapter: entry.profile.adapter,
        state: entry.health.state,
        initialized: entry.health.initialized,
        activeCount: entry.activeCount,
        maxConcurrency: entry.profile.maxConcurrency,
        quota: entry.health.quota,
        eventLagMs: entry.health.eventLagMs,
        updatedAt: entry.health.updatedAt
      })),
      writerLeases: leases.map((row) => ({
        path: row.canonical_path,
        agentId: row.agent_id,
        incarnationId: row.incarnation_id,
        fencingToken: Number(row.fencing_token),
        expiresAt: row.expires_at
      })),
      pendingInteractions: interactions.map((row) => ({
        id: row.id,
        agentId: row.agent_id,
        runtimeId: row.runtime_id,
        method: row.method,
        kind: row.kind,
        createdAt: row.created_at
      }))
    };
  }

  async waitForVersion(afterVersion: number, timeoutMs: number): Promise<number> {
    const current = this.registryVersion;
    if (current > afterVersion) return current;
    if (timeoutMs === 0) return current;
    return new Promise<number>((resolve) => {
      let settled = false;
      const finish = (version: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#events.off("version", onVersion);
        resolve(version);
      };
      const onVersion = (version: number) => {
        if (version > afterVersion) finish(version);
      };
      const timer = setTimeout(() => finish(this.registryVersion), timeoutMs);
      this.#events.on("version", onVersion);
      const latest = this.registryVersion;
      if (latest > afterVersion) finish(latest);
    });
  }

  #findAgentId(event: NormalizedRuntimeEvent): string | null {
    if (event.incarnationId) {
      const row = this.#db.prepare("SELECT agent_id FROM incarnations WHERE id = ?").get(event.incarnationId) as Row | undefined;
      if (row) return String(row.agent_id);
    }
    if (event.threadId) {
      const row = this.#db
        .prepare("SELECT agent_id FROM incarnations WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1")
        .get(event.threadId) as Row | undefined;
      if (row) return String(row.agent_id);
    }
    return null;
  }

  #insertEvent(event: NormalizedRuntimeEvent): number {
    const result = this.#db
      .prepare(
        `INSERT INTO event_journal(
           event_id, backend_event_key, agent_id, incarnation_id, runtime_id,
           thread_id, turn_id, event_type, payload_json, occurred_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.eventId,
        event.backendEventKey ?? null,
        event.agentId ?? null,
        event.incarnationId ?? null,
        event.runtimeId,
        event.threadId ?? null,
        event.turnId ?? null,
        event.type,
        json(event.payload),
        event.occurredAt,
        new Date().toISOString()
      );
    return Number(result.lastInsertRowid);
  }

  #updateAgentColumns(agentId: string, updates: Record<string, unknown>): void {
    const entries = Object.entries(updates).filter(([, value]) => value !== undefined);
    if (entries.length === 0) return;
    const columns = entries.map(([key]) => `${key} = ?`).join(", ");
    this.#db.prepare(`UPDATE agents SET ${columns} WHERE id = ?`).run(...entries.map(([, value]) => value), agentId);
  }

  #updateIncarnation(incarnationId: string, updates: Record<string, unknown>): void {
    const entries = Object.entries(updates).filter(([, value]) => value !== undefined);
    if (entries.length === 0) return;
    const columns = entries.map(([key]) => `${key} = ?`).join(", ");
    this.#db
      .prepare(`UPDATE incarnations SET ${columns} WHERE id = ?`)
      .run(...entries.map(([, value]) => value), incarnationId);
  }

  #expirePendingInteractions(incarnationId: string, resolvedAt: string): void {
    this.#db
      .prepare(
        "UPDATE pending_interactions SET state = 'expired', resolved_at = ? WHERE incarnation_id = ? AND state = 'pending'"
      )
      .run(resolvedAt, incarnationId);
  }

  #transactionVersion(operation: () => void): number {
    let version = 0;
    const transaction = this.#db.transaction(() => {
      version = this.#bumpVersion();
      this.#activeTransactionVersion = version;
      try {
        operation();
      } finally {
        this.#activeTransactionVersion = null;
      }
    });
    transaction();
    return version;
  }

  #activeTransactionVersion: number | null = null;

  #currentTransactionVersion(): number {
    if (this.#activeTransactionVersion === null) throw new Error("No active versioned transaction");
    return this.#activeTransactionVersion;
  }

  #bumpVersion(): number {
    const next = this.registryVersion + 1;
    this.#db.prepare("UPDATE meta SET value = ? WHERE key = 'registry_version'").run(String(next));
    return next;
  }

  #emitVersion(version: number): void {
    queueMicrotask(() => this.#events.emit("version", version));
  }

  #incrementMetric(name: string): void {
    this.#db
      .prepare(
        `INSERT INTO metrics(name, value) VALUES (?, 1)
         ON CONFLICT(name) DO UPDATE SET value = value + 1`
      )
      .run(name);
  }
}

function mapAgent(row: Row): AgentRecord {
  return {
    id: String(row.id),
    callerScope: String(row.caller_scope),
    task: String(row.task),
    projectKey: String(row.project_key),
    worktreePath: String(row.worktree_path),
    worktreeMode: row.worktree_mode as AgentRecord["worktreeMode"],
    routing: parseJson(row.routing_json),
    authority: parseJson(row.authority_json),
    recoveryPolicy: row.recovery_policy as AgentRecord["recoveryPolicy"],
    labels: parseJson(row.labels_json),
    status: row.status as AgentStatus,
    registryVersion: Number(row.registry_version),
    currentIncarnationId: nullableString(row.current_incarnation_id),
    semanticOutputSeen: Boolean(row.semantic_output_seen),
    sideEffectsSeen: Boolean(row.side_effects_seen),
    pendingInteractionId: nullableString(row.pending_interaction_id),
    checkpointQuality: (row.checkpoint_quality as CheckpointQuality | null) ?? null,
    lastEventSequence: row.last_event_sequence === null ? null : Number(row.last_event_sequence),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapIncarnation(row: Row): IncarnationRecord {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    runtimeId: String(row.runtime_id),
    threadId: nullableString(row.thread_id),
    turnId: nullableString(row.turn_id),
    status: row.status as IncarnationStatus,
    terminalReason: nullableString(row.terminal_reason),
    fencingToken: row.fencing_token === null ? null : Number(row.fencing_token),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapInteraction(row: Row): PendingInteraction {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    incarnationId: String(row.incarnation_id),
    runtimeId: String(row.runtime_id),
    backendRequestId: parseJson<string | number>(row.backend_request_id),
    method: String(row.method),
    kind: row.kind as PendingInteraction["kind"],
    params: parseJson(row.params_json),
    state: row.state as PendingInteraction["state"],
    createdAt: String(row.created_at),
    resolvedAt: nullableString(row.resolved_at)
  };
}

function mapEvent(row: Row): Record<string, unknown> {
  return {
    sequence: Number(row.sequence),
    eventId: String(row.event_id),
    type: String(row.event_type),
    runtimeId: nullableString(row.runtime_id),
    agentId: nullableString(row.agent_id),
    incarnationId: nullableString(row.incarnation_id),
    threadId: nullableString(row.thread_id),
    turnId: nullableString(row.turn_id),
    payload: parseJson(row.payload_json),
    occurredAt: String(row.occurred_at)
  };
}

function defaultAuthority() {
  return { allowPush: false, allowMerge: false, allowDeploy: false, allowExternalWrites: false };
}

function terminalStatus(payload: Record<string, unknown>): {
  agent: "completed" | "failed" | "interrupted";
  incarnation: "completed" | "failed" | "interrupted";
} {
  const status = String(payload.status ?? "failed");
  if (status === "completed") return { agent: "completed", incarnation: "completed" };
  if (status === "interrupted" || status === "cancelled") return { agent: "interrupted", incarnation: "interrupted" };
  return { agent: "failed", incarnation: "failed" };
}

function mergeDefined<T extends object>(previous: T | undefined, patch: Partial<T> | undefined): T | undefined {
  if (!previous && !patch) return undefined;
  return { ...(previous ?? {}), ...(patch ?? {}) } as T;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const entry = value[key];
  return typeof entry === "string" ? entry : undefined;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson<T = Record<string, unknown>>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

export function agentWakeState(agent: AgentRecord, afterVersion: number, wakeOn: string[]) {
  const terminal = isTerminalStatus(agent.status);
  const needsAttention = agent.status === "needs_attention";
  const handingOff = agent.status === "handing_off" || agent.status === "waiting_for_reset";
  const changed = agent.registryVersion > afterVersion;
  const satisfied =
    (wakeOn.includes("terminal") && terminal) ||
    (wakeOn.includes("needs_attention") && needsAttention) ||
    (wakeOn.includes("handoff") && handingOff) ||
    (wakeOn.includes("status_change") && changed);
  return { agentId: agent.id, status: agent.status, changed, terminal, needsAttention, satisfied };
}
