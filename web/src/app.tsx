import {
  Activity,
  BellRing,
  BrainCircuit,
  Boxes,
  ChevronLeft,
  ChevronRight,
  Command,
  FileClock,
  FolderGit2,
  Gauge,
  HardDrive,
  Inbox,
  KeyRound,
  LayoutDashboard,
  Menu,
  Moon,
  Plus,
  Search,
  Server,
  Settings,
  Stethoscope,
  Sun,
  Waypoints,
  X
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConsoleApi } from "./api";
import { ConnectionBadge, IconButton, InlineNotice } from "./components";
import {
  AgentDetailPage,
  AgentsPage,
  AttentionPage,
  EventsPage,
  MonitorPage,
  NewAgentPage,
  OverviewPage,
  RuntimesPage,
  RuntimeDetailPage,
  SettingsPage,
  WorktreesPage,
  type PageProps
} from "./pages";
import {
  AccountsPage,
  LocalModelsPage,
  ModelsPage,
  PlatformDiagnosticsPage,
  ProvidersPage,
  RequestsPage,
  RoutingPage,
  UsagePage
} from "./platform-pages";
import type { BootstrapDto, ConnectionState } from "./types";

const api = new ConsoleApi();
let initialization: Promise<BootstrapDto> | null = null;

const NAVIGATION = [
  { href: "/overview", label: "Overview", icon: LayoutDashboard },
  { href: "/agents", label: "Agents", icon: Boxes },
  { href: "/attention", label: "Attention", icon: Inbox },
  { href: "/providers", label: "Providers", icon: Server },
  { href: "/accounts", label: "Accounts", icon: KeyRound },
  { href: "/models", label: "Models", icon: BrainCircuit },
  { href: "/routing", label: "Routing", icon: Waypoints },
  { href: "/requests", label: "Requests", icon: Activity },
  { href: "/usage", label: "Usage", icon: Gauge },
  { href: "/local-models", label: "Local Models", icon: HardDrive },
  { href: "/diagnostics", label: "Diagnostics", icon: Stethoscope },
  { href: "/runtimes", label: "Runtimes", icon: Server },
  { href: "/worktrees", label: "Worktrees", icon: FolderGit2 },
  { href: "/events", label: "Events", icon: FileClock },
  { href: "/settings/runtimes", label: "Settings", icon: Settings }
] as const;

