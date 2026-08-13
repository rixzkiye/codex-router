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
  FileSearch,
  Gauge,
  HardDrive,
  KeyRound,
  Network,
  RefreshCcw,
  Route,
  Search,
  ShieldCheck,
  Stethoscope,
  TriangleAlert,
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
  const models = data.platform.models.filter((model) => model.providerVariant === provider.id);
  const run = async (action: "validate" | "discover" | "enable" | "disable") => {
    setPending(action); setError(null);
    try {
      await api.mutate(`/api/v1/providers/${encodeURIComponent(provider.id)}/${action}`, "POST", {
        idempotencyKey: newIdempotencyKey(), expectedVersion: provider.version
      });
      await refresh();
    } catch (caught) { setError(errorMessage(caught)); } finally { setPending(null); }
  };
  const authReady = provider.authentication.state === "ready" || provider.authBoundary.mechanism === "keyless";
  return (
    <PlatformPage title={provider.displayName} eyebrow="Provider workbench" description={`${provider.id} · ${provider.publication.replaceAll("-", " ")}`} actions={<Button onClick={() => navigate("/providers")}>All providers</Button>}>
      {error ? <InlineNotice tone="danger" title="Operation not accepted">{error}</InlineNotice> : null}
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
  const recent = data.platform.requests.slice(0, 10);
  return (
    <PlatformPage title="Routing" eyebrow="Decision authority" description="Eligibility precedes scoring; affinity and semantic-output boundaries are never soft preferences.">
      <div className="routing-rule"><span><ShieldCheck aria-hidden="true" /></span><div><strong>Replay boundary</strong><p>Once text, reasoning, a tool call, command, approval, file mutation, or other semantic output is observed, the attempt is final.</p></div></div>
      <div className="routing-flow" aria-label="Routing decision stages"><FlowStep icon={<KeyRound />} label="Identity" detail="credential boundary" /><ArrowRight aria-hidden="true" /><FlowStep icon={<BadgeCheck />} label="Eligibility" detail="capability + health" /><ArrowRight aria-hidden="true" /><FlowStep icon={<Route />} label="Affinity" detail="thread + account" /><ArrowRight aria-hidden="true" /><FlowStep icon={<Activity />} label="Attempt" detail="observed boundary" /></div>
      <Section title="Recent decisions" description="Safe identity and timing only; prompts and response bodies are excluded.">{recent.length ? <RequestRows requests={recent} navigate={navigate} /> : <EmptyState title="No inference decisions recorded" description="Requests appear after traffic passes through the instrumented inference edge." />}</Section>
    </PlatformPage>
  );
}

export function RequestsPage(props: PageProps & { requestId?: string }) {
  const selected = props.requestId ? props.data.platform.requests.find((request) => request.id === props.requestId) : null;
  if (selected) return <RequestInspector {...props} request={selected} />;
  return <PlatformPage title="Requests" eyebrow="Sanitized evidence" description="Attempts, semantic boundaries, transformations, and usage—without prompt or private response content."><Section title="Request history" description={`${props.data.platform.requests.length} recent safe summaries.`}>{props.data.platform.requests.length ? <RequestRows requests={props.data.platform.requests} navigate={props.navigate} /> : <EmptyState title="No request summaries" description="Start the inference edge with the same database to project request evidence here." />}</Section></PlatformPage>;
}

