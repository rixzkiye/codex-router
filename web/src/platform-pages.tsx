import {
  Activity,
  ArrowRight,
  BadgeCheck,
  Boxes,
  Check,
  ChevronRight,
  CircleHelp,
  CloudCog,
  Database,
  Download,
  FileSearch,
  Gauge,
  HardDrive,
  KeyRound,
  LogOut,
  Network,
  RefreshCcw,
  Route,
  Search,
  ShieldCheck,
  Stethoscope,
  TriangleAlert,
  Trash2,
  WalletCards,
  Wrench
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { ConsoleApiError, newIdempotencyKey } from "./api";
import { Button, EmptyState, InlineNotice, MachineValue, Metric, Section, TimeValue } from "./components";
import type {
  DoctorCheckDto,
  EvidenceState,
  InferenceRequestDto,
  LocalModelDto,
  ModelDto,
  PlatformOperationDto,
  ProviderDto
} from "./types";
import type { PageProps } from "./pages";

export function ProvidersPage(props: PageProps & { providerId?: string }) {
  const { data, navigate } = props;
  const [query, setQuery] = useState("");
  const providers = useMemo(() => data.platform.providers.filter((provider) =>
    `${provider.displayName} ${provider.id} ${provider.owner}`.toLowerCase().includes(query.toLowerCase())
  ), [data.platform.providers, query]);
  const selected = props.providerId ? data.platform.providers.find((provider) => provider.id === props.providerId) : null;
  if (props.providerId && !selected) {
    return <PlatformPage title="Provider not found" eyebrow="Providers" description="The effective registry has no matching provider identity."><EmptyState title="Unknown provider" description="This provider is not present in the effective registry." action={<Button onClick={() => navigate("/providers")}>Back to providers</Button>} /></PlatformPage>;
  }
  if (selected) return <ProviderWorkbench {...props} provider={selected} />;
  return (
    <PlatformPage title="Providers" eyebrow="Inference fabric" description="Connect identity boundaries, inspect truthful readiness, and publish only verified routes.">
      <div className="metric-grid" role="group" aria-label="Provider summary">
        <Metric label="Registry variants" value={data.platform.registry.providerCount} detail="checked-in and configured" />
        <Metric label="Enabled" value={data.platform.summary.enabledProviders} detail="effective policy" />
        <Metric label="Ready" value={data.platform.summary.readyProviders} detail="authoritatively observed" />
        <Metric label="Needs review" value={data.platform.providers.filter((provider) => provider.authentication.state === "unknown").length} detail="unknown auth state" tone="attention" />
      </div>
      <Section title="Provider registry" description="Catalog presence is not a readiness claim." action={<label className="platform-search"><span className="sr-only">Filter providers</span><Search aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter providers" /></label>}>
        <div className="provider-grid">
          {providers.map((provider) => (
            <button className="provider-card pressable" key={provider.id} onClick={() => navigate(`/providers/${encodeURIComponent(provider.id)}`)}>
              <span className="provider-card__mark" aria-hidden="true">{provider.displayName.slice(0, 2).toUpperCase()}</span>
              <span className="provider-card__body">
                <span className="provider-card__title"><strong>{provider.displayName}</strong><StatePill state={provider.enabled ? provider.health.state : "unavailable"} label={provider.enabled ? provider.health.state : "disabled"} /></span>
                <small>{provider.kind.replaceAll("-", " ")} · {provider.protocol.replaceAll("-", " ")}</small>
                <span className="provider-card__signals"><EvidenceDot label="Auth" state={provider.authentication.state} /><EvidenceDot label="Catalog" state={provider.catalog.state} /><span>{provider.catalog.modelCount} models</span></span>
              </span>
              <ChevronRight aria-hidden="true" />
            </button>
          ))}
        </div>
      </Section>
    </PlatformPage>
  );
}

function ProviderWorkbench({ api, data, connection, navigate, refresh, provider }: PageProps & { provider: ProviderDto }) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loginInstruction, setLoginInstruction] = useState<string | null>(null);
  const models = data.platform.models.filter((model) => model.providerVariant === provider.id);
  const run = async (action: "validate" | "discover" | "logout" | "enable" | "disable") => {
    setPending(action); setError(null);
    try {
      await api.mutate(`/api/v1/providers/${encodeURIComponent(provider.id)}/${action}`, "POST", {
        idempotencyKey: newIdempotencyKey(), expectedVersion: provider.version
      });
      await refresh();
    } catch (caught) { setError(errorMessage(caught)); } finally { setPending(null); }
  };
  const showLogin = async () => {
    setPending("login"); setError(null); setLoginInstruction(null);
    try {
      const launch = await api.get<{ executable: string; args: string[]; consequence: string }>(`/api/v1/providers/${encodeURIComponent(provider.id)}/login`);
      setLoginInstruction(`${launch.consequence} Run: codex-router platform provider ${provider.id} login`);
    } catch (caught) { setError(errorMessage(caught)); } finally { setPending(null); }
  };
  const authReady = provider.authentication.state === "ready" || provider.authBoundary.mechanism === "keyless";
  return (
    <PlatformPage title={provider.displayName} eyebrow="Provider workbench" description={`${provider.id} · ${provider.publication.replaceAll("-", " ")}`} actions={<Button onClick={() => navigate("/providers")}>All providers</Button>}>
      {error ? <InlineNotice tone="danger" title="Operation not accepted">{error}</InlineNotice> : null}
      {loginInstruction ? <InlineNotice tone="info" title="Official sign-in stays outside the browser">{loginInstruction}</InlineNotice> : null}
      {provider.planNote ? <InlineNotice tone="warning" title="Authentication is not entitlement">{provider.planNote}</InlineNotice> : null}
      <div className="provider-hero">
        <span className="provider-card__mark provider-card__mark--large" aria-hidden="true">{provider.displayName.slice(0, 2).toUpperCase()}</span>
        <div><span className="eyebrow">{provider.owner}</span><h2>{provider.displayName}</h2><p>{provider.protocol.replaceAll("-", " ")} through profile <code>{provider.requestProfile}</code></p></div>
        <StatePill state={provider.enabled ? provider.health.state : "unavailable"} label={provider.enabled ? provider.health.state : "disabled"} />
      </div>
      <ol className="setup-steps" aria-label="Provider onboarding progress">
        <SetupStep number="1" title="Identity boundary" detail={provider.authBoundary.mechanism.replaceAll("-", " ")} state="complete" />
        <SetupStep number="2" title="Authentication readback" detail={provider.authentication.state} state={authReady ? "complete" : "current"} />
        <SetupStep number="3" title="Catalog evidence" detail={`${provider.catalog.modelCount} configured`} state={provider.catalog.modelCount > 0 ? "complete" : "pending"} />
        <SetupStep number="4" title="Compatibility" detail={models.some((model) => model.compatibility.mock === "ready") ? "mock verified" : "not yet verified"} state={models.some((model) => model.compatibility.mock === "ready") ? "complete" : "pending"} />
        <SetupStep number="5" title="Publish" detail={provider.enabled ? "enabled" : "disabled"} state={provider.enabled ? "complete" : "pending"} />
      </ol>
      <div className="overview-grid">
        <Section title="Connection boundary" description="References and status only; secret material never reaches this page.">
          <dl className="detail-list">
            <Review term="Authentication" value={provider.authentication.state} />
            <Review term="Resolution source" value={provider.authentication.source ?? "Not observed"} />
            <Review term="Reference" value={provider.authentication.reference ?? "Owned by official runtime or CLI"} />
            <Review term="Endpoint authority" value={provider.baseUrl ?? provider.baseUrlEnvironment ?? "Runtime-owned forwarder"} />
          </dl>
          <div className="button-row">
            <Button pending={pending === "validate"} disabled={connection !== "live"} onClick={() => void run("validate")}><RefreshCcw aria-hidden="true" />Validate readback</Button>
            {provider.authBoundary.interactiveTerminal && ["native-codex", "kimi-oauth", "grok-oauth", "commandcode"].includes(provider.id)
              ? <Button pending={pending === "login"} disabled={connection !== "live"} onClick={() => void showLogin()}><KeyRound aria-hidden="true" />Sign-in instructions</Button>
              : null}
            {provider.authentication.state === "ready" && provider.authBoundary.interactiveTerminal && ["native-codex", "kimi-oauth", "grok-oauth", "commandcode"].includes(provider.id)
              ? <Button variant="danger" pending={pending === "logout"} disabled={connection !== "live"} onClick={() => void run("logout")}><LogOut aria-hidden="true" />Log out</Button>
              : null}
            <Button pending={pending === "discover"} disabled={connection !== "live" || !authReady || provider.discovery === "not-supported"} onClick={() => void run("discover")}><FileSearch aria-hidden="true" />Discover models</Button>
            <Button variant={provider.enabled ? "danger" : "primary"} pending={pending === (provider.enabled ? "disable" : "enable")} disabled={connection !== "live" || (!provider.enabled && !authReady)} onClick={() => void run(provider.enabled ? "disable" : "enable")}>{provider.enabled ? "Disable provider" : "Enable provider"}</Button>
          </div>
        </Section>
        <Section title="Evidence" description="Unknown and unavailable never collapse to healthy.">
          <div className="evidence-stack">
            <EvidenceRow icon={<KeyRound />} label="Authentication" state={provider.authentication.state} detail={provider.authentication.checkedAt ?? "Never checked"} />
            <EvidenceRow icon={<BadgeCheck />} label="Entitlement" state={provider.entitlement.state} detail={provider.entitlement.message} />
            <EvidenceRow icon={<Activity />} label="Health" state={provider.health.state} detail={provider.health.message} />
            <EvidenceRow icon={<Database />} label="Catalog" state={provider.catalog.state} detail={`${provider.catalog.modelCount} model records`} />
          </div>
        </Section>
      </div>
      <Section title="Model boundary" description="Discovery is evidence; it never auto-publishes.">
        {models.length ? <ModelRows models={models} navigate={navigate} /> : <EmptyState title="No curated models" description="This provider remains catalog-only until discovery and explicit curation produce model records." />}
      </Section>
    </PlatformPage>
  );
}