export function App() {
  const [data, setData] = useState<BootstrapDto | null>(null);
  const [connection, setConnection] = useState<ConnectionState>(navigator.onLine ? "reconnecting" : "offline");
  const [error, setError] = useState<string | null>(null);
  const [route, setRoute] = useState(() => currentRoute());
  const [palette, setPalette] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("codex-router:rail") === "collapsed");
  const [theme, setTheme] = useState<"system" | "light" | "dark">(() => (localStorage.getItem("codex-router:theme") as "system" | "light" | "dark" | null) ?? "system");
  const ready = Boolean(data);

  const navigate = useCallback((href: string) => {
    if (
      window.location.pathname === "/agents/new" &&
      document.documentElement.dataset.composerDirty === "true" &&
      !window.confirm("Discard this unsaved agent draft?")
    ) return;
    history.pushState({}, "", href);
    setRoute(currentRoute());
    setPalette(false);
    window.scrollTo({ top: 0 });
  }, []);

  const refresh = useCallback(async () => {
    const next = await api.initialize();
    setData(next);
    setError(null);
  }, []);

  useEffect(() => {
    const popstate = () => setRoute(currentRoute());
    window.addEventListener("popstate", popstate);
    return () => window.removeEventListener("popstate", popstate);
  }, []);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette((value) => !value);
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, []);

  useEffect(() => {
    if (!initialization) initialization = api.initialize();
    void initialization.then((next) => {
      setData(next);
      setConnection("live");
      if (window.location.pathname === "/") navigate("/overview");
    }).catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : "The Console could not establish a session.");
      setConnection(navigator.onLine ? "stale" : "offline");
    });
  }, [navigate]);

  useEffect(() => {
    if (!data) return;
    return api.connectStream(
      data.router.registryVersion,
      (snapshot) => setData((current) => !current || snapshot.router.registryVersion >= current.router.registryVersion ? snapshot : current),
      setConnection
    );
  }, [ready]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("codex-router:theme", theme);
  }, [theme]);

  if (!data) return <AccessState error={error} onRetry={() => { initialization = null; window.location.reload(); }} />;

  const pageProps: PageProps = { api, data, connection, navigate, refresh };
  return (
    <div className={`app-shell ${collapsed ? "app-shell--collapsed" : ""}`}>
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <a className="skip-link skip-link--attention" href="/attention" onClick={(event) => { event.preventDefault(); navigate("/attention"); }}>Skip to attention inbox</a>
      <aside className="rail" aria-label="Primary navigation">
        <div className="rail__brand"><span className="brand-mark"><Command aria-hidden="true" /></span><span><strong>Codex Router</strong><small>Console</small></span></div>
        <nav>{NAVIGATION.map(({ href, label, icon: Icon }) => <button key={href} aria-current={matchesRoute(route.pathname, href) ? "page" : undefined} onClick={() => navigate(href)} title={collapsed ? label : undefined}><Icon aria-hidden="true" /><span>{label}</span>{label === "Attention" && data.summary.attention > 0 ? <b aria-label={`${data.summary.attention} pending`}>{data.summary.attention}</b> : null}</button>)}</nav>
        <button className="rail__collapse" onClick={() => setCollapsed((value) => { localStorage.setItem("codex-router:rail", value ? "expanded" : "collapsed"); return !value; })}>{collapsed ? <ChevronRight aria-hidden="true" /> : <ChevronLeft aria-hidden="true" />}<span>{collapsed ? "Expand" : "Collapse"}</span></button>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="topbar__route"><span>{routeTitle(route.pathname)}</span><small>Registry v{data.router.registryVersion}</small></div>
          <button className="command-trigger" onClick={() => setPalette(true)}><Search aria-hidden="true" /><span>Search or run a command</span><kbd>{navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl"} K</kbd></button>
          <div className="topbar__tools"><ConnectionBadge state={connection} /><span className="version">Router {data.router.version}</span><IconButton label={`Theme: ${theme}. Change theme.`} onClick={() => setTheme((value) => value === "system" ? "light" : value === "light" ? "dark" : "system")}>{theme === "light" ? <Sun aria-hidden="true" /> : theme === "dark" ? <Moon aria-hidden="true" /> : <span className="system-theme">A</span>}</IconButton><IconButton label="Open navigation" className="mobile-menu" onClick={() => setPalette(true)}><Menu aria-hidden="true" /></IconButton></div>
        </header>
        {connection !== "live" ? <div className={`connection-banner connection-banner--${connection}`} role="status"><BellRing aria-hidden="true" /><span><strong>{connection === "reconnecting" ? "Reconnecting to durable state" : connection === "stale" ? "State is stale" : "Console is offline"}</strong>{connection === "stale" ? `Last updated ${new Date(data.router.generatedAt).toLocaleTimeString()}.` : " Mutating actions are disabled until the current registry state is known."}</span>{connection === "stale" ? <button onClick={() => void refresh()}>Refresh snapshot</button> : null}</div> : null}
        <main id="main-content" tabIndex={-1}>{renderRoute(route.pathname, pageProps)}</main>
      </div>
      <nav className="mobile-nav" aria-label="Mobile primary navigation">{NAVIGATION.map(({ href, label, icon: Icon }) => <button key={href} aria-current={matchesRoute(route.pathname, href) ? "page" : undefined} onClick={() => navigate(href)}><Icon aria-hidden="true" /><span>{label}</span>{label === "Attention" && data.summary.attention > 0 ? <b>{data.summary.attention}</b> : null}</button>)}</nav>
      <CommandPalette open={palette} onClose={() => setPalette(false)} data={data} navigate={navigate} />
      <div className="sr-only" aria-live="polite">Connection {connection}. Registry version {data.router.registryVersion}.</div>
    </div>
  );
}

