import {
  AlertCircle,
  Check,
  CheckCircle2,
  Circle,
  CircleStop,
  Clock3,
  Copy,
  LoaderCircle,
  Pause,
  RefreshCw,
  TriangleAlert,
  X,
  XCircle
} from "lucide-react";
import {
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  useEffect,
  useRef,
  useState
} from "react";
import type { AgentStatus, ConnectionState, RuntimeState } from "./types";
import { CONNECTION_LABELS, exactTime, middleTruncate, relativeTime, STATUS_LABELS } from "./presentation";

type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";

export function Button({
  children,
  variant = "secondary",
  pending = false,
  className = "",
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; pending?: boolean }) {
  return (
    <button
      className={`button button--${variant} ${className}`}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      {...props}
    >
      {pending ? <LoaderCircle aria-hidden="true" className="spin" /> : null}
      <span>{children}</span>
    </button>
  );
}

export function IconButton({ label, children, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
}) {
  return (
    <button className={`icon-button ${className}`} aria-label={label} title={label} {...props}>
      {children}
    </button>
  );
}

export function StatusBadge({ status }: { status: AgentStatus | RuntimeState }) {
  const Icon = statusIcon(status);
  const label = isAgentStatus(status) ? STATUS_LABELS[status] : runtimeLabel(status);
  return (
    <span className={`status-badge status-badge--${status}`}>
      <Icon aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

export function ConnectionBadge({ state }: { state: ConnectionState }) {
  const Icon = state === "live" ? Circle : state === "reconnecting" ? RefreshCw : state === "stale" ? Clock3 : XCircle;
  return (
    <span className={`connection connection--${state}`} role="status" aria-label={`Connection: ${CONNECTION_LABELS[state]}`}>
      <Icon aria-hidden="true" className={state === "reconnecting" ? "spin" : ""} />
      <span>{CONNECTION_LABELS[state]}</span>
    </span>
  );
}

export function MachineValue({ value, label, length = 28 }: { value: string | null | undefined; label: string; length?: number }) {
  const shown = value ?? "Not assigned";
  return (
    <span className="machine-value" title={value ? `${label}: ${value}` : `${label}: not assigned`}>
      <span className="sr-only">{label}: </span>
      <code>{value ? middleTruncate(value, length) : shown}</code>
      {value ? <CopyButton value={value} label={`Copy ${label}`} /> : null}
    </span>
  );
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <IconButton
      label={copied ? "Copied" : label}
      className="copy-button"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1_500);
        });
      }}
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
    </IconButton>
  );
}

export function Section({ title, description, action, children, className = "", ...props }: HTMLAttributes<HTMLElement> & {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <section className={`section ${className}`} {...props}>
      <div className="section__header">
        <div>
          <h2>{title}</h2>
          {description ? <p>{description}</p> : null}
        </div>
        {action ? <div className="section__action">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function Metric({ label, value, detail, tone = "neutral" }: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: "neutral" | "attention" | "danger";
}) {
  return (
    <div className={`metric metric--${tone}`}>
      <span className="metric__label">{label}</span>
      <strong>{value}</strong>
      {detail ? <span className="metric__detail">{detail}</span> : null}
    </div>
  );
}

export function EmptyState({ icon, title, description, action }: {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      {icon ? <div className="empty-state__icon">{icon}</div> : null}
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function InlineNotice({ tone = "info", title, children }: {
  tone?: "info" | "warning" | "danger" | "success";
  title: string;
  children?: ReactNode;
}) {
  const Icon = tone === "danger" ? XCircle : tone === "warning" ? TriangleAlert : tone === "success" ? CheckCircle2 : AlertCircle;
  return (
    <div className={`notice notice--${tone}`} role={tone === "danger" ? "alert" : "status"}>
      <Icon aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        {children ? <div className="notice__body">{children}</div> : null}
      </div>
    </div>
  );
}

export function TimeValue({ value }: { value: string }) {
  return (
    <time dateTime={value} title={exactTime(value)}>
      {relativeTime(value)}
    </time>
  );
}

export function QuotaBar({ value, label, reset }: { value: number | undefined; label: string; reset?: number | undefined }) {
  if (value === undefined) {
    return (
      <div className="quota quota--unknown" role="status" aria-label={`${label}: unknown`}>
        <span className="quota__track"><span /></span>
        <span>Unknown</span>
      </div>
    );
  }
  const bucket = value >= 95 ? 100 : value >= 80 ? 85 : value >= 50 ? 60 : value >= 25 ? 35 : value > 0 ? 10 : 0;
  const resetCopy = reset ? `, resets ${relativeTime(new Date(reset * 1000).toISOString())}` : "";
  return (
    <div className={`quota quota--${bucket}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value)} aria-label={`${label}: ${Math.round(value)} percent used${resetCopy}`}>
      <span className="quota__track"><span /></span>
      <span>{Math.round(value)}%</span>
    </div>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className={`field ${error ? "field--error" : ""}`}>
      <span className="field__label">{label}</span>
      {children}
      {error ? <span className="field__error">{error}</span> : hint ? <span className="field__hint">{hint}</span> : null}
    </label>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className="text-input" {...props} />;
}

export function Modal({ title, description, open, onClose, children, footer }: {
  title: string;
  description?: string | undefined;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement as HTMLElement | null;
    const frame = window.requestAnimationFrame(() => {
      panel.current?.querySelector<HTMLElement>("[autofocus], button, input, textarea, select")?.focus();
    });
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panel.current) return;
      const focusable = [...panel.current.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex='-1'])")];
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", keydown);
      previousFocus.current?.focus();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" aria-describedby={description ? "modal-description" : undefined} ref={panel}>
        <div className="modal__header">
          <div>
            <h2 id="modal-title">{title}</h2>
            {description ? <p id="modal-description">{description}</p> : null}
          </div>
          <IconButton label="Close dialog" onClick={onClose}><X aria-hidden="true" /></IconButton>
        </div>
        <div className="modal__body">{children}</div>
        {footer ? <div className="modal__footer">{footer}</div> : null}
      </div>
    </div>
  );
}

function isAgentStatus(value: AgentStatus | RuntimeState): value is AgentStatus {
  return value in STATUS_LABELS;
}

function runtimeLabel(status: RuntimeState): string {
  return status.charAt(0).toUpperCase() + status.slice(1).replaceAll("_", " ");
}

function statusIcon(status: AgentStatus | RuntimeState) {
  if (status === "completed" || status === "ready") return CheckCircle2;
  if (status === "failed" || status === "offline") return XCircle;
  if (status === "needs_attention" || status === "limited" || status === "degraded") return TriangleAlert;
  if (status === "interrupted") return CircleStop;
  if (status === "cancelling" || status === "draining") return Pause;
  if (status === "queued" || status === "waiting_for_reset") return Clock3;
  if (status === "starting" || status === "handing_off") return RefreshCw;
  return Circle;
}