function RequestInspector({ request, navigate }: PageProps & { request: InferenceRequestDto }) {
  const times = [
    ["Accepted", request.startedAt], ["Upstream connected", request.connectedAt], ["First semantic output", request.firstSemanticAt], ["Terminal", request.completedAt]
  ] as const;
  return <PlatformPage title="Request inspector" eyebrow="Sanitized attempt" description={request.id} actions={<Button onClick={() => navigate("/requests")}>All requests</Button>}>
    <div className="request-boundary"><StatePill state={request.status === "completed" ? "ready" : request.errorClass ? "degraded" : "unknown"} label={request.status} /><span>{request.providerId}</span><span>{request.modelId}</span><MachineValue value={request.attemptId} label="attempt ID" /></div>
    <Section title="Attempt timeline" description="The semantic boundary determines retry and failover legality."><ol className="attempt-timeline">{times.map(([label, value], index) => <li key={label} className={value ? "attempt-timeline__observed" : ""}><span>{value ? <Check aria-hidden="true" /> : index === 2 ? <ShieldCheck aria-hidden="true" /> : <CircleHelp aria-hidden="true" />}</span><div><strong>{label}</strong><small>{value ? <TimeValue value={value} /> : "Not observed"}</small></div></li>)}</ol>{request.semanticOutputObserved ? <InlineNotice tone="warning" title="Replay is closed">Semantic output was observed. Recovery requires an explicit new boundary, never transparent replay.</InlineNotice> : <InlineNotice tone="info" title="No semantic output observed">This record alone does not authorize retry; the failure class must also prove origin safety.</InlineNotice>}</Section>
    <div className="overview-grid"><Section title="Identity boundaries"><dl className="detail-list"><Review term="Caller" value={request.callerClass} /><Review term="Runtime" value={request.runtimeId ?? "Direct client"} /><Review term="Provider" value={request.providerId} /><Review term="Account reference" value={request.accountRefId ?? "None"} /><Review term="Model" value={request.modelId} /><Review term="Profile hash" value={request.profileHash.slice(0, 16)} /></dl></Section><Section title="Usage evidence"><dl className="detail-list"><Review term="Provider input" value={tokens(request.usage.providerInputTokens)} /><Review term="Provider output" value={tokens(request.usage.providerOutputTokens)} /><Review term="Cached input" value={tokens(request.usage.cachedInputTokens)} /><Review term="Reasoning" value={tokens(request.usage.reasoningTokens)} /><Review term="Estimated input" value={tokens(request.usage.estimatedInputTokens, true)} /></dl></Section></div>
    <Section title="Transformations" description="Categories only; transformed prompt bodies are not retained.">{request.flags.length ? <div className="token-row">{request.flags.map((flag) => <span className="token" key={flag}>{flag.replaceAll(".", " · ")}</span>)}</div> : <EmptyState title="No transformations recorded" description="The effective request profile did not report a normalized field change." />}</Section>
  </PlatformPage>;
}

export function UsagePage({ data }: PageProps) {
  const totals = data.platform.usage.totals;
  const input = totals.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0);
  const output = totals.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0);
  return <PlatformPage title="Usage" eyebrow="Provider truth" description="Reported tokens and router estimates stay visibly separate."><div className="metric-grid"><Metric label="Requests" value={totals.reduce((sum, row) => sum + row.requests, 0)} detail="recorded usage events" /><Metric label="Input" value={input.toLocaleString()} detail="provider reported" /><Metric label="Output" value={output.toLocaleString()} detail="provider reported" /><Metric label="Cost" value="Unavailable" detail="no versioned pricing proof" /></div><Section title="Usage by route" description={data.platform.usage.provenance}>{totals.length ? <div className="usage-table">{totals.map((row) => <div key={`${row.providerId}:${row.modelId}`}><span><strong>{row.modelId}</strong><small>{row.providerId}</small></span><span>{row.requests} req</span><span>{tokens(row.inputTokens)} in</span><span>{tokens(row.outputTokens)} out</span><span>{row.estimatedInputTokens === null ? "No estimate" : `${row.estimatedInputTokens.toLocaleString()} estimated`}</span></div>)}</div> : <EmptyState title="Usage is unavailable" description="Unavailable metrics stay unavailable; they are never rendered as zero." />}</Section></PlatformPage>;
}

export function LocalModelsPage({ data, navigate }: PageProps) {
  return <PlatformPage title="Local Models" eyebrow="Experimental boundary" description="Selection, download, enablement, and deletion are separate operations with explicit consent.">{data.platform.localModels.length ? <Section title="Configured local models" description="Capability claims still require repeated agent checks."><ModelRows models={data.platform.localModels} navigate={navigate} /></Section> : <EmptyState icon={<HardDrive />} title="No local model configured" description="The loopback provider is registered, but this build will not invent installed models or start a multi-gigabyte download without explicit runtime evidence and consent." action={<Button onClick={() => navigate("/providers/local")}>Inspect local provider</Button>} />}</PlatformPage>;
}

