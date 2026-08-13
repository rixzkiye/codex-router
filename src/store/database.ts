import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const SCHEMA_VERSION = 2;

export class RouterDatabase {
  readonly connection: Database.Database;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") mkdirSync(path.dirname(databasePath), { recursive: true });
    this.connection = new Database(databasePath);
    this.connection.pragma("foreign_keys = ON");
    this.connection.pragma("busy_timeout = 5000");
    if (databasePath !== ":memory:") {
      this.connection.pragma("journal_mode = WAL");
      this.connection.pragma("synchronous = FULL");
    }
    this.migrate();
  }

  close(): void {
    if (this.connection.open) this.connection.close();
  }

  private migrate(): void {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '0');
      INSERT OR IGNORE INTO meta(key, value) VALUES ('registry_version', '0');

      CREATE TABLE IF NOT EXISTS runtime_profiles (
        id TEXT PRIMARY KEY,
        profile_json TEXT NOT NULL,
        health_json TEXT NOT NULL,
        state TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        caller_scope TEXT NOT NULL,
        task TEXT NOT NULL,
        project_key TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        worktree_mode TEXT NOT NULL,
        routing_json TEXT NOT NULL,
        authority_json TEXT NOT NULL,
        recovery_policy TEXT NOT NULL,
        labels_json TEXT NOT NULL,
        status TEXT NOT NULL,
        registry_version INTEGER NOT NULL,
        current_incarnation_id TEXT,
        semantic_output_seen INTEGER NOT NULL DEFAULT 0,
        side_effects_seen INTEGER NOT NULL DEFAULT 0,
        pending_interaction_id TEXT,
        checkpoint_quality TEXT,
        last_event_sequence INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS incarnations (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        runtime_id TEXT NOT NULL REFERENCES runtime_profiles(id),
        thread_id TEXT,
        turn_id TEXT,
        status TEXT NOT NULL,
        terminal_reason TEXT,
        fencing_token INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS event_journal (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        backend_event_key TEXT UNIQUE,
        agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        incarnation_id TEXT REFERENCES incarnations(id) ON DELETE SET NULL,
        runtime_id TEXT,
        thread_id TEXT,
        turn_id TEXT,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS idempotency_records (
        caller_scope TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        operation_state TEXT NOT NULL,
        result_json TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY(caller_scope, tool_name, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS worktrees (
        canonical_path TEXT PRIMARY KEY,
        repository_id TEXT,
        head_sha TEXT,
        base_sha TEXT,
        dirty_at_registration INTEGER NOT NULL,
        registration_status TEXT NOT NULL,
        fencing_counter INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS worktree_leases (
        canonical_path TEXT PRIMARY KEY REFERENCES worktrees(canonical_path) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        incarnation_id TEXT NOT NULL REFERENCES incarnations(id) ON DELETE CASCADE,
        fencing_token INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        incarnation_id TEXT NOT NULL REFERENCES incarnations(id) ON DELETE CASCADE,
        quality TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pending_interactions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        incarnation_id TEXT NOT NULL REFERENCES incarnations(id) ON DELETE CASCADE,
        runtime_id TEXT NOT NULL,
        backend_request_id TEXT NOT NULL,
        method TEXT NOT NULL,
        kind TEXT NOT NULL,
        params_json TEXT NOT NULL,
        state TEXT NOT NULL,
        response_json TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE TABLE IF NOT EXISTS results (
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(agent_id, version)
      );

      CREATE TABLE IF NOT EXISTS routing_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        incarnation_id TEXT,
        decision_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS metrics (
        name TEXT PRIMARY KEY,
        value INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS platform_providers (
        id TEXT PRIMARY KEY,
        definition_json TEXT NOT NULL,
        definition_hash TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        authentication_json TEXT NOT NULL,
        entitlement_json TEXT NOT NULL,
        health_json TEXT NOT NULL,
        catalog_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS platform_models (
        gateway_id TEXT PRIMARY KEY,
        definition_json TEXT NOT NULL,
        definition_hash TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        compatibility_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS platform_operations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        state TEXT NOT NULL,
        progress REAL,
        message TEXT NOT NULL,
        actor TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        expected_version INTEGER,
        result_json TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(actor, kind, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS platform_event_journal (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        operation_id TEXT,
        actor TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS inference_requests (
        id TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL,
        caller_class TEXT NOT NULL,
        runtime_id TEXT,
        provider_id TEXT NOT NULL,
        account_ref_id TEXT,
        model_id TEXT NOT NULL,
        profile_hash TEXT NOT NULL,
        started_at TEXT NOT NULL,
        connected_at TEXT,
        first_semantic_at TEXT,
        completed_at TEXT,
        status TEXT NOT NULL,
        error_class TEXT,
        cancelled INTEGER NOT NULL DEFAULT 0,
        retry_count INTEGER NOT NULL DEFAULT 0,
        failover_count INTEGER NOT NULL DEFAULT 0,
        semantic_output_seen INTEGER NOT NULL DEFAULT 0,
        usage_json TEXT NOT NULL,
        flags_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS platform_usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL REFERENCES inference_requests(id) ON DELETE CASCADE,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cached_input_tokens INTEGER,
        reasoning_tokens INTEGER,
        estimated_input_tokens INTEGER,
        observed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS platform_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS agents_status_idx ON agents(status, updated_at);
      CREATE INDEX IF NOT EXISTS agents_project_idx ON agents(project_key, updated_at);
      CREATE INDEX IF NOT EXISTS incarnations_agent_idx ON incarnations(agent_id, created_at);
      CREATE INDEX IF NOT EXISTS incarnations_runtime_idx ON incarnations(runtime_id, status);
      CREATE INDEX IF NOT EXISTS events_agent_idx ON event_journal(agent_id, sequence);
      CREATE INDEX IF NOT EXISTS events_runtime_idx ON event_journal(runtime_id, sequence);
      CREATE INDEX IF NOT EXISTS results_agent_idx ON results(agent_id, version DESC);
      CREATE INDEX IF NOT EXISTS platform_events_target_idx ON platform_event_journal(target_type, target_id, sequence);
      CREATE INDEX IF NOT EXISTS platform_operations_state_idx ON platform_operations(state, updated_at);
      CREATE INDEX IF NOT EXISTS inference_requests_started_idx ON inference_requests(started_at DESC);
      CREATE INDEX IF NOT EXISTS inference_requests_provider_idx ON inference_requests(provider_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS platform_usage_provider_idx ON platform_usage_events(provider_id, observed_at DESC);
    `);

    const current = Number(
      (this.connection.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
        value: string;
      }).value
    );
    if (current > SCHEMA_VERSION) {
      throw new Error(`Database schema ${current} is newer than supported ${SCHEMA_VERSION}`);
    }
    this.connection
      .prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'")
      .run(String(SCHEMA_VERSION));
  }
}