function renderRoute(pathname: string, props: PageProps): ReactNode {
  if (pathname === "/" || pathname === "/overview") return <OverviewPage {...props} />;
  if (pathname === "/agents") return <AgentsPage {...props} />;
  if (pathname === "/agents/new") return <NewAgentPage {...props} />;
  if (pathname === "/agents/monitor") return <MonitorPage {...props} />;
  if (/^\/agents\/[^/]+$/.test(pathname)) return <AgentDetailPage {...props} agentId={pathname.split("/")[2]!} />;
  if (pathname === "/attention") return <AttentionPage {...props} />;
  if (pathname === "/providers") return <ProvidersPage {...props} />;
  if (/^\/providers\/[^/]+$/.test(pathname)) return <ProvidersPage {...props} providerId={decodeURIComponent(pathname.split("/")[2]!)} />;
  if (pathname === "/accounts") return <AccountsPage {...props} />;
  if (pathname === "/models") return <ModelsPage {...props} />;
  if (/^\/models\/[^/]+$/.test(pathname)) return <ModelsPage {...props} modelId={decodeURIComponent(pathname.split("/")[2]!)} />;
  if (pathname === "/routing") return <RoutingPage {...props} />;
  if (pathname === "/requests") return <RequestsPage {...props} />;
  if (/^\/requests\/[^/]+$/.test(pathname)) return <RequestsPage {...props} requestId={decodeURIComponent(pathname.split("/")[2]!)} />;
  if (pathname === "/usage") return <UsagePage {...props} />;
  if (pathname === "/local-models") return <LocalModelsPage {...props} />;
  if (pathname === "/diagnostics") return <PlatformDiagnosticsPage {...props} />;
  if (pathname === "/runtimes") return <RuntimesPage {...props} />;
  if (/^\/runtimes\/[^/]+$/.test(pathname)) return <RuntimeDetailPage {...props} runtimeId={pathname.split("/")[2]!} />;
  if (pathname === "/worktrees") return <WorktreesPage {...props} />;
  if (pathname === "/events") return <EventsPage {...props} />;
  if (pathname === "/settings" || pathname.startsWith("/settings/")) return <SettingsPage {...props} />;
  return <div className="not-found"><h1>Route not found</h1><p>This Console route does not exist or is outside the current schema.</p><button onClick={() => props.navigate("/overview")}>Return to overview</button></div>;
}

function CommandPalette({ open, onClose, data, navigate }: { open: boolean; onClose: () => void; data: BootstrapDto; navigate: (href: string) => void }) {
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const previous = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    previous.current = document.activeElement as HTMLElement | null;
    input.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); previous.current?.focus(); };
  }, [onClose, open]);
  useEffect(() => { if (!open) setQuery(""); }, [open]);
  if (!open) return null;
  const commands = [
    { label: "Start a new agent", detail: "Lifecycle command", href: "/agents/new", icon: Plus },
    ...NAVIGATION.map((item) => ({ label: `Open ${item.label}`, detail: "Navigate", href: item.href, icon: item.icon })),
    ...data.agents.slice(0, 30).map((agent) => ({ label: agent.taskSummary, detail: agent.id, href: `/agents/${encodeURIComponent(agent.id)}`, icon: Activity }))
  ].filter((command) => `${command.label} ${command.detail}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="palette-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="palette" role="dialog" aria-modal="true" aria-label="Command palette"><label className="palette__search"><Search aria-hidden="true" /><input ref={input} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search agents, routes, or commands" /><kbd>Esc</kbd></label><div className="palette__results">{commands.length ? commands.map(({ label, detail, href, icon: Icon }) => <button key={`${href}:${label}`} onClick={() => navigate(href)}><Icon aria-hidden="true" /><span><strong>{label}</strong><small>{detail}</small></span><ChevronRight aria-hidden="true" /></button>) : <div className="palette__empty">No matching command</div>}</div></div></div>;
}

function AccessState({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  return <main className="access-state"><div className="access-panel"><span className="brand-mark brand-mark--large"><Command aria-hidden="true" /></span><span className="eyebrow">Codex Router Console</span><h1>{error ? "Console session unavailable" : "Opening operations desk"}</h1>{error ? <><InlineNotice tone="warning" title="A one-time local session is required">{error}</InlineNotice><p>Launch with <code>codex-router web --open</code>. The fragment token is exchanged once, removed from browser history, and replaced by an HttpOnly session cookie.</p><button className="button button--primary" onClick={onRetry}>Try again</button></> : <div className="boot-lines" role="status" aria-label="Loading"><span /><span /><span /></div>}</div></main>;
}

function currentRoute() {
  return { pathname: window.location.pathname, search: window.location.search };
}

function matchesRoute(pathname: string, href: string): boolean {
  const root = href.split("/")[1];
  return pathname === href || Boolean(root && pathname.startsWith(`/${root}/`));
}

function routeTitle(pathname: string): string {
  if (pathname.startsWith("/agents/new")) return "Start agent";
  if (pathname.startsWith("/agents/monitor")) return "Monitor";
  if (/^\/agents\//.test(pathname)) return "Agent detail";
  if (/^\/runtimes\//.test(pathname)) return "Runtime detail";
  const entry = NAVIGATION.find((item) => matchesRoute(pathname, item.href));
  return entry?.label ?? "Console";
}