export function PlatformDiagnosticsPage({ data }: PageProps) {
  const checks = data.platform.diagnostics;
  return <PlatformPage title="Diagnostics" eyebrow="Read-only by default" description="Ownership, integrity, process health, and generated-artifact drift are independent checks."><div className="diagnostic-grid">{checks.map((check) => <DiagnosticCard key={check.id} check={check} />)}</div><Section title="Generation manifest" description="Catalog, route, and translator artifacts share one identity.">{data.platform.registry.manifest ? <dl className="detail-list detail-list--columns"><Review term="Registry hash" value={data.platform.registry.manifest.registryHash} /><Review term="Routes hash" value={data.platform.registry.manifest.routesHash} /><Review term="LiteLLM hash" value={data.platform.registry.manifest.litellmHash} /><Review term="Generated" value={data.platform.registry.manifest.generatedAt} /></dl> : <InlineNotice tone="info" title="Inference generation is not configured">Agent lifecycle remains available independently.</InlineNotice>}</Section><Section title="Capability ledger" description="No reference capability is silently dropped."><div className="ledger-table">{data.platform.capabilityLedger.map((entry) => <details key={entry.id}><summary><span><strong>{entry.capability}</strong><small>Phase {entry.phase} · {entry.owner}</small></span><span className={`ledger-state ledger-state--${entry.disposition}`}>{entry.disposition}</span></summary><p>{entry.evidence}</p></details>)}</div></Section><Section title="Recent operations" description="Acceptance, progress, and terminal state are not conflated.">{data.platform.operations.length ? <OperationRows operations={data.platform.operations} /> : <EmptyState title="No platform operations" description="Provider and model mutations appear here after durable acceptance." />}</Section></PlatformPage>;
}

function ModelRows({ models, navigate }: { models: ModelDto[]; navigate: (href: string) => void }) {
  return <div className="model-table">{models.map((model) => <button key={model.gatewayId} className="model-row pressable" onClick={() => navigate(`/models/${encodeURIComponent(model.gatewayId)}`)}><span><strong>{model.displayName}</strong><small>{model.gatewayId}</small></span><span>{model.providerVariant}</span><span className="model-row__caps">{model.capabilities.tools ? <b>Tools</b> : null}{model.capabilities.compaction ? <b>Compact</b> : null}{model.capabilities.nativeImage ? <b>Vision</b> : model.capabilities.derivedImage ? <b>Bridge</b> : null}</span><StatePill state={model.enabled ? model.compatibility.live : "unavailable"} label={model.enabled ? model.publication : "hidden"} /><ChevronRight aria-hidden="true" /></button>)}</div>;
}

function RequestRows({ requests, navigate }: { requests: InferenceRequestDto[]; navigate: (href: string) => void }) {
  return <div className="request-table">{requests.map((request) => <button key={request.id} className="request-row pressable" onClick={() => navigate(`/requests/${encodeURIComponent(request.id)}`)}><span className={`request-row__boundary ${request.semanticOutputObserved ? "request-row__boundary--closed" : ""}`} aria-label={request.semanticOutputObserved ? "Semantic output observed" : "No semantic output observed"}><ShieldCheck aria-hidden="true" /></span><span><strong>{request.modelId}</strong><small>{request.providerId} · {request.id}</small></span><StatePill state={request.status === "completed" ? "ready" : request.errorClass ? "degraded" : "unknown"} label={request.status} /><span><TimeValue value={request.startedAt} /></span><ChevronRight aria-hidden="true" /></button>)}</div>;
}

function OperationRows({ operations }: { operations: PlatformOperationDto[] }) {
  return <div className="operation-table">{operations.map((operation) => <div key={operation.id}><span className="operation-table__icon">{operation.state === "completed" ? <Check aria-hidden="true" /> : operation.state === "failed" ? <TriangleAlert aria-hidden="true" /> : <Activity aria-hidden="true" />}</span><span><strong>{operation.kind.replaceAll("-", " ")}</strong><small>{operation.targetType} · {operation.targetId}</small></span><StatePill state={operation.state === "completed" ? "ready" : operation.state === "failed" ? "degraded" : "unknown"} label={operation.state} /><span><TimeValue value={operation.updatedAt} /></span></div>)}</div>;
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

function PlatformPage({ title, eyebrow, description, actions, children }: { title: string; eyebrow: string; description: string; actions?: ReactNode; children: ReactNode }) {
  useEffect(() => { document.title = `${title} · Codex Router`; document.querySelector<HTMLElement>("#main-content")?.focus({ preventScroll: true }); }, [title]);
  return <div className="page platform-page"><header className="page-header"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{actions ? <div className="page-actions">{actions}</div> : null}</header>{children}</div>;
}

function errorMessage(error: unknown): string {
  if (error instanceof ConsoleApiError) return `${error.message} (${error.payload.code}; operation ${error.payload.operationId})`;
  return error instanceof Error ? error.message : "Unknown platform error";
}