export function AccountsPage({ data, navigate }: PageProps) {
  return (
    <PlatformPage title="Accounts" eyebrow="Credential boundaries" description="Sessions, entitlement, quota, and affinity stay separate even when providers share an owner.">
      <div className="account-grid">
        {data.platform.accounts.map((account) => (
          <button key={account.id} className="account-card pressable" onClick={() => navigate(`/providers/${encodeURIComponent(account.providerId)}`)}>
            <span className="account-card__icon"><KeyRound aria-hidden="true" /></span>
            <span><strong>{account.label}</strong><small>{account.id}</small></span>
            <StatePill state={account.authentication.state} />
            <dl><div><dt>Entitlement</dt><dd>{account.entitlement.state}</dd></div><div><dt>Quota</dt><dd>{account.quota.state}</dd></div><div><dt>Affinity</dt><dd>{account.affinity.continuations} continuations</dd></div></dl>
            <ChevronRight aria-hidden="true" />
          </button>
        ))}
      </div>
    </PlatformPage>
  );
}

export function ModelsPage(props: PageProps & { modelId?: string }) {
  const { data, navigate } = props;
  const [query, setQuery] = useState("");
  const selected = props.modelId ? data.platform.models.find((model) => model.gatewayId === props.modelId) : null;
  if (selected) return <ModelWorkbench {...props} model={selected} />;
  const models = data.platform.models.filter((model) => `${model.displayName} ${model.gatewayId} ${model.providerVariant}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <PlatformPage title="Models" eyebrow="Capability workbench" description="Picker visibility follows exact provider, profile, and compatibility evidence.">
      <Section title="Effective catalog" description={`${data.platform.models.length} configured model records; no provider discovery is auto-published.`} action={<label className="platform-search"><Search aria-hidden="true" /><span className="sr-only">Filter models</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter models" /></label>}>
        {models.length ? <ModelRows models={models} navigate={navigate} /> : <EmptyState title="No matching models" description="Try another provider, slug, or upstream identifier." />}
      </Section>
    </PlatformPage>
  );
}

function ModelWorkbench({ api, data, connection, navigate, refresh, model }: PageProps & { model: ModelDto }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const provider = data.platform.providers.find((entry) => entry.id === model.providerVariant)!;
  const toggle = async () => {
    setPending(true); setError(null);
    try {
      await api.mutate(`/api/v1/models/${encodeURIComponent(model.gatewayId)}/${model.enabled ? "disable" : "enable"}`, "POST", {
        idempotencyKey: newIdempotencyKey(), expectedVersion: model.version
      });
      await refresh();
    } catch (caught) { setError(errorMessage(caught)); } finally { setPending(false); }
  };
  const probe = async () => {
    setPending(true); setError(null);
    try {
      await api.mutate(`/api/v1/models/${encodeURIComponent(model.gatewayId)}/compatibility/mock`, "POST", {
        idempotencyKey: newIdempotencyKey(), expectedVersion: model.version
      });
      await refresh();
    } catch (caught) { setError(errorMessage(caught)); } finally { setPending(false); }
  };
  return (
    <PlatformPage title={model.displayName} eyebrow="Model workbench" description={`${model.gatewayId} · ${model.providerVariant}`} actions={<Button onClick={() => navigate("/models")}>All models</Button>}>
      {error ? <InlineNotice tone="danger" title="Picker state unchanged">{error}</InlineNotice> : null}
      <div className="model-hero">
        <div><span className="eyebrow">{model.publication.replaceAll("-", " ")}</span><h2>{model.displayName}</h2><p>Upstream <code>{model.upstreamId}</code> through <code>{model.requestProfile}</code></p></div>
        <div className="button-row"><Button pending={pending} disabled={connection !== "live"} onClick={() => void probe()}><Wrench aria-hidden="true" />Run mock probe</Button><Button variant={model.enabled ? "danger" : "primary"} pending={pending} disabled={connection !== "live" || (!model.enabled && !provider.enabled)} onClick={() => void toggle()}>{model.enabled ? "Hide from picker" : "List in picker"}</Button></div>
      </div>
      {!provider.enabled ? <InlineNotice tone="warning" title="Provider is disabled">Enable {provider.displayName} before publishing this model.</InlineNotice> : null}
      <div className="overview-grid">
        <Section title="Identity and limits" description="Unknown values remain explicitly unknown."><dl className="detail-list"><Review term="Public slug" value={model.publicSlug} /><Review term="Gateway ID" value={model.gatewayId} /><Review term="Upstream ID" value={model.upstreamId} /><Review term="Context" value={model.contextWindow ? `${model.contextWindow.toLocaleString()} tokens` : "Unknown"} /><Review term="Output limit" value={model.maxOutputTokens ? `${model.maxOutputTokens.toLocaleString()} tokens` : "Unknown"} /><Review term="Provenance" value={model.provenance} /></dl></Section>
        <Section title="Compatibility evidence" description="Mock and live evidence are independent."><div className="evidence-stack"><EvidenceRow icon={<Wrench />} label="Mock suite" state={model.compatibility.mock} detail={model.compatibility.checkedAt ?? "Not run"} /><EvidenceRow icon={<CloudCog />} label="Live probe" state={model.compatibility.live} detail="Requires explicit quota authority" /><EvidenceRow icon={<ShieldCheck />} label="Profile hash" state="ready" detail={model.compatibility.profileHash.slice(0, 16)} /></div></Section>
      </div>
      <Section title="Capability matrix" description="Native, derived, unsupported, and unverified states remain distinct."><div className="capability-grid"><Capability label="Text" state={model.capabilities.input.includes("text") ? "native" : "unsupported"} /><Capability label="Images" state={model.capabilities.nativeImage ? "native" : model.capabilities.derivedImage ? "derived" : "unsupported"} /><Capability label="Tools" state={model.capabilities.tools ? "verified" : "unsupported"} /><Capability label="Forced tools" state={model.capabilities.forcedToolChoice ? "verified" : "unsupported"} /><Capability label="Parallel tools" state={model.capabilities.parallelTools ? "verified" : "unsupported"} /><Capability label="Structured output" state={model.capabilities.structuredOutput ? "verified" : "unsupported"} /><Capability label="Compaction" state={model.capabilities.compaction ? "verified" : "unsupported"} /><Capability label="Collaboration" state={model.capabilities.collaboration ? "verified" : "unsupported"} /></div></Section>
    </PlatformPage>
  );
}

export function RoutingPage({ data, navigate }: PageProps) {
  const recent = data.platform.routingDecisions.slice(0, 10);
  return (
    <PlatformPage title="Routing" eyebrow="Decision authority" description="Eligibility precedes scoring; affinity and semantic-output boundaries are never soft preferences.">
      <div className="routing-rule"><span><ShieldCheck aria-hidden="true" /></span><div><strong>Replay boundary</strong><p>Once text, reasoning, a tool call, command, approval, file mutation, or other semantic output is observed, the attempt is final.</p></div></div>
      <div className="routing-flow" aria-label="Routing decision stages"><FlowStep icon={<KeyRound />} label="Identity" detail="credential boundary" /><ArrowRight aria-hidden="true" /><FlowStep icon={<BadgeCheck />} label="Eligibility" detail="capability + health" /><ArrowRight aria-hidden="true" /><FlowStep icon={<Route />} label="Affinity" detail="thread + account" /><ArrowRight aria-hidden="true" /><FlowStep icon={<Activity />} label="Attempt" detail="observed boundary" /></div>
      <Section title="Recent decisions" description="Candidates, rejection reasons, policy, and catalog provenance—without prompts or response bodies.">{recent.length ? <div className="decision-list">{recent.map((decision) => <details key={decision.requestId}><summary><span><strong>{decision.selected.modelId}</strong><small>{decision.selected.providerId} · score {decision.selected.score}</small></span><span><MachineValue value={decision.policyVersion} label="routing policy" /></span><ChevronRight aria-hidden="true" /></summary><div className="decision-detail"><dl className="detail-list detail-list--columns"><Review term="Request" value={decision.requestId} /><Review term="Account boundary" value={decision.selected.accountRefId ?? "Keyless/local"} /><Review term="Catalog" value={decision.catalogVersion.slice(0, 16)} /><Review term="Quota snapshot" value={decision.quotaSnapshotVersion ?? "Unavailable"} /></dl><div className="candidate-list">{decision.candidates.map((candidate) => <div key={`${candidate.providerId}:${candidate.modelId}`}><StatePill state={candidate.eligible ? "ready" : "unavailable"} label={candidate.eligible ? "eligible" : "rejected"} /><span><strong>{candidate.modelId}</strong><small>{candidate.reasons.length ? candidate.reasons.join(" · ") : `score ${candidate.score}`}</small></span></div>)}</div><Button onClick={() => navigate(`/requests/${encodeURIComponent(decision.requestId)}`)}>Open request</Button></div></details>)}</div> : <EmptyState title="No inference decisions recorded" description="Decisions appear after traffic passes through the instrumented inference edge." />}</Section>
    </PlatformPage>
  );
}

export function RequestsPage(props: PageProps & { requestId?: string }) {
  const selected = props.requestId ? props.data.platform.requests.find((request) => request.id === props.requestId) : null;
  if (selected) return <RequestInspector {...props} request={selected} />;
  return <PlatformPage title="Requests" eyebrow="Sanitized evidence" description="Attempts, semantic boundaries, transformations, and usage—without prompt or private response content."><Section title="Request history" description={`${props.data.platform.requests.length} recent safe summaries.`}>{props.data.platform.requests.length ? <RequestRows requests={props.data.platform.requests} navigate={props.navigate} /> : <EmptyState title="No request summaries" description="Start the inference edge with the same database to project request evidence here." />}</Section></PlatformPage>;
}

function RequestInspector({ request, navigate, data }: PageProps & { request: InferenceRequestDto }) {
  const decision = data.platform.routingDecisions.find((entry) => entry.requestId === request.id);
  const times = [
    ["Accepted", request.startedAt], ["Upstream connected", request.connectedAt], ["First semantic output", request.firstSemanticAt], ["Terminal", request.completedAt]
  ] as const;
  return <PlatformPage title="Request inspector" eyebrow="Sanitized attempt" description={request.id} actions={<Button onClick={() => navigate("/requests")}>All requests</Button>}>
    <div className="request-boundary"><StatePill state={request.status === "completed" ? "ready" : request.errorClass ? "degraded" : "unknown"} label={request.status} /><span>{request.providerId}</span><span>{request.modelId}</span><MachineValue value={request.attemptId} label="attempt ID" /></div>
    <Section title="Attempt timeline" description="The semantic boundary determines retry and failover legality."><ol className="attempt-timeline">{times.map(([label, value], index) => <li key={label} className={value ? "attempt-timeline__observed" : ""}><span>{value ? <Check aria-hidden="true" /> : index === 2 ? <ShieldCheck aria-hidden="true" /> : <CircleHelp aria-hidden="true" />}</span><div><strong>{label}</strong><small>{value ? <TimeValue value={value} /> : "Not observed"}</small></div></li>)}</ol>{request.semanticOutputObserved ? <InlineNotice tone="warning" title="Replay is closed">Semantic output was observed. Recovery requires an explicit new boundary, never transparent replay.</InlineNotice> : <InlineNotice tone="info" title="No semantic output observed">This record alone does not authorize retry; the failure class must also prove origin safety.</InlineNotice>}</Section>
    <div className="overview-grid"><Section title="Identity boundaries"><dl className="detail-list"><Review term="Caller" value={request.callerClass} /><Review term="Runtime" value={request.runtimeId ?? "Direct client"} /><Review term="Provider" value={request.providerId} /><Review term="Account reference" value={request.accountRefId ?? "None"} /><Review term="Model" value={request.modelId} /><Review term="Profile hash" value={request.profileHash.slice(0, 16)} /></dl></Section><Section title="Usage evidence"><dl className="detail-list"><Review term="Provider input" value={tokens(request.usage.providerInputTokens)} /><Review term="Provider output" value={tokens(request.usage.providerOutputTokens)} /><Review term="Cached input" value={tokens(request.usage.cachedInputTokens)} /><Review term="Reasoning" value={tokens(request.usage.reasoningTokens)} /><Review term="Estimated input" value={tokens(request.usage.estimatedInputTokens, true)} /></dl></Section></div>
    <Section title="Transformations" description="Categories only; transformed prompt bodies are not retained.">{request.flags.length ? <div className="token-row">{request.flags.map((flag) => <span className="token" key={flag}>{flag.replaceAll(".", " · ")}</span>)}</div> : <EmptyState title="No transformations recorded" description="The effective request profile did not report a normalized field change." />}</Section>
    <Section title="Routing decision" description="Eligibility and score evidence captured before provider dispatch.">{decision ? <><dl className="detail-list detail-list--columns"><Review term="Policy" value={decision.policyVersion} /><Review term="Catalog" value={decision.catalogVersion.slice(0, 16)} /><Review term="Selected score" value={String(decision.selected.score)} /><Review term="Quota snapshot" value={decision.quotaSnapshotVersion ?? "Unavailable"} /></dl><div className="candidate-list">{decision.candidates.map((candidate) => <div key={`${candidate.providerId}:${candidate.modelId}`}><StatePill state={candidate.eligible ? "ready" : "unavailable"} label={candidate.eligible ? "eligible" : "rejected"} /><span><strong>{candidate.modelId}</strong><small>{candidate.reasons.join(" · ") || `score ${candidate.score}`}</small></span></div>)}</div></> : <InlineNotice tone="info" title="Decision evidence unavailable">This request predates routing-decision persistence or was recorded by a standalone edge.</InlineNotice>}</Section>
  </PlatformPage>;
}

export function UsagePage({ data }: PageProps) {
  const totals = data.platform.usage.totals;
  const input = totals.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0);
  const output = totals.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0);
  return <PlatformPage title="Usage" eyebrow="Provider truth" description="Reported tokens and router estimates stay visibly separate."><div className="metric-grid"><Metric label="Requests" value={totals.reduce((sum, row) => sum + row.requests, 0)} detail="recorded usage events" /><Metric label="Input" value={input.toLocaleString()} detail="provider reported" /><Metric label="Output" value={output.toLocaleString()} detail="provider reported" /><Metric label="Estimated cost" value={data.platform.usage.estimatedCostUsd === null ? "Unavailable" : `$${data.platform.usage.estimatedCostUsd.toFixed(4)}`} detail={data.platform.usage.estimatedCostUsd === null ? "no versioned pricing proof" : "router estimate, not invoice truth"} /></div><Section title="Usage by route" description={data.platform.usage.provenance}>{totals.length ? <div className="usage-table">{totals.map((row) => <div key={`${row.providerId}:${row.modelId}`}><span><strong>{row.modelId}</strong><small>{row.providerId}</small></span><span>{row.requests} req</span><span>{tokens(row.inputTokens)} in</span><span>{tokens(row.outputTokens)} out</span><span>{row.estimatedCost ? `$${row.estimatedCost.amount.toFixed(4)} est. · ${row.estimatedCost.provenance.version}` : row.estimatedInputTokens === null ? "No estimate" : `${row.estimatedInputTokens.toLocaleString()} estimated`}</span></div>)}</div> : <EmptyState title="Usage is unavailable" description="Unavailable metrics stay unavailable; they are never rendered as zero." />}</Section></PlatformPage>;
}

export function LocalModelsPage({ api, data, connection, refresh }: PageProps) {
  const [modelId, setModelId] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mutate = async (action: string, model?: LocalModelDto) => {
    const target = model?.id ?? modelId.trim();
    if (action === "download" && !target) { setError("Enter an exact Ollama model identifier before downloading."); return; }
    if ((action === "download" || action === "remove") && !window.confirm(action === "download"
      ? `Download ${target}? This may transfer multiple gigabytes and consume local disk space.`
      : `Remove ${target} from the local runtime? Downloaded bytes are not recoverable through Codex Router.`)) return;
    setPending(`${action}:${target}`); setError(null);
    try {
      const path = action === "discover"
        ? "/api/v1/local-models/discover"
        : `/api/v1/local-models/${encodeURIComponent(target)}/${action}`;
      const expectedVersion = action === "discover" ? data.platform.localRuntime.version : model?.version ?? 1;
      await api.mutate(path, "POST", {
        idempotencyKey: newIdempotencyKey(),
        expectedVersion,
        ...((action === "download" || action === "remove") ? { consent: true } : {})
      });
      if (action === "download") setModelId("");
      await refresh();
    } catch (caught) { setError(errorMessage(caught)); } finally { setPending(null); }
  };
  const cancelOperation = async (operationId: string) => {
    setPending(`cancel:${operationId}`); setError(null);
    try {
      await api.mutate(`/api/v1/operations/${encodeURIComponent(operationId)}/cancel`, "POST", {});
      await refresh();
    } catch (caught) { setError(errorMessage(caught)); } finally { setPending(null); }
  };
  return <PlatformPage title="Local Models" eyebrow="Experimental boundary" description="Discovery, download, validation, selection, and deletion remain separate durable operations.">
    {error ? <InlineNotice tone="danger" title="Local runtime unchanged">{error}</InlineNotice> : null}
    <div className="metric-grid"><Metric label="Runtime" value={data.platform.localRuntime.state} detail={data.platform.localRuntime.runtimeId} /><Metric label="Discovered" value={data.platform.localModels.length} detail="durable projections" /><Metric label="Validated" value={data.platform.localModels.filter((model) => model.state === "validated").length} detail="measured tool calls" /><Metric label="Selected" value={data.platform.localModels.filter((model) => model.selected).length} detail="explicitly eligible" /></div>
    <Section title="Runtime discovery" description={`Loopback authority ${data.platform.localRuntime.baseUrl}. No cloud fallback is inferred.`} action={<Button pending={pending === "discover:"} disabled={connection !== "live"} onClick={() => void mutate("discover")}><RefreshCcw aria-hidden="true" />Discover installed</Button>}>
      <div className="local-download"><label><span>Exact Ollama model</span><input className="text-input" value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder="qwen3-coder:30b" autoComplete="off" /></label><Button variant="primary" pending={pending === `download:${modelId.trim()}`} disabled={connection !== "live" || !modelId.trim()} onClick={() => void mutate("download")}><Download aria-hidden="true" />Download with consent</Button></div>
      <p className="muted">Downloads never start from discovery or selection. The runtime reports progress through the durable operation ledger.</p>
    </Section>
    <Section title="Local inventory" description="Model metadata filters candidates; only measured behavior permits selection.">
      {data.platform.localModels.length ? <div className="local-model-list">{data.platform.localModels.map((model) => <article key={model.id} className="local-model-row"><span className="local-model-row__icon"><HardDrive aria-hidden="true" /></span><div className="local-model-row__body"><div><strong>{model.id}</strong><StatePill state={localModelEvidence(model.state)} label={model.selected ? "selected" : model.state} /></div><small>{formatBytes(model.definition.sizeBytes)} · context {model.definition.contextWindow?.toLocaleString() ?? "unknown"} · {model.definition.capabilities.join(", ") || "capabilities unverified"}</small>{model.benchmark ? <span>{model.benchmark.tokensPerSecond ?? "?"} tok/s · tool call {model.benchmark.toolCallObserved ? "observed" : "not observed"}</span> : <span>No measured agent benchmark.</span>}</div><div className="local-model-row__actions"><Button pending={pending === `benchmark:${model.id}`} disabled={connection !== "live" || ["downloading", "removing"].includes(model.state)} onClick={() => void mutate("benchmark", model)}><Wrench aria-hidden="true" />Validate</Button><Button variant={model.selected ? "danger" : "primary"} pending={pending === `${model.selected ? "unselect" : "select"}:${model.id}`} disabled={connection !== "live" || (!model.selected && model.state !== "validated")} onClick={() => void mutate(model.selected ? "unselect" : "select", model)}>{model.selected ? "Unselect" : "Select"}</Button><Button variant="danger" pending={pending === `remove:${model.id}`} disabled={connection !== "live" || model.selected || ["downloading", "removing"].includes(model.state)} onClick={() => void mutate("remove", model)}><Trash2 aria-hidden="true" />Remove</Button></div></article>)}</div> : <EmptyState icon={<HardDrive />} title="No installed model observed" description="Run discovery against the configured loopback runtime, or enter an exact model ID and explicitly approve a download." />}
    </Section>
    <Section title="Recent local operations" description="Progress and terminal readback survive browser reloads."><OperationRows operations={data.platform.operations.filter((operation) => operation.kind.startsWith("local-model"))} onCancel={cancelOperation} pendingCancelId={pending?.startsWith("cancel:") ? pending.slice(7) : null} /></Section>
  </PlatformPage>;
}

export function PlatformDiagnosticsPage({ api, data, connection, refresh }: PageProps) {
  const checks = data.platform.diagnostics;
  const installedManifest = data.platform.installState?.manifest;
  const [target, setTarget] = useState({ root: "", version: "", releaseSource: "", entrypoint: "", configPath: "" });
  const [manifestFileDraft, setManifestFileDraft] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const expectedVersion = data.platform.installState?.version ?? 1;
  const targetComplete = Object.values(target).every((value) => value.trim());
  const manifestFile = manifestFileDraft ?? String(installedManifest?.manifestFile ?? "");
  const runInstallation = async (action: "plan" | "apply" | "rollback" | "disable" | "uninstall") => {
    setPending(action); setError(null);
    try {
      const body = action === "plan" || action === "apply"
        ? {
          idempotencyKey: newIdempotencyKey(), expectedVersion, target,
          ...(action === "apply" ? { consent: true } : {})
        }
        : {
          idempotencyKey: newIdempotencyKey(), expectedVersion, manifestFile: manifestFile.trim(), consent: true,
          ...(action === "uninstall" ? { removeRetainedReleases: false } : {})
        };
      await api.mutate(`/api/v1/installation/${action}`, "POST", body);
      setConsent(false);
      await refresh();
    } catch (caught) { setError(errorMessage(caught)); } finally { setPending(null); }
  };
  const cancelOperation = async (operationId: string) => {
    setPending(`cancel:${operationId}`); setError(null);
    try {
      await api.mutate(`/api/v1/operations/${encodeURIComponent(operationId)}/cancel`, "POST", {});
      await refresh();
    } catch (caught) { setError(errorMessage(caught)); } finally { setPending(null); }
  };
  const updateTarget = (key: keyof typeof target, value: string) => setTarget((current) => ({ ...current, [key]: value }));

  return <PlatformPage title="Diagnostics" eyebrow="Read-only by default" description="Ownership, integrity, process health, and generated-artifact drift are independent checks.">
    {error ? <InlineNotice tone="danger" title="Installation state unchanged">{error}</InlineNotice> : null}
    <div className="diagnostic-grid">{checks.map((check) => <DiagnosticCard key={check.id} check={check} />)}</div>
    <Section title="Generation manifest" description="Catalog, route, and translator artifacts share one identity.">
      {data.platform.registry.manifest ? <dl className="detail-list detail-list--columns"><Review term="Registry hash" value={data.platform.registry.manifest.registryHash} /><Review term="Routes hash" value={data.platform.registry.manifest.routesHash} /><Review term="LiteLLM hash" value={data.platform.registry.manifest.litellmHash} /><Review term="Generated" value={data.platform.registry.manifest.generatedAt} /></dl> : <InlineNotice tone="info" title="Inference generation is not configured">Agent lifecycle remains available independently.</InlineNotice>}
    </Section>
    <Section title="Managed installation" description="Planning is read-only. Apply, rollback, disable, and uninstall require explicit consent and mutate manifest-owned paths only.">
      <div className="installation-workbench">
        <div className="installation-fields">
          <label><span>Managed root</span><input className="text-input" value={target.root} onChange={(event) => updateTarget("root", event.target.value)} placeholder="/opt/codex-router-user" /></label>
          <label><span>Release version</span><input className="text-input" value={target.version} onChange={(event) => updateTarget("version", event.target.value)} placeholder="0.2.0" /></label>
          <label><span>Release source</span><input className="text-input" value={target.releaseSource} onChange={(event) => updateTarget("releaseSource", event.target.value)} placeholder="/path/to/released-artifact" /></label>
          <label><span>Entrypoint inside release</span><input className="text-input" value={target.entrypoint} onChange={(event) => updateTarget("entrypoint", event.target.value)} placeholder="dist/index.js" /></label>
          <label className="installation-fields__wide"><span>Router config path</span><input className="text-input" value={target.configPath} onChange={(event) => updateTarget("configPath", event.target.value)} placeholder="/path/to/router.config.json" /></label>
        </div>
        <div className="button-row">
          <Button pending={pending === "plan"} disabled={connection !== "live" || !targetComplete} onClick={() => void runInstallation("plan")}><FileSearch aria-hidden="true" />Plan without changes</Button>
          <Button variant="primary" pending={pending === "apply"} disabled={connection !== "live" || !targetComplete || !consent} onClick={() => void runInstallation("apply")}><Download aria-hidden="true" />{installedManifest ? "Apply update" : "Install release"}</Button>
        </div>
        {installedManifest ? <dl className="detail-list detail-list--columns"><Review term="Projection version" value={String(expectedVersion)} /><Review term="Release" value={String(installedManifest.releaseVersion ?? "unknown")} /><Review term="State" value={String(installedManifest.state ?? "unknown")} /><Review term="Read back" value={data.platform.installState!.updatedAt} /></dl> : <InlineNotice tone="info" title="No managed installation state">Plan the exact released artifact before authorizing installation.</InlineNotice>}
        <label className="installation-consent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} /><span>I authorize the exact managed paths above. Uninstall retains backups, logs, credentials, models, and rollback releases by default.</span></label>
        {installedManifest ? <div className="installation-recovery">
          <label><span>Owned manifest path</span><input className="text-input" value={manifestFile} onChange={(event) => setManifestFileDraft(event.target.value)} placeholder="/managed/root/install-manifest.json" /></label>
          <div className="button-row">
            <Button pending={pending === "rollback"} disabled={connection !== "live" || !consent || !manifestFile.trim()} onClick={() => void runInstallation("rollback")}><RefreshCcw aria-hidden="true" />Roll back</Button>
            <Button pending={pending === "disable"} disabled={connection !== "live" || !consent || !manifestFile.trim()} onClick={() => void runInstallation("disable")}><Wrench aria-hidden="true" />Disable service</Button>
            <Button variant="danger" pending={pending === "uninstall"} disabled={connection !== "live" || !consent || !manifestFile.trim()} onClick={() => void runInstallation("uninstall")}><Trash2 aria-hidden="true" />Uninstall owned paths</Button>
          </div>
        </div> : null}
      </div>
    </Section>
    <Section title="Release evidence" description="Local checks, CI, security, accessibility, packaging, provider probes, install proof, deployment, and live health never collapse into one green badge.">
      {data.platform.evidence.length ? <div className="evidence-gate-grid">{data.platform.evidence.map((entry) => <article key={entry.id}><StatePill state={entry.state === "pass" ? "ready" : entry.state === "fail" ? "degraded" : "unknown"} label={entry.state} /><span><strong>{entry.capability}</strong><small>{entry.category} · {entry.headSha ? entry.headSha.slice(0, 12) : "no exact head"}</small></span><TimeValue value={entry.observedAt} /></article>)}</div> : <InlineNotice tone="warning" title="General availability is blocked">No exact-head release evidence has been recorded. Passing local implementation tests alone is not a GA claim.</InlineNotice>}
    </Section>
    <Section title="Native catalog cohorts" description="Catalog truth remains account- and client-version-bound.">
      {data.platform.nativeCatalogs.length ? <dl className="detail-list">{data.platform.nativeCatalogs.map((catalog) => <Review key={`${catalog.accountRefId}:${catalog.clientVersion}`} term={`${catalog.accountRefId} · ${catalog.clientVersion}`} value={`${catalog.state} · ${catalog.hash.slice(0, 16)} · ${catalog.observedAt}`} />)}</dl> : <InlineNotice tone="info" title="No native catalog captured">External entries cannot be merged until a supported Codex client provides an authoritative schema template.</InlineNotice>}
    </Section>
    <Section title="Capability ledger" description="No reference capability is silently dropped."><div className="ledger-table">{data.platform.capabilityLedger.map((entry) => <details key={entry.id}><summary><span><strong>{entry.capability}</strong><small>Phase {entry.phase} · {entry.owner}</small></span><span className={`ledger-state ledger-state--${entry.disposition}`}>{entry.disposition}</span></summary><p>{entry.evidence}</p></details>)}</div></Section>
    <Section title="Recent operations" description="Acceptance, progress, and terminal state are not conflated.">{data.platform.operations.length ? <OperationRows operations={data.platform.operations} onCancel={cancelOperation} pendingCancelId={pending?.startsWith("cancel:") ? pending.slice(7) : null} /> : <EmptyState title="No platform operations" description="Provider, model, and installation mutations appear here after durable acceptance." />}</Section>
  </PlatformPage>;
}

function ModelRows({ models, navigate }: { models: ModelDto[]; navigate: (href: string) => void }) {
  return <div className="model-table">{models.map((model) => <button key={model.gatewayId} className="model-row pressable" onClick={() => navigate(`/models/${encodeURIComponent(model.gatewayId)}`)}><span><strong>{model.displayName}</strong><small>{model.gatewayId}</small></span><span>{model.providerVariant}</span><span className="model-row__caps">{model.capabilities.tools ? <b>Tools</b> : null}{model.capabilities.compaction ? <b>Compact</b> : null}{model.capabilities.nativeImage ? <b>Vision</b> : model.capabilities.derivedImage ? <b>Bridge</b> : null}</span><StatePill state={model.enabled ? model.compatibility.live : "unavailable"} label={model.enabled ? model.publication : "hidden"} /><ChevronRight aria-hidden="true" /></button>)}</div>;
}

function RequestRows({ requests, navigate }: { requests: InferenceRequestDto[]; navigate: (href: string) => void }) {
  return <div className="request-table">{requests.map((request) => <button key={request.id} className="request-row pressable" onClick={() => navigate(`/requests/${encodeURIComponent(request.id)}`)}><span className={`request-row__boundary ${request.semanticOutputObserved ? "request-row__boundary--closed" : ""}`} aria-label={request.semanticOutputObserved ? "Semantic output observed" : "No semantic output observed"}><ShieldCheck aria-hidden="true" /></span><span><strong>{request.modelId}</strong><small>{request.providerId} · {request.id}</small></span><StatePill state={request.status === "completed" ? "ready" : request.errorClass ? "degraded" : "unknown"} label={request.status} /><span><TimeValue value={request.startedAt} /></span><ChevronRight aria-hidden="true" /></button>)}</div>;
}

function OperationRows({ operations, onCancel, pendingCancelId }: { operations: PlatformOperationDto[]; onCancel?: (operationId: string) => void | Promise<void>; pendingCancelId?: string | null }) {
  return <div className="operation-table">{operations.map((operation) => <div key={operation.id}><span className="operation-table__icon">{operation.state === "completed" ? <Check aria-hidden="true" /> : operation.state === "failed" ? <TriangleAlert aria-hidden="true" /> : <Activity aria-hidden="true" />}</span><span><strong>{operation.kind.replaceAll("-", " ")}</strong><small>{operation.targetType} · {operation.targetId}</small></span><StatePill state={operation.state === "completed" ? "ready" : operation.state === "failed" ? "degraded" : "unknown"} label={operation.state} /><span><TimeValue value={operation.updatedAt} /></span>{onCancel && ["pending", "running"].includes(operation.state) ? <Button variant="danger" pending={pendingCancelId === operation.id} onClick={() => void onCancel(operation.id)}>Cancel</Button> : null}</div>)}</div>;
}

function DiagnosticCard({ check }: { check: DoctorCheckDto }) {
  const Icon = check.state === "pass" ? ShieldCheck : check.state === "fail" ? TriangleAlert : check.state === "warning" ? Wrench : CircleHelp;
  return <article className={`diagnostic-card diagnostic-card--${check.state}`}><span><Icon aria-hidden="true" /></span><div><strong>{check.label}</strong><p>{check.message}</p>{check.repairable ? <small>Managed repair available</small> : <small>Read-only evidence</small>}</div></article>;
}

function EvidenceRow({ icon, label, state, detail }: { icon: ReactNode; label: string; state: EvidenceState; detail: string }) {
  return <div className="evidence-row"><span>{icon}</span><div><strong>{label}</strong><small>{detail}</small></div><StatePill state={state} /></div>;
}

function EvidenceDot({ label, state }: { label: string; state: EvidenceState }) {
  return <span className={`evidence-dot evidence-dot--${state}`}><i aria-hidden="true" />{label}: {state}</span>;
}

function StatePill({ state, label = state }: { state: EvidenceState; label?: string }) {
  return <span className={`state-pill state-pill--${state}`}><i aria-hidden="true" />{label.replaceAll("-", " ")}</span>;
}

function SetupStep({ number, title, detail, state }: { number: string; title: string; detail: string; state: "complete" | "current" | "pending" }) {
  return <li className={`setup-step setup-step--${state}`}><span>{state === "complete" ? <Check aria-hidden="true" /> : number}</span><div><strong>{title}</strong><small>{detail}</small></div></li>;
}

function Capability({ label, state }: { label: string; state: "native" | "derived" | "verified" | "unsupported" }) {
  return <div className={`capability capability--${state}`}><span>{state === "unsupported" ? <CircleHelp aria-hidden="true" /> : state === "derived" ? <Network aria-hidden="true" /> : <Check aria-hidden="true" />}</span><strong>{label}</strong><small>{state}</small></div>;
}

function FlowStep({ icon, label, detail }: { icon: ReactNode; label: string; detail: string }) {
  return <div className="flow-step"><span>{icon}</span><strong>{label}</strong><small>{detail}</small></div>;
}

function Review({ term, value }: { term: string; value: string }) { return <div><dt>{term}</dt><dd>{value}</dd></div>; }
function tokens(value: number | null, estimated = false): string { return value === null ? "Unavailable" : `${value.toLocaleString()}${estimated ? " estimated" : " tokens"}`; }
function localModelEvidence(state: LocalModelDto["state"]): EvidenceState {
  if (state === "validated") return "ready";
  if (state === "failed") return "degraded";
  if (state === "downloading" || state === "removing") return "unknown";
  return "stale";
}
function formatBytes(value: number | null): string {
  if (value === null) return "size unknown";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = value / 1024;
  let unit = units[0]!;
  for (let index = 1; index < units.length && amount >= 1024; index += 1) { amount /= 1024; unit = units[index]!; }
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${unit}`;
}

function PlatformPage({ title, eyebrow, description, actions, children }: { title: string; eyebrow: string; description: string; actions?: ReactNode; children: ReactNode }) {
  useEffect(() => { document.title = `${title} · Codex Router`; document.querySelector<HTMLElement>("#main-content")?.focus({ preventScroll: true }); }, [title]);
  return <div className="page platform-page"><header className="page-header"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{actions ? <div className="page-actions">{actions}</div> : null}</header>{children}</div>;
}

function errorMessage(error: unknown): string {
  if (error instanceof ConsoleApiError) return `${error.message} (${error.payload.code}; operation ${error.payload.operationId})`;
  return error instanceof Error ? error.message : "Unknown platform error";
}
