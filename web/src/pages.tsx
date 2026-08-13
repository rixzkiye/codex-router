import {
  Activity,
  AlertTriangle,
  Braces,
  CheckCircle2,
  ChevronRight,
  CircleOff,
  ClipboardCheck,
  FileCheck2,
  FileClock,
  FolderGit2,
  Gauge,
  Inbox,
  KeyRound,
  ListFilter,
  Play,
  Plus,
  RefreshCcw,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  SquareTerminal,
  TestTube2,
  UserRoundCheck,
  XCircle
} from "lucide-react";
import { type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ConsoleApi, ConsoleApiError, newIdempotencyKey } from "./api";
import {
  Button,
  CopyButton,
  EmptyState,
  Field,
  InlineNotice,
  MachineValue,
  Metric,
  Modal,
  QuotaBar,
  Section,
  StatusBadge,
  TextInput,
  TimeValue
} from "./components";
import { actionAvailability, exactTime, middleTruncate, STATUS_LABELS, stringifyPayload } from "./presentation";
import type {
  AgentDetail,
  AgentResult,
  AgentStatus,
  AgentSummary,
  BootstrapDto,
  ConnectionState,
  Interaction,
  RouterEvent,
  RuntimeDto,
  WorktreeDto
} from "./types";

export interface PageProps {
  api: ConsoleApi;
  data: BootstrapDto;
  connection: ConnectionState;
  navigate: (href: string) => void;
  refresh: () => Promise<void>;
}

export function OverviewPage({ data, navigate }: PageProps) {
  const active = data.agents.filter((agent) => !["completed", "failed", "interrupted"].includes(agent.status)).slice(0, 7);
  const recent = data.agents.filter((agent) => ["completed", "failed", "interrupted"].includes(agent.status)).slice(0, 5);
  const leases = data.diagnostics.writerLeases;
  return (
    <Page title="Overview" eyebrow="Fleet pulse" description="What needs you now, followed by the current operating picture.">
      {data.interactions.length > 0 ? (
        <button className="attention-strip pressable" onClick={() => navigate("/attention")}>
          <span className="attention-strip__icon"><Inbox aria-hidden="true" /></span>
          <span><strong>{data.interactions.length} decision{data.interactions.length === 1 ? "" : "s"} waiting</strong><small>Approvals and requested input remain durable until resolved.</small></span>
          <ChevronRight aria-hidden="true" />
        </button>
      ) : (
        <div className="quiet-strip"><CheckCircle2 aria-hidden="true" /><span>No pending human decisions</span></div>
      )}

      <div className="metric-grid" role="group" aria-label="Fleet summary">
        <Metric label="Active" value={data.summary.active} detail="non-terminal agents" />
        <Metric label="Needs attention" value={data.summary.attention} detail="durable inbox items" tone={data.summary.attention ? "attention" : "neutral"} />
        <Metric label="Runtime capacity" value={`${data.summary.runtimeReady}/${data.summary.runtimeTotal}`} detail="ready runtimes" />
        <Metric label="Terminal" value={data.summary.terminal} detail="recorded outcomes" />
      </div>

      <div className="overview-grid">
        <Section title="Active agents" description="Stable order; live updates never move the row you are reading." action={<Button variant="quiet" onClick={() => navigate("/agents")}>View all</Button>}>
          {active.length ? <AgentList agents={active} navigate={navigate} compact /> : <MiniEmpty title="No active agents" detail="Start an agent when work is ready to run." />}
        </Section>
        <Section title="Runtime capacity" description="Health and load remain separate signals." action={<Button variant="quiet" onClick={() => navigate("/runtimes")}>Inspect fleet</Button>}>
          <div className="runtime-stack">
            {data.runtimes.map((runtime) => <RuntimeStrip key={runtime.id} runtime={runtime} navigate={navigate} />)}
            {data.runtimes.length === 0 ? <MiniEmpty title="No runtimes configured" detail="Add a runtime profile before starting work." /> : null}
          </div>
        </Section>
      </div>

      <div className="overview-grid overview-grid--lower">
        <Section title="Recent outcomes" description="Worker reports and observed evidence are reviewed separately.">
          {recent.length ? <AgentList agents={recent} navigate={navigate} compact /> : <MiniEmpty title="No outcomes yet" detail="Completed, failed, and interrupted agents appear here." />}
        </Section>
        <Section title="Writer leases" description="One persisted owner and a monotonically increasing fencing token.">
          {leases.length ? (
            <div className="lease-list">
              {leases.slice(0, 5).map((lease, index) => (
                <div className="lease-row" key={String(lease.incarnationId ?? index)}>
                  <FolderGit2 aria-hidden="true" />
                  <div><code>{middleTruncate(String(lease.path ?? "Unknown path"), 36)}</code><small>Token {String(lease.fencingToken ?? "unknown")}</small></div>
                  <TimeValue value={String(lease.expiresAt)} />
                </div>
              ))}
            </div>
          ) : <MiniEmpty title="No active writer leases" detail="Healthy read-only operation stays quiet." />}
        </Section>
      </div>
    </Page>
  );
}

export function AgentsPage({ data, navigate }: PageProps) {
  const params = new URLSearchParams(window.location.search);
  const initialStatus = params.get("status") ?? "all";
  const initialRuntime = params.get("runtime") ?? "all";
  const [status, setStatus] = useState(initialStatus);
  const [runtime, setRuntime] = useState(initialRuntime);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const filtered = useMemo(() => data.agents.filter((agent) => {
    if (status !== "all" && agent.status !== status) return false;
    if (runtime !== "all" && agent.runtime?.id !== runtime) return false;
    const haystack = `${agent.id} ${agent.taskSummary} ${agent.projectKey} ${agent.worktree.path}`.toLowerCase();
    return !query || haystack.includes(query.toLowerCase());
  }), [data.agents, query, runtime, status]);

  const updateFilter = (nextStatus: string, nextRuntime: string) => {
    const search = new URLSearchParams();
    if (nextStatus !== "all") search.set("status", nextStatus);
    if (nextRuntime !== "all") search.set("runtime", nextRuntime);
    history.replaceState(history.state, "", `/agents${search.size ? `?${search}` : ""}`);
  };
  return (
    <Page title="Agents" eyebrow="Fleet management" description="Filter, compare, and monitor logical agents without flattening their execution identity." actions={<Button variant="primary" onClick={() => navigate("/agents/new")}><Plus aria-hidden="true" />Start agent</Button>}>
      <div className="filter-bar" role="group" aria-label="Agent filters">
        <label className="search-field"><Search aria-hidden="true" /><span className="sr-only">Search agents</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search task, project, worktree, or exact ID" /></label>
        <label><span className="sr-only">Status</span><select value={status} onChange={(event) => { setStatus(event.target.value); updateFilter(event.target.value, runtime); }}><option value="all">All statuses</option>{Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label><span className="sr-only">Runtime</span><select value={runtime} onChange={(event) => { setRuntime(event.target.value); updateFilter(status, event.target.value); }}><option value="all">All runtimes</option>{data.runtimes.map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}</select></label>
        <Button variant="secondary" disabled={selected.size === 0} onClick={() => navigate(`/agents/monitor?ids=${encodeURIComponent([...selected].join(","))}`)}><Activity aria-hidden="true" />Monitor {selected.size || ""}</Button>
      </div>
      <div className="table-wrap">
        <table className="data-table agent-table">
          <thead><tr><th className="select-cell"><span className="sr-only">Select</span></th><th>Status</th><th>Agent</th><th>Project / worktree</th><th>Runtime</th><th>Updated</th><th><span className="sr-only">Open</span></th></tr></thead>
          <tbody>
            {filtered.map((agent) => (
              <tr key={agent.id} className={selected.has(agent.id) ? "is-selected" : ""}>
                <td className="select-cell"><input type="checkbox" aria-label={`Select ${agent.taskSummary}`} checked={selected.has(agent.id)} onChange={() => setSelected((current) => { const next = new Set(current); next.has(agent.id) ? next.delete(agent.id) : next.add(agent.id); return next; })} /></td>
                <td><StatusBadge status={agent.status} /></td>
                <td><button className="row-link" onClick={() => navigate(`/agents/${encodeURIComponent(agent.id)}`)}><strong>{agent.taskSummary}</strong><code>{middleTruncate(agent.id, 24)}</code></button></td>
                <td><strong>{agent.projectKey}</strong><small>{middleTruncate(agent.worktree.path, 34)} · {agent.worktree.mode === "read_only" ? "read-only" : "write"}</small></td>
                <td>{agent.runtime ? <><strong>{agent.runtime.id}</strong><small>{agent.runtime.provider} · {agent.runtime.model ?? "default model"}</small></> : <span className="muted">Not allocated</span>}</td>
                <td><TimeValue value={agent.updatedAt} /></td>
                <td><button className="row-chevron" aria-label={`Open ${agent.taskSummary}`} onClick={() => navigate(`/agents/${encodeURIComponent(agent.id)}`)}><ChevronRight aria-hidden="true" /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 ? <EmptyState icon={<ListFilter />} title="No agents match this view" description="Adjust filters or start a new logical agent." action={<Button onClick={() => { setStatus("all"); setRuntime("all"); setQuery(""); updateFilter("all", "all"); }}>Clear filters</Button>} /> : null}
      </div>
    </Page>
  );
}

export function MonitorPage({ data, navigate }: PageProps) {
  const selectedIds = new URLSearchParams(window.location.search).get("ids")?.split(",").filter(Boolean) ?? [];
  const [mode, setMode] = useState<"any" | "all">("any");
  const [wake, setWake] = useState("terminal");
  const agents = selectedIds.map((id) => data.agents.find((agent) => agent.id === id)).filter(Boolean) as AgentSummary[];
  const satisfied = (agent: AgentSummary) => wake === "terminal" ? ["completed", "failed", "interrupted"].includes(agent.status) : wake === "needs_attention" ? agent.status === "needs_attention" : wake === "handoff" ? ["handing_off", "waiting_for_reset"].includes(agent.status) : agent.registryVersion > 0;
  const complete = mode === "all" ? agents.length > 0 && agents.every(satisfied) : agents.some(satisfied);
  return (
    <Page title="Multi-agent monitor" eyebrow="Durable wait view" description={`Watching ${agents.length} logical agent${agents.length === 1 ? "" : "s"} from registry version ${data.router.registryVersion}.`}>
      <div className="filter-bar">
        <label>Completion<select value={mode} onChange={(event) => setMode(event.target.value as "any" | "all")}><option value="any">Any agent</option><option value="all">All agents</option></select></label>
        <label>Wake condition<select value={wake} onChange={(event) => setWake(event.target.value)}><option value="terminal">Terminal</option><option value="needs_attention">Needs attention</option><option value="handoff">Handoff</option><option value="status_change">Any status change</option></select></label>
      </div>
      {complete ? <InlineNotice tone="success" title="Monitor condition satisfied">The remaining agents stay visible and continue receiving live updates.</InlineNotice> : null}
      {agents.length ? <div className="monitor-grid">{agents.map((agent) => <button className="monitor-card pressable" key={agent.id} onClick={() => navigate(`/agents/${encodeURIComponent(agent.id)}`)}><div><StatusBadge status={agent.status} />{satisfied(agent) ? <span className="satisfied"><ClipboardCheck aria-hidden="true" />Satisfied</span> : <span className="muted">Waiting</span>}</div><h2>{agent.taskSummary}</h2><MachineValue value={agent.id} label="Agent ID" /><small>Updated <TimeValue value={agent.updatedAt} /></small></button>)}</div> : <EmptyState icon={<Activity />} title="Choose agents to monitor" description="Select up to 100 agents from the fleet list." action={<Button onClick={() => navigate("/agents")}>Open agents</Button>} />}
    </Page>
  );
}

export function NewAgentPage({ api, data, connection, navigate }: PageProps) {
  const [task, setTask] = useState("");
  const [projectKey, setProjectKey] = useState("");
  const [worktreePath, setWorktreePath] = useState("");
  const [mode, setMode] = useState<"write" | "read_only">("read_only");
  const [tier, setTier] = useState("worker");
  const [runtimeId, setRuntimeId] = useState("");
  const [model, setModel] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [authority, setAuthority] = useState({ allowPush: false, allowMerge: false, allowDeploy: false, allowExternalWrites: false });
  const [recoveryPolicy, setRecoveryPolicy] = useState("manual");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idempotencyKey = useRef(newIdempotencyKey());
  const dirty = Boolean(task || projectKey || worktreePath);
  useEffect(() => {
    document.documentElement.dataset.composerDirty = String(dirty);
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      delete document.documentElement.dataset.composerDirty;
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [dirty]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!task.trim() || !projectKey.trim() || !worktreePath.trim()) { setError("Objective, project key, and worktree path are required."); return; }
    setPending(true);
    try {
      const result = await api.mutate<{ agentId: string }>("/api/v1/agents", "POST", {
        idempotencyKey: idempotencyKey.current,
        task,
        projectKey,
        worktree: { path: worktreePath, mode },
        routing: { capabilityTier: tier, ...(runtimeId ? { preferredRuntimeId: runtimeId } : {}), ...(model ? { model } : {}) },
        authority,
        recoveryPolicy,
        labels: {}
      });
      document.documentElement.dataset.composerDirty = "false";
      navigate(`/agents/${encodeURIComponent(result.agentId)}`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally { setPending(false); }
  };
  return (
    <Page title="Start agent" eyebrow="New logical agent" description="Define the objective and authority once. Start returns after durable acknowledgement, never after task completion.">
      <form className="composer" onSubmit={submit}>
        {error ? <InlineNotice tone="danger" title="Agent was not started">{error}</InlineNotice> : null}
        <ComposerSection number="01" title="Objective" description="The task is retained as immutable policy input.">
          <Field label="Task objective" hint={`${task.length.toLocaleString()} / 200,000 characters`}><textarea className="textarea textarea--large" value={task} onChange={(event) => setTask(event.target.value)} placeholder="Describe the outcome, constraints, and evidence required…" maxLength={200_000} /></Field>
        </ComposerSection>
        <ComposerSection number="02" title="Project and worktree" description="Server-side canonicalization and allowed-root validation remain authoritative.">
          <div className="form-grid"><Field label="Project key"><TextInput value={projectKey} onChange={(event) => setProjectKey(event.target.value)} placeholder="codex-router" /></Field><Field label="Canonical worktree path"><TextInput value={worktreePath} onChange={(event) => setWorktreePath(event.target.value)} placeholder="/absolute/path/to/worktree" /></Field></div>
          <div className="segmented" role="radiogroup" aria-label="Worktree mode"><label><input type="radio" name="mode" checked={mode === "read_only"} onChange={() => setMode("read_only")} /><span>Read-only<small>Observe and report without acquiring a writer lease.</small></span></label><label><input type="radio" name="mode" checked={mode === "write"} onChange={() => setMode("write")} /><span>Write<small>Acquire one exclusive, fenced writer lease.</small></span></label></div>
        </ComposerSection>
        <ComposerSection number="03" title="Routing" description="Choose a capability tier; runtime identity remains explicit after allocation.">
          <div className="form-grid"><Field label="Capability tier"><select value={tier} onChange={(event) => setTier(event.target.value)}><option value="worker">Worker</option><option value="senior">Senior</option><option value="principal">Principal</option><option value="architect">Architect</option></select></Field><Field label="Recovery policy"><select value={recoveryPolicy} onChange={(event) => setRecoveryPolicy(event.target.value)}><option value="manual">Manual</option><option value="wait_for_reset">Wait for affine runtime reset</option><option value="auto_handoff_if_clean">Automatic clean handoff</option></select></Field></div>
          <button type="button" className="disclosure" aria-expanded={advanced} onClick={() => setAdvanced((value) => !value)}><Settings2 aria-hidden="true" />Advanced routing<ChevronRight aria-hidden="true" /></button>
          {advanced ? <div className="form-grid advanced-panel"><Field label="Preferred runtime" hint="Exact preference may fail closed if ineligible."><select value={runtimeId} onChange={(event) => setRuntimeId(event.target.value)}><option value="">Router selected</option>{data.runtimes.map((runtime) => <option key={runtime.id} value={runtime.id}>{runtime.id} · {runtime.health.state}</option>)}</select></Field><Field label="Exact model" hint="Availability comes from the selected runtime; unknown models fail closed."><TextInput value={model} onChange={(event) => setModel(event.target.value)} placeholder="Leave blank for runtime policy" /></Field></div> : null}
        </ComposerSection>
        <ComposerSection number="04" title="Authority" description="All external authority is false by default and cannot be broadened by continuation.">
          <div className="authority-grid">{([ ["allowPush", "Push", "Push a task branch or open a pull request."], ["allowMerge", "Merge", "Merge only through an explicitly authorized workflow."], ["allowDeploy", "Deploy", "Trigger a deployment or release."], ["allowExternalWrites", "External writes", "Mutate systems outside the worktree."] ] as const).map(([key, label, detail]) => <label className="check-card" key={key}><input type="checkbox" checked={authority[key]} onChange={(event) => setAuthority((current) => ({ ...current, [key]: event.target.checked }))} /><span><strong>{label}</strong><small>{detail}</small></span></label>)}</div>
        </ComposerSection>
        <ComposerSection number="05" title="Review" description="Advanced defaults remain visible even when their controls are collapsed.">
          <dl className="review-grid"><ReviewItem term="Project" value={projectKey || "Not set"} /><ReviewItem term="Worktree" value={`${worktreePath || "Not set"} · ${mode}`} /><ReviewItem term="Routing" value={`${tier} · ${runtimeId || "router selected"} · ${model || "runtime default"}`} /><ReviewItem term="Recovery" value={recoveryPolicy.replaceAll("_", " ")} /><ReviewItem term="Granted authority" value={Object.entries(authority).filter(([, granted]) => granted).map(([key]) => key.replace("allow", "")).join(", ") || "None"} /></dl>
        </ComposerSection>
        <div className="composer__submit"><span>{connection === "live" ? "Ready to submit with a stable idempotency key." : "Reconnect to current durable state before starting work."}</span><Button variant="primary" type="submit" pending={pending} disabled={connection !== "live"}><Play aria-hidden="true" />Start agent</Button></div>
      </form>
    </Page>
  );
}

export function AgentDetailPage({ api, data, connection, navigate }: PageProps & { agentId: string }) {
  const agentId = decodeURIComponent(window.location.pathname.split("/")[2] ?? "");
  const tab = new URLSearchParams(window.location.search).get("tab") ?? "activity";
  const resource = useResource(`agent:${agentId}:${data.router.registryVersion}`, async () => {
    const [agent, events, results] = await Promise.all([
      api.get<AgentDetail>(`/api/v1/agents/${encodeURIComponent(agentId)}`),
      api.get<{ events: RouterEvent[] }>(`/api/v1/agents/${encodeURIComponent(agentId)}/events?limit=160`),
      api.get<{ results: AgentResult[] }>(`/api/v1/agents/${encodeURIComponent(agentId)}/results`)
    ]);
    return { agent, events: events.events, results: results.results };
  });
  const [action, setAction] = useState<"steer" | "continue" | "cancel" | "handoff" | null>(null);
  if (resource.error) return <Page title="Agent unavailable"><ErrorState error={resource.error} retry={resource.reload} /></Page>;
  if (!resource.value) return <Page title="Loading agent"><LoadingRows /></Page>;
  const { agent, events, results } = resource.value;
  const setTab = (value: string) => navigate(`/agents/${encodeURIComponent(agent.id)}?tab=${value}`);
  return (
    <Page title={agent.taskSummary} eyebrow={`${agent.projectKey} · ${agent.worktree.mode === "write" ? "write worktree" : "read-only worktree"}`} description={agent.worktree.path} actions={<div className="page-actions"><Button variant="primary" disabled={!actionAvailability(agent, agent.status === "running" ? "steer" : "view_result").available} onClick={() => agent.status === "running" ? setAction("steer") : setTab("result")}>{agent.status === "running" ? "Steer active turn" : "View result"}</Button><Button onClick={() => setAction("handoff")} disabled={!actionAvailability(agent, "handoff").available}>Handoff</Button></div>}>
      <div className="agent-identity">
        <StatusBadge status={agent.status} />
        <MachineValue value={agent.id} label="Logical agent ID" length={34} />
        <span className="identity-separator" />
        <MachineValue value={agent.activeIncarnation?.id} label="Active incarnation ID" length={28} />
        <MachineValue value={agent.activeIncarnation?.threadId} label="Thread ID" length={24} />
        <MachineValue value={agent.activeIncarnation?.turnId} label="Turn ID" length={24} />
        <span className="freshness">Updated <TimeValue value={agent.updatedAt} /></span>
      </div>
      {agent.status === "cancelling" ? <InlineNotice tone="warning" title="Cancellation requested">Waiting for terminal confirmation from the runtime.</InlineNotice> : null}
      {agent.checkpointQuality === "unclean" ? <InlineNotice tone="warning" title="Latest checkpoint is unclean">Inspect the recorded checkpoint before authorizing another handoff.</InlineNotice> : null}
      <div className="tabs" role="tablist" aria-label="Agent detail sections">{["activity", "result", "evidence", "incarnations", "policy"].map((value) => <button key={value} id={`agent-tab-${value}`} data-tab={value} role="tab" tabIndex={tab === value ? 0 : -1} aria-selected={tab === value} aria-controls={`agent-panel-${value}`} onKeyDown={(event) => handleTabKey(event, ["activity", "result", "evidence", "incarnations", "policy"], tab, setTab)} onClick={() => setTab(value)}>{value.charAt(0).toUpperCase() + value.slice(1)}</button>)}</div>
      <div role="tabpanel" id={`agent-panel-${tab}`} aria-labelledby={`agent-tab-${tab}`}>
        {tab === "activity" ? <ActivityTab events={events} /> : null}
        {tab === "result" ? <ResultTab results={results} /> : null}
        {tab === "evidence" ? <EvidenceTab result={results[0]} /> : null}
        {tab === "incarnations" ? <IncarnationsTab agent={agent} /> : null}
        {tab === "policy" ? <PolicyTab agent={agent} /> : null}
      </div>
      <div className="action-dock" role="toolbar" aria-label="Agent actions">
        <Button onClick={() => setAction("steer")} disabled={!actionAvailability(agent, "steer").available}>Steer</Button>
        <Button onClick={() => setAction("continue")} disabled={!actionAvailability(agent, "continue").available}>Continue</Button>
        <Button onClick={() => setAction("cancel")} disabled={!actionAvailability(agent, "cancel").available}>Cancel</Button>
        <Button onClick={() => setAction("handoff")} disabled={!actionAvailability(agent, "handoff").available}>Handoff</Button>
      </div>
      <AgentActionModal api={api} agent={agent} action={action} connection={connection} onClose={() => setAction(null)} onAccepted={() => { setAction(null); resource.reload(); }} />
    </Page>
  );
}

export function AttentionPage({ api, data, connection, navigate, refresh }: PageProps) {
  const [selected, setSelected] = useState<Interaction | null>(null);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const respond = async (response: Record<string, unknown>) => {
    if (!selected) return;
    setPending(true); setError(null);
    try {
      await api.mutate(`/api/v1/interactions/${encodeURIComponent(selected.id)}/respond`, "POST", { idempotencyKey: newIdempotencyKey(), response });
      setSelected(null); setInput(""); await refresh();
    } catch (caught) { setError(errorMessage(caught)); } finally { setPending(false); }
  };
  return (
    <Page title="Attention" eyebrow="Durable inbox" description="One place for approvals, requested input, recovery conflicts, and unsafe handoffs.">
      {data.interactions.length ? <div className="attention-list">{data.interactions.map((item) => {
        const agent = data.agents.find((candidate) => candidate.id === item.agentId);
        return <button key={item.id} className="attention-item pressable" onClick={() => { setSelected(item); setError(null); }}><span className="attention-item__kind">{item.kind === "approval" ? <ShieldCheck aria-hidden="true" /> : <Braces aria-hidden="true" />}{item.kind === "approval" ? "Approval" : "User input"}</span><span><strong>{agent?.taskSummary ?? item.agentId}</strong><small>{item.runtimeId} · {agent?.projectKey ?? "Unknown project"}</small></span><span><TimeValue value={item.createdAt} /><ChevronRight aria-hidden="true" /></span></button>;
      })}</div> : <EmptyState icon={<Inbox />} title="Attention inbox is clear" description="New approval and input requests remain here until durably resolved." action={<Button onClick={() => navigate("/agents")}>Browse agents</Button>} />}
      <Modal open={Boolean(selected)} onClose={() => { if (!pending) setSelected(null); }} title={selected?.kind === "approval" ? "Review command approval" : "Provide requested input"} description={selected ? `This response applies only to interaction ${middleTruncate(selected.id, 24)}.` : undefined} footer={selected?.kind === "approval" ? <><Button onClick={() => void respond({ type: "approval", decision: "deny" })} disabled={connection !== "live"} pending={pending}>Deny</Button><Button variant="primary" onClick={() => void respond({ type: "approval", decision: "approve_once" })} disabled={connection !== "live"} pending={pending}>Approve once</Button></> : <Button variant="primary" onClick={() => void respond({ type: "user_input", input })} disabled={!input.trim() || connection !== "live"} pending={pending}>Send response</Button>}>
        {error ? <InlineNotice tone="danger" title="Response not accepted">{error}</InlineNotice> : null}
        {selected ? <><dl className="detail-list"><ReviewItem term="Agent" value={selected.agentId} /><ReviewItem term="Runtime" value={selected.runtimeId} /><ReviewItem term="Requested" value={exactTime(selected.createdAt)} /></dl><pre className="payload-preview">{stringifyPayload(selected.params)}</pre>{selected.kind === "user_input" ? <Field label="Response" hint={`${input.length.toLocaleString()} / 100,000 characters`}><textarea autoFocus className="textarea" value={input} onChange={(event) => setInput(event.target.value)} maxLength={100_000} /></Field> : <InlineNotice tone="warning" title="One request, one decision">Approval cannot broaden the agent's original authority envelope. “Always approve” is not available.</InlineNotice>}</> : null}
      </Modal>
    </Page>
  );
}

export function RuntimesPage({ data, navigate }: PageProps) {
  return (
    <Page title="Runtimes" eyebrow="Execution fleet" description="Health, load, quota, model policy, and credential boundary stay independently visible.">
      {data.runtimes.length ? <div className="runtime-grid">{data.runtimes.map((runtime) => <button className="runtime-card pressable" key={runtime.id} onClick={() => navigate(`/runtimes/${encodeURIComponent(runtime.id)}`)}><div className="runtime-card__header"><span className="runtime-mark"><Server aria-hidden="true" /></span><div><h2>{runtime.id}</h2><p>{runtime.provider} · {runtime.adapter.replaceAll("_", " ")}</p></div><StatusBadge status={runtime.health.state} /></div><div className="runtime-card__load"><span>Concurrency</span><strong>{runtime.activeCount}<small> / {runtime.maxConcurrency}</small></strong></div><QuotaBar value={runtime.health.quota?.primary?.usedPercent} reset={runtime.health.quota?.primary?.resetsAt} label="Primary quota" /><div className="runtime-card__footer"><span>{runtime.authentication.status.replaceAll("_", " ")}</span><span>{runtime.modelPolicy.defaultModel ?? "No default model"}</span><ChevronRight aria-hidden="true" /></div></button>)}</div> : <EmptyState icon={<Server />} title="No runtimes configured" description="Add a runtime profile in the router configuration. Raw credentials never belong in the Console." />}
    </Page>
  );
}

export function RuntimeDetailPage({ data, navigate }: PageProps & { runtimeId: string }) {
  const runtimeId = decodeURIComponent(window.location.pathname.split("/")[2] ?? "");
  const runtime = data.runtimes.find((item) => item.id === runtimeId);
  const tab = new URLSearchParams(window.location.search).get("tab") ?? "overview";
  if (!runtime) return <Page title="Runtime unavailable"><EmptyState icon={<Server />} title="Runtime not found" description="The runtime may have been removed or is outside your visibility." /></Page>;
  return (
    <Page title={runtime.id} eyebrow={`${runtime.provider} · ${runtime.adapter.replaceAll("_", " ")}`} description={`Credential boundary: ${runtime.authentication.reference ?? "provider managed"}`} actions={<StatusBadge status={runtime.health.state} />}>
      <div className="tabs" role="tablist" aria-label="Runtime sections">{["overview", "models", "authentication"].map((value) => <button key={value} id={`runtime-tab-${value}`} data-tab={value} role="tab" tabIndex={tab === value ? 0 : -1} aria-selected={tab === value} aria-controls={`runtime-panel-${value}`} onKeyDown={(event) => handleTabKey(event, ["overview", "models", "authentication"], tab, (next) => navigate(`/runtimes/${encodeURIComponent(runtime.id)}?tab=${next}`))} onClick={() => navigate(`/runtimes/${encodeURIComponent(runtime.id)}?tab=${value}`)}>{value.charAt(0).toUpperCase() + value.slice(1)}</button>)}</div>
      <div role="tabpanel" id={`runtime-panel-${tab}`} aria-labelledby={`runtime-tab-${tab}`}>{tab === "overview" ? <RuntimeOverview runtime={runtime} /> : tab === "models" ? <RuntimeModels runtime={runtime} /> : <RuntimeAuthentication runtime={runtime} />}</div>
    </Page>
  );
}

export function WorktreesPage({ api, data }: PageProps) {
  const resource = useResource(`worktrees:${data.router.registryVersion}`, () => api.get<{ worktrees: WorktreeDto[] }>("/api/v1/worktrees"));
  return <Page title="Worktrees" eyebrow="Lease authority" description="Canonical paths, observed Git state, lease owners, and fencing tokens.">{resource.error ? <ErrorState error={resource.error} retry={resource.reload} /> : !resource.value ? <LoadingRows /> : resource.value.worktrees.length ? <div className="worktree-list">{resource.value.worktrees.map((worktree) => <article className="worktree-row" key={worktree.canonicalPath}><div className="worktree-icon"><FolderGit2 aria-hidden="true" /></div><div className="worktree-main"><h2>{middleTruncate(worktree.canonicalPath, 70)}<CopyButton value={worktree.canonicalPath} label="Copy canonical path" /></h2><p>{worktree.repositoryId ?? "Repository identity unavailable"}</p><div className="token-row"><Token label="Registration" value={worktree.registrationStatus} /><Token label="Dirty" value={worktree.dirtyAtRegistration ? "Observed dirty" : "Observed clean"} tone={worktree.dirtyAtRegistration ? "warning" : "neutral"} /><Token label="Head" value={worktree.headSha ? middleTruncate(worktree.headSha, 18) : "Unknown"} /></div></div><div className="worktree-lease">{worktree.lease ? <><strong>Writer leased</strong><MachineValue value={worktree.lease.agentId} label="Lease owner agent" length={22} /><span>Fencing token <code>{worktree.lease.fencingToken}</code></span><small>Expires <TimeValue value={worktree.lease.expiresAt} /></small></> : <><span className="no-lease"><CircleOff aria-hidden="true" />No writer lease</span><small>Counter {worktree.fencingCounter}</small></>}</div></article>)}</div> : <EmptyState icon={<FolderGit2 />} title="No registered worktrees" description="A path is registered after server-side canonical validation during agent start." />}</Page>;
}

export function EventsPage({ api, data, navigate }: PageProps) {
  const [type, setType] = useState("");
  const resource = useResource(`events:${data.router.registryVersion}:${type}`, () => api.get<{ events: RouterEvent[] }>(`/api/v1/events?limit=200${type ? `&eventType=${encodeURIComponent(type)}` : ""}`));
  const eventTypes = Object.keys(data.diagnostics.eventsByType);
  return <Page title="Event journal" eyebrow="Ordered audit" description="Bounded, redacted events in append order—not a raw transcript firehose." actions={<label><span className="sr-only">Event type</span><select value={type} onChange={(event) => setType(event.target.value)}><option value="">All event types</option>{eventTypes.map((value) => <option key={value}>{value}</option>)}</select></label>}>{resource.error ? <ErrorState error={resource.error} retry={resource.reload} /> : !resource.value ? <LoadingRows /> : <div className="timeline">{resource.value.events.map((event) => <article className="timeline-item" key={event.eventId}><div className="timeline-item__rail"><span /></div><div className="timeline-item__body"><div className="timeline-item__top"><Token label="Event" value={event.type.replaceAll("_", " ")} /><time dateTime={event.occurredAt}>{exactTime(event.occurredAt)}</time></div><h2>{eventConsequence(event)}</h2><div className="timeline-identities"><span>Sequence <code>{event.sequence}</code></span>{event.runtimeId ? <span>Runtime <code>{event.runtimeId}</code></span> : null}{event.agentId ? <button onClick={() => navigate(`/agents/${encodeURIComponent(event.agentId!)}`)}>Agent <code>{middleTruncate(event.agentId, 20)}</code></button> : null}</div><details><summary>Redacted payload</summary><pre className="payload-preview">{stringifyPayload(event.payload)}</pre></details></div></article>)}</div>}</Page>;
}

export function SettingsPage({ api, data, navigate }: PageProps) {
  const section = window.location.pathname.split("/")[2] ?? "runtimes";
  const config = useResource("config", () => api.get<Record<string, unknown>>("/api/v1/config"));
  const sections = [
    ["runtimes", "Runtime profiles", Server], ["models", "Models", Gauge], ["credentials", "Credentials", KeyRound], ["worktrees", "Allowed roots", FolderGit2], ["policies", "Policies", ShieldCheck], ["retention", "Retention", FileClock], ["diagnostics", "Diagnostics", SquareTerminal]
  ] as const;
  return <Page title="Settings" eyebrow="Administration" description="Validated policy and secret references only; raw credential material never enters this surface."><div className="settings-layout"><nav className="settings-nav" aria-label="Settings sections">{sections.map(([id, label, Icon]) => <button key={id} aria-current={section === id ? "page" : undefined} onClick={() => navigate(`/settings/${id}`)}><Icon aria-hidden="true" />{label}</button>)}</nav><div className="settings-content">{section === "diagnostics" ? <DiagnosticsPanel data={data} /> : section === "models" ? <FleetModels data={data} navigate={navigate} /> : section === "credentials" ? <FleetCredentials data={data} navigate={navigate} /> : section === "runtimes" ? <RuntimeSettings data={data} navigate={navigate} /> : config.error ? <ErrorState error={config.error} retry={config.reload} /> : !config.value ? <LoadingRows /> : <ConfigPanel section={section} config={config.value} />}</div></div></Page>;
}

function ActivityTab({ events }: { events: RouterEvent[] }) {
  return <Section title="Ordered activity" description="Normalized semantic events only. Hidden reasoning and unbounded terminal bytes are excluded.">{events.length ? <div className="timeline timeline--compact">{events.map((event) => <article className="timeline-item" key={event.eventId}><div className="timeline-item__rail"><span /></div><div className="timeline-item__body"><div className="timeline-item__top"><Token label="Event" value={event.type.replaceAll("_", " ")} /><TimeValue value={event.occurredAt} /></div><h2>{eventConsequence(event)}</h2><div className="timeline-identities">{event.incarnationId ? <span>Incarnation <code>{middleTruncate(event.incarnationId, 22)}</code></span> : null}{event.turnId ? <span>Turn <code>{middleTruncate(event.turnId, 20)}</code></span> : null}</div><details><summary>Show bounded payload</summary><pre className="payload-preview">{stringifyPayload(event.payload)}</pre></details></div></article>)}</div> : <MiniEmpty title="No durable activity yet" detail="Queued work can exist before a runtime accepts a turn." />}</Section>;
}

function ResultTab({ results }: { results: AgentResult[] }) {
  const [version, setVersion] = useState(results[0]?.resultVersion ?? 0);
  const result = results.find((item) => item.resultVersion === version) ?? results[0];
  if (!result) return <EmptyState icon={<FileCheck2 />} title="No versioned result" description="A result appears only after a terminal event is observed and distilled." />;
  return <div className="result-layout"><Section title="Worker report" description="Authored by the worker; claims below are not independently confirmed." action={<select aria-label="Result version" value={version} onChange={(event) => setVersion(Number(event.target.value))}>{results.map((item) => <option key={item.resultVersion} value={item.resultVersion}>Version {item.resultVersion}</option>)}</select>} className="reported-section"><div className="section-kicker"><UserRoundCheck aria-hidden="true" />Reported</div><p className="result-summary">{result.reported.summary || "No worker summary was reported."}</p><ResultLists result={result} /></Section><Section title="Observed evidence" description="Collected independently from runtime events and the actual worktree." className="observed-section"><div className="section-kicker"><FileCheck2 aria-hidden="true" />Observed</div><EvidenceBody result={result} /></Section>{result.unverified.length ? <Section title="Unverified items" description="Claims without matching router observation."><ul className="bullet-list">{result.unverified.map((item) => <li key={item}>{item}</li>)}</ul></Section> : null}</div>;
}

function EvidenceTab({ result }: { result: AgentResult | undefined }) {
  return <Section title="Observed evidence" description="Git state, changed files, tests, and terminal errors come from router observation.">{result ? <EvidenceBody result={result} detailed /> : <EmptyState icon={<TestTube2 />} title="No observed evidence" description="No result version exists for this logical agent." />}</Section>;
}

function IncarnationsTab({ agent }: { agent: AgentDetail }) {
  return <Section title="Incarnation history" description="A cross-runtime handoff creates a new incarnation and thread; it is never called a session migration."><div className="incarnation-rail">{agent.incarnations.map((incarnation, index) => <article key={incarnation.id}><div className="incarnation-index">{String(index + 1).padStart(2, "0")}</div><div><div className="incarnation-title"><h2>{incarnation.runtimeId}</h2><Token label="State" value={incarnation.status.replaceAll("_", " ")} /></div><dl className="detail-list"><ReviewItem term="Incarnation" value={incarnation.id} /><ReviewItem term="Thread" value={incarnation.threadId ?? "Not assigned"} /><ReviewItem term="Turn" value={incarnation.turnId ?? "Not assigned"} /><ReviewItem term="Terminal reason" value={incarnation.terminalReason ?? "Not terminal"} /><ReviewItem term="Fencing token" value={incarnation.fencingToken?.toString() ?? "Not applicable"} /><ReviewItem term="Started" value={exactTime(incarnation.createdAt)} /></dl></div></article>)}</div></Section>;
}

function PolicyTab({ agent }: { agent: AgentDetail }) {
  return <div className="policy-grid"><Section title="Immutable task" description="Original task input retained for this logical agent."><pre className="task-body">{agent.task}</pre></Section><Section title="Effective policy" description="Recorded routing, authority, recovery, and caller scope."><dl className="detail-list"><ReviewItem term="Caller scope" value={agent.callerScope} /><ReviewItem term="Capability tier" value={agent.routing.capabilityTier ?? "Not constrained"} /><ReviewItem term="Preferred runtime" value={agent.routing.preferredRuntimeId ?? "Router selected"} /><ReviewItem term="Exact model" value={agent.routing.model ?? "Runtime policy"} /><ReviewItem term="Recovery" value={agent.recoveryPolicy.replaceAll("_", " ")} /><ReviewItem term="Authority" value={Object.entries(agent.authority).filter(([, value]) => value).map(([key]) => key.replace("allow", "")).join(", ") || "No external authority"} /></dl></Section></div>;
}

function AgentActionModal({ api, agent, action, connection, onClose, onAccepted }: { api: ConsoleApi; agent: AgentDetail; action: "steer" | "continue" | "cancel" | "handoff" | null; connection: ConnectionState; onClose: () => void; onAccepted: () => void }) {
  const [input, setInput] = useState("");
  const [runtime, setRuntime] = useState("");
  const [allowUnclean, setAllowUnclean] = useState(false);
  const [cleanTerminals, setCleanTerminals] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setInput(""); setRuntime(""); setAllowUnclean(false); setError(null); }, [action]);
  if (!action) return null;
  const meta = {
    steer: ["Steer active turn", "The current incarnation and turn are sent as stale-state preconditions."],
    continue: ["Continue logical agent", "A new turn starts on the same runtime and thread. Affinity is preserved."],
    cancel: ["Request cancellation", "Acceptance changes state to Cancelling. Only a terminal event confirms interruption."],
    handoff: ["Start runtime handoff", "The router checkpoints the old incarnation, then creates a new incarnation and thread."]
  }[action];
  const submit = async () => {
    setPending(true); setError(null);
    try {
      const key = newIdempotencyKey();
      if (action === "steer") await api.mutate(`/api/v1/agents/${encodeURIComponent(agent.id)}/steer`, "POST", { idempotencyKey: key, input, expectedIncarnationId: agent.activeIncarnation?.id, expectedTurnId: agent.activeIncarnation?.turnId });
      if (action === "continue") await api.mutate(`/api/v1/agents/${encodeURIComponent(agent.id)}/continue`, "POST", { idempotencyKey: key, input, expectedResultVersion: agent.latestResultVersion || undefined });
      if (action === "cancel") await api.mutate(`/api/v1/agents/${encodeURIComponent(agent.id)}/cancel`, "POST", { idempotencyKey: key, expectedTurnId: agent.activeIncarnation?.turnId, cleanBackgroundTerminals: cleanTerminals });
      if (action === "handoff") await api.mutate(`/api/v1/agents/${encodeURIComponent(agent.id)}/handoff`, "POST", { idempotencyKey: key, reason: "operator_request", ...(runtime ? { targetRuntimeId: runtime } : {}), ...(input ? { additionalInstruction: input } : {}), allowUnclean });
      onAccepted();
    } catch (caught) { setError(errorMessage(caught)); } finally { setPending(false); }
  };
  const needsInput = action === "steer" || action === "continue";
  return <Modal open title={meta[0]!} description={meta[1]!} onClose={() => { if (!pending) onClose(); }} footer={<><Button onClick={onClose} disabled={pending}>Close</Button><Button variant={action === "cancel" ? "danger" : "primary"} pending={pending} disabled={connection !== "live" || (needsInput && !input.trim())} onClick={() => void submit()}>{action === "cancel" ? "Request cancellation" : action === "handoff" ? "Begin handoff" : action === "continue" ? "Continue" : "Send instruction"}</Button></>}>
    {connection !== "live" ? <InlineNotice tone="warning" title="Current state unavailable">Reconnect before sending a lifecycle mutation.</InlineNotice> : null}
    {error ? <InlineNotice tone="danger" title="Command not accepted">{error}</InlineNotice> : null}
    {action === "cancel" ? <><InlineNotice tone="warning" title="Cancellation is intermediate">Completed or failed may still win the race before interruption is confirmed.</InlineNotice><label className="check-row"><input type="checkbox" checked={cleanTerminals} onChange={(event) => setCleanTerminals(event.target.checked)} />Inspect background terminals before releasing ownership</label></> : null}
    {action === "handoff" ? <><Field label="Target runtime" hint="Leave blank for a fresh routing decision."><TextInput value={runtime} onChange={(event) => setRuntime(event.target.value)} placeholder="Router selected" /></Field><Field label="Additional instruction" hint="The new thread begins verification-first; this does not replay the original turn."><textarea className="textarea" value={input} onChange={(event) => setInput(event.target.value)} /></Field>{agent.checkpointQuality === "unclean" ? <label className="check-row check-row--danger"><input type="checkbox" checked={allowUnclean} onChange={(event) => setAllowUnclean(event.target.checked)} />I authorize proceeding with the explicitly recorded unclean checkpoint.</label> : null}</> : null}
    {needsInput ? <Field label={action === "steer" ? "Instruction" : "Follow-up input"}><textarea autoFocus className="textarea" value={input} onChange={(event) => setInput(event.target.value)} maxLength={100_000} /></Field> : null}
  </Modal>;
}

function RuntimeOverview({ runtime }: { runtime: RuntimeDto }) {
  return <div className="overview-grid"><Section title="Capacity" description="A healthy runtime may still be busy."><div className="metric-grid metric-grid--inside"><Metric label="Active" value={runtime.activeCount} detail={`of ${runtime.maxConcurrency}`} /><Metric label="Event lag" value={`${runtime.health.eventLagMs}ms`} detail="last projected" /></div><QuotaBar value={runtime.health.quota?.primary?.usedPercent} reset={runtime.health.quota?.primary?.resetsAt} label="Primary quota" /><QuotaBar value={runtime.health.quota?.secondary?.usedPercent} reset={runtime.health.quota?.secondary?.resetsAt} label="Secondary quota" /></Section><Section title="Execution profile" description="Policy metadata and initialization state."><dl className="detail-list"><ReviewItem term="Adapter" value={runtime.adapter} /><ReviewItem term="Provider" value={runtime.provider} /><ReviewItem term="Enabled" value={runtime.enabled ? "Yes" : "No"} /><ReviewItem term="Initialized" value={runtime.health.initialized ? "Yes" : "No"} /><ReviewItem term="Capability tiers" value={runtime.capabilityTiers.join(", ")} /><ReviewItem term="Policy tags" value={runtime.policyTags.join(", ") || "None"} /></dl></Section></div>;
}

function RuntimeModels({ runtime }: { runtime: RuntimeDto }) {
  return <Section title="Model catalog and policy" description="The runtime catalog—not a bundled OpenAI list—is authoritative."><InlineNotice tone="warning" title="Authoritative catalog unavailable">This adapter has not advertised model discovery. Policy entries remain visible, but new defaults cannot be validated or changed here. No fallback availability was invented.</InlineNotice><div className="model-policy"><div><span>Configured allow-list</span><div className="token-row">{runtime.modelPolicy.allowedModels.map((model) => <Token key={model} label="Allowed model" value={model} />)}</div></div><dl className="detail-list"><ReviewItem term="Effective default" value={runtime.modelPolicy.defaultModel ?? "Not configured"} /><ReviewItem term="Reasoning effort" value={runtime.modelPolicy.defaultReasoningEffort ?? "Runtime default"} /><ReviewItem term="Catalog freshness" value="Unknown" /></dl><Button disabled title="Runtime adapter does not expose model refresh">Refresh catalog</Button></div></Section>;
}

function RuntimeAuthentication({ runtime }: { runtime: RuntimeDto }) {
  return <Section title="Authentication boundary" description={`Scoped to runtime ${runtime.id}; another runtime's credentials are never touched.`}><div className="auth-hero"><span className="auth-icon"><KeyRound aria-hidden="true" /></span><div><span className="eyebrow">{runtime.authentication.type.replaceAll("_", " ")}</span><h2>{runtime.authentication.status.replaceAll("_", " ")}</h2><p>{runtime.authentication.message}</p></div></div><dl className="detail-list detail-list--columns"><ReviewItem term="Symbolic reference" value={runtime.authentication.reference ?? "None"} /><ReviewItem term="Resolution" value={runtime.authentication.resolutionState.replaceAll("_", " ")} /><ReviewItem term="Storage mode" value={runtime.authentication.storageMode} /><ReviewItem term="Last readback" value={runtime.authentication.lastCheckedAt ?? "Not observed"} /></dl><InlineNotice tone="info" title="No credential material in the browser">The Console displays reference metadata and authoritative status only. Tokens, auth.json, keyring records, paths, and callback payloads are excluded.</InlineNotice><div className="button-row"><Button disabled={!runtime.authentication.capabilities.browserLogin}>Sign in with ChatGPT</Button><Button disabled={!runtime.authentication.capabilities.deviceLogin}>Use device code</Button><Button disabled={!runtime.authentication.capabilities.logout} variant="danger">Log out runtime</Button></div></Section>;
}

function ResultLists({ result }: { result: AgentResult }) {
  const groups = [["Decisions", result.reported.decisions], ["Invariants", result.reported.invariants], ["Risks", result.reported.risks], ["Pending", result.reported.pending]] as const;
  return <div className="result-lists">{groups.map(([title, items]) => items.length ? <div key={title}><h3>{title}</h3><ul>{items.map((item) => <li key={item}>{item}</li>)}</ul></div> : null)}</div>;
}

function EvidenceBody({ result, detailed = false }: { result: AgentResult; detailed?: boolean }) {
  return <div className="evidence-body"><dl className="detail-list detail-list--columns"><ReviewItem term="Runtime" value={result.observed.runtimeId} /><ReviewItem term="Model" value={result.observed.model ?? "Not observed"} /><ReviewItem term="Base SHA" value={result.observed.baseSha ?? "Not observed"} /><ReviewItem term="Head SHA" value={result.observed.headSha ?? "Not observed"} /><ReviewItem term="Worktree status" value={result.observed.worktreeStatus || "Not observed"} /></dl><div className="evidence-group"><h3>Observed tests</h3>{result.observed.tests.length ? <div className="test-list">{result.observed.tests.map((test, index) => <div className="test-row" key={`${test.command}-${index}`}><span className={`test-outcome test-outcome--${test.outcome}`}>{test.outcome === "passed" ? <CheckCircle2 aria-hidden="true" /> : <XCircle aria-hidden="true" />}{test.outcome}</span><code>{test.command}</code><span>Exit {test.exitCode ?? "unknown"}</span></div>)}</div> : <InlineNotice tone="info" title="No observed test command">A worker report cannot substitute for router-observed command evidence.</InlineNotice>}</div>{detailed ? <div className="evidence-group"><h3>Changed files</h3>{result.observed.changedFiles.length ? <ul className="file-list">{result.observed.changedFiles.map((file) => <li key={file}><FileCheck2 aria-hidden="true" /><code>{file}</code></li>)}</ul> : <p className="muted">No changed files were observed.</p>}</div> : null}{result.observed.terminalError ? <InlineNotice tone="danger" title={result.observed.terminalError.class}>{result.observed.terminalError.message}</InlineNotice> : null}</div>;
}

function FleetModels({ data, navigate }: { data: BootstrapDto; navigate: (href: string) => void }) {
  return <Section title="Fleet model policy" description="Compare configured policy without treating it as runtime availability."><div className="settings-table">{data.runtimes.map((runtime) => <button key={runtime.id} onClick={() => navigate(`/runtimes/${encodeURIComponent(runtime.id)}?tab=models`)}><span><strong>{runtime.id}</strong><small>{runtime.provider}</small></span><span>{runtime.modelPolicy.defaultModel ?? "No default"}</span><span>{runtime.modelPolicy.allowedModels.length} allowed</span><ChevronRight aria-hidden="true" /></button>)}</div></Section>;
}

function FleetCredentials({ data, navigate }: { data: BootstrapDto; navigate: (href: string) => void }) {
  return <Section title="Credential boundaries" description="References and redacted status only."><div className="settings-table">{data.runtimes.map((runtime) => <button key={runtime.id} onClick={() => navigate(`/runtimes/${encodeURIComponent(runtime.id)}?tab=authentication`)}><span><strong>{runtime.id}</strong><small>{runtime.authentication.type.replaceAll("_", " ")}</small></span><span>{runtime.authentication.status.replaceAll("_", " ")}</span><span>{runtime.authentication.resolutionState.replaceAll("_", " ")}</span><ChevronRight aria-hidden="true" /></button>)}</div></Section>;
}

function RuntimeSettings({ data, navigate }: { data: BootstrapDto; navigate: (href: string) => void }) {
  return <Section title="Runtime profiles" description="Live profile state. Persistent edits require an atomic configuration adapter."><InlineNotice tone="info" title="Read-only configuration surface">The current build will not fake local-only config changes. Validate/apply stays disabled until persistent atomic readback exists.</InlineNotice><div className="settings-table">{data.runtimes.map((runtime) => <button key={runtime.id} onClick={() => navigate(`/runtimes/${encodeURIComponent(runtime.id)}`)}><span><strong>{runtime.id}</strong><small>{runtime.adapter.replaceAll("_", " ")}</small></span><StatusBadge status={runtime.health.state} /><span>{runtime.activeCount}/{runtime.maxConcurrency}</span><ChevronRight aria-hidden="true" /></button>)}</div></Section>;
}

function ConfigPanel({ section, config }: { section: string; config: Record<string, unknown> }) {
  const selected = section === "worktrees" ? config.allowedWorktreeRoots : section === "policies" || section === "retention" ? config.policies : config;
  return <Section title={section === "worktrees" ? "Allowed worktree roots" : section.charAt(0).toUpperCase() + section.slice(1)} description="Current redacted readback from the running router."><pre className="config-preview">{JSON.stringify(selected, null, 2)}</pre><div className="button-row"><Button disabled>Validate changes</Button><Button variant="primary" disabled>Apply atomically</Button></div></Section>;
}

function DiagnosticsPanel({ data }: { data: BootstrapDto }) {
  const counters = Object.entries(data.diagnostics.counters);
  return <><Section title="Registry and stream" description="Current diagnostic projection without prompts, credential paths, or hidden reasoning."><div className="metric-grid metric-grid--inside"><Metric label="Registry version" value={data.router.registryVersion} /><Metric label="Events retained" value={Object.values(data.diagnostics.eventsByType).reduce((sum, value) => sum + value, 0)} /><Metric label="Pending interactions" value={data.interactions.length} /><Metric label="Writer leases" value={data.diagnostics.writerLeases.length} /></div></Section><Section title="Router counters" description="Duplicate suppression and recovery signals.">{counters.length ? <dl className="counter-list">{counters.map(([name, value]) => <div key={name}><dt>{name.replaceAll("_", " ")}</dt><dd>{value}</dd></div>)}</dl> : <MiniEmpty title="No counters recorded" detail="Counters appear when the corresponding condition occurs." />}</Section></>;
}

function Page({ title, eyebrow, description, actions, children }: { title: string; eyebrow?: string; description?: string; actions?: ReactNode; children?: ReactNode }) {
  useEffect(() => { document.title = `${title} · Codex Router`; document.querySelector<HTMLElement>("#main-content")?.focus({ preventScroll: true }); }, [title]);
  return <div className="page"><header className="page-header"><div>{eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}<h1>{title}</h1>{description ? <p>{description}</p> : null}</div>{actions ? <div className="page-actions">{actions}</div> : null}</header>{children}</div>;
}

function AgentList({ agents, navigate, compact = false }: { agents: AgentSummary[]; navigate: (href: string) => void; compact?: boolean }) {
  return <div className={`agent-list ${compact ? "agent-list--compact" : ""}`}>{agents.map((agent) => <button key={agent.id} className="agent-list__row pressable" onClick={() => navigate(`/agents/${encodeURIComponent(agent.id)}`)}><StatusBadge status={agent.status} /><span><strong>{agent.taskSummary}</strong><small>{agent.projectKey} · {agent.runtime?.id ?? "not allocated"}</small></span><TimeValue value={agent.updatedAt} /><ChevronRight aria-hidden="true" /></button>)}</div>;
}

function RuntimeStrip({ runtime, navigate }: { runtime: RuntimeDto; navigate: (href: string) => void }) {
  return <button className="runtime-strip pressable" onClick={() => navigate(`/runtimes/${encodeURIComponent(runtime.id)}`)}><span><strong>{runtime.id}</strong><small>{runtime.activeCount}/{runtime.maxConcurrency} active</small></span><QuotaBar value={runtime.health.quota?.primary?.usedPercent} reset={runtime.health.quota?.primary?.resetsAt} label={`${runtime.id} quota`} /><StatusBadge status={runtime.health.state} /></button>;
}

function ComposerSection({ number, title, description, children }: { number: string; title: string; description: string; children: ReactNode }) {
  return <section className="composer-section"><div className="composer-section__title"><span>{number}</span><div><h2>{title}</h2><p>{description}</p></div></div><div className="composer-section__body">{children}</div></section>;
}

function ReviewItem({ term, value }: { term: string; value: string }) {
  return <div><dt>{term}</dt><dd>{value}</dd></div>;
}

function Token({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "neutral" | "warning" }) {
  return <span className={`token token--${tone}`}><span className="sr-only">{label}: </span>{value}</span>;
}

function MiniEmpty({ title, detail }: { title: string; detail: string }) {
  return <div className="mini-empty"><strong>{title}</strong><span>{detail}</span></div>;
}

function LoadingRows() {
  return <div className="loading-rows" role="status" aria-label="Loading"><span /><span /><span /></div>;
}

function ErrorState({ error, retry }: { error: string; retry: () => void }) {
  return <EmptyState icon={<AlertTriangle />} title="This region could not load" description={error} action={<Button onClick={retry}><RefreshCcw aria-hidden="true" />Try again</Button>} />;
}

function useResource<T>(key: string, loader: () => Promise<T>) {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let active = true;
    setError(null);
    void loader().then((next) => { if (active) setValue(next); }).catch((caught) => { if (active) setError(errorMessage(caught)); });
    return () => { active = false; };
  }, [key, nonce]);
  return { value, error, reload: () => setNonce((current) => current + 1) };
}

function errorMessage(error: unknown): string {
  if (error instanceof ConsoleApiError) return `${error.message} (${error.payload.code}; operation ${error.payload.operationId})`;
  return error instanceof Error ? error.message : "Unknown Console error";
}

function eventConsequence(event: RouterEvent): string {
  const payload = event.payload;
  if (event.type === "router_command") return `Router accepted ${String(payload.command ?? "a lifecycle command").replaceAll("_", " ")}`;
  if (event.type === "routing_decision") return `Runtime ${String(payload.selectedRuntimeId ?? event.runtimeId ?? "unknown")} selected`;
  if (event.type === "turn_started") return "Runtime confirmed the active turn";
  if (event.type === "turn_completed") return `Turn reached ${String(payload.status ?? "a terminal state")}`;
  if (event.type === "pending_interaction") return "Human decision requested";
  if (event.type === "interaction_resolved") return "Pending interaction resolved";
  if (event.type === "semantic_output") return "Semantic output observed";
  if (event.type === "command_started") return `Command started: ${String(payload.command ?? "redacted command")}`;
  if (event.type === "command_completed") return `Command completed with exit ${String(payload.exitCode ?? "unknown")}`;
  if (event.type === "file_change") return `File change observed: ${String(payload.path ?? "bounded path")}`;
  if (event.type === "runtime_error") return `Runtime error: ${String(payload.class ?? "unknown class")}`;
  if (event.type === "checkpoint_created") return `${String(payload.quality ?? "Unknown")} checkpoint created`;
  return event.type.replaceAll("_", " ");
}

function handleTabKey(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  tabs: string[],
  current: string,
  select: (value: string) => void
) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const index = Math.max(0, tabs.indexOf(current));
  const nextIndex = event.key === "Home"
    ? 0
    : event.key === "End"
      ? tabs.length - 1
      : event.key === "ArrowRight"
        ? (index + 1) % tabs.length
        : (index - 1 + tabs.length) % tabs.length;
  const next = tabs[nextIndex]!;
  select(next);
  window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus());
}
