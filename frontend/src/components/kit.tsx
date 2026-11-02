// The ProgramOps primitives. Every screen is composed from these so spacing, type and tone stay
// consistent (Stitch DESIGN.md: flat, 1px lines, Inter for prose, JetBrains Mono for data).
import { Check } from "lucide-react";
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { formatDay, formatWhen } from "@/lib/format";
import { groupLog, splitList, type LogEvent } from "@/lib/history";
import { cn } from "@/lib/utils";

export type Tone =
  | "good"
  | "warning"
  | "serious"
  | "critical"
  | "info"
  | "indigo"
  | "neutral"
  | "csm"
  | "marketing"
  | "am";

/** Team tag tone for a role id (csm / marketing / account_manager); neutral for anything else. */
export const roleTone = (role: string): Tone =>
  role === "csm"
    ? "csm"
    : role === "marketing"
      ? "marketing"
      : role === "account_manager"
        ? "am"
        : "neutral";

/** Status / count chip. */
export function Chip({
  tone = "neutral",
  className,
  children,
  ...rest
}: { tone?: Tone } & ComponentProps<"span">) {
  return (
    <span className={cn("chip", className)} data-tone={tone} {...rest}>
      {children}
    </span>
  );
}

const TONE_TEXT: Record<Tone, string> = {
  good: "text-status-good",
  warning: "text-warn",
  serious: "text-warn",
  critical: "text-status-critical",
  info: "text-primary",
  indigo: "text-team-csm",
  csm: "text-team-csm",
  marketing: "text-team-marketing",
  am: "text-team-am",
  neutral: "text-muted-foreground",
};
const TONE_BG: Record<Tone, string> = {
  good: "bg-status-good",
  warning: "bg-status-warning",
  serious: "bg-status-serious",
  critical: "bg-status-critical",
  info: "bg-accent-fill",
  indigo: "bg-team-csm",
  csm: "bg-team-csm",
  marketing: "bg-team-marketing",
  am: "bg-team-am",
  neutral: "bg-status-neutral",
};
export const toneText = (t: Tone) => TONE_TEXT[t];
export const toneBg = (t: Tone) => TONE_BG[t];

export function Dot({
  tone = "neutral",
  live,
  className,
}: {
  tone?: Tone;
  live?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        TONE_BG[tone],
        live && "live-dot",
        TONE_TEXT[tone],
        className,
      )}
    />
  );
}

/** Card. `interactive` adds the 1px hover lift. */
export function Card({
  className,
  interactive,
  ...rest
}: ComponentProps<"section"> & { interactive?: boolean }) {
  return <section className={cn("surface", interactive && "lift", className)} {...rest} />;
}

/** Card header: title left, mono meta / actions right. Border-bottom only when it heads a list. */
export function CardHeader({
  title,
  icon,
  meta,
  divided,
  className,
}: {
  title: ReactNode;
  icon?: ReactNode;
  meta?: ReactNode;
  divided?: boolean;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "flex items-center justify-between gap-3 px-4 pt-3.5 pb-3",
        divided && "border-b border-border",
        className,
      )}
    >
      <h2 className="flex min-w-0 items-center gap-2 text-[14px] font-semibold leading-5">
        {icon && <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>}
        <span className="truncate">{title}</span>
      </h2>
      {meta && (
        <div className="flex shrink-0 items-center gap-2 t-data-sm text-muted-foreground">
          {meta}
        </div>
      )}
    </header>
  );
}
export const CardBody = ({ className, ...rest }: ComponentProps<"div">) => (
  <div className={cn("px-4 pb-4", className)} {...rest} />
);

/** Mono caption above a figure, e.g. "TOTAL REGISTRATIONS". */
export const MonoLabel = ({ className, ...rest }: ComponentProps<"span">) => (
  <span className={cn("t-mono-label text-muted-foreground", className)} {...rest} />
);

/** Count-up for live figures. Finishes in ~700ms; snaps instantly under reduced motion. */
export function useCountUp(target: number, ms = 700): number {
  const [value, setValue] = useState(target);
  const from = useRef(0);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setValue(target);
      return;
    }
    const start = performance.now();
    const origin = from.current;
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const eased = 1 - Math.pow(1 - t, 4);
      setValue(origin + (target - origin) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
      else from.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return value;
}

/** A number that counts up to its value. */
export function Num({
  value,
  decimals = 0,
  className,
}: {
  value: number;
  decimals?: number;
  className?: string;
}) {
  const v = useCountUp(value);
  return (
    <span className={className}>
      {v.toLocaleString("en-US", {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })}
    </span>
  );
}

/** Horizontal bar that grows in. `pct` is clamped to 0..100. */
export function Bar({
  pct,
  tone = "info",
  index = 0,
  className,
  track = true,
  label = "Progress",
}: {
  pct: number;
  tone?: Tone;
  index?: number;
  className?: string;
  track?: boolean;
  /** What the bar measures, for screen readers. */
  label?: string;
}) {
  return (
    <div
      className={cn("h-1 overflow-hidden rounded-full", track && "bg-border", className)}
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={cn("bar-grow h-full rounded-full", TONE_BG[tone])}
        style={{ width: `${Math.max(0, Math.min(100, pct))}%`, ["--i" as string]: index }}
      />
    </div>
  );
}

/** KPI tile: mono label, big mono figure, optional chip and sub line. */
export function Kpi({
  label,
  value,
  unit,
  sub,
  chip,
  tone,
  icon,
  className,
  index = 0,
}: {
  label: string;
  value: ReactNode;
  unit?: ReactNode;
  sub?: ReactNode;
  chip?: ReactNode;
  tone?: Tone | undefined;
  icon?: ReactNode;
  className?: string | undefined;
  index?: number;
}) {
  return (
    <Card
      className={cn("rise px-[18px] pt-[14px] pb-[14px]", className)}
      style={{ ["--i" as string]: index }}
    >
      <div className="flex items-center justify-between gap-2">
        <MonoLabel className={tone && tone !== "neutral" ? TONE_TEXT[tone] : undefined}>
          {label}
        </MonoLabel>
        {chip ??
          (icon && (
            <span
              className={cn("[&_svg]:size-4", tone ? TONE_TEXT[tone] : "text-muted-foreground")}
            >
              {icon}
            </span>
          ))}
      </div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span className="t-data-lg">{value}</span>
        {unit && <span className="t-data-sm text-muted-foreground">{unit}</span>}
      </div>
      {sub && <div className="mt-1 t-data-sm text-muted-foreground">{sub}</div>}
    </Card>
  );
}

/** Segmented control (8px outer / 6px inner). Controlled, keyboard-friendly buttons. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { id: T; label: ReactNode; count?: number }[];
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={cn("inline-flex rounded-[8px] border border-border bg-secondary p-0.5", className)}
    >
      {options.map((o) => (
        <button
          key={o.id}
          role="tab"
          aria-selected={value === o.id}
          onClick={() => onChange(o.id)}
          className={cn(
            "flex h-7 items-center gap-1.5 rounded-[6px] px-3 text-[13px] font-medium",
            value === o.id
              ? "bg-card text-foreground shadow-sm"
              : "text-secondary-foreground hover:bg-card/70 hover:text-foreground",
          )}
        >
          {o.label}
          {o.count !== undefined && (
            <span className="text-[12px] text-muted-foreground">{o.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/** Round avatar with initials. */
export function Avatar({
  name,
  className,
}: {
  name: string | null | undefined;
  className?: string;
}) {
  const initials =
    (name ?? "?")
      .split(/[\s@.]+/)
      .filter(Boolean)
      .map((p) => p[0])
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?";
  return (
    <span
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-accent-bg text-[11px] font-semibold text-primary",
        className,
      )}
    >
      {initials}
    </span>
  );
}

export function EmptyState({
  title,
  hint,
  icon,
  action,
}: {
  title: string;
  hint?: string;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed border-border px-6 py-8 text-center">
      {icon && <span className="text-muted-foreground [&_svg]:size-5">{icon}</span>}
      <p className="text-[14px] font-medium">{title}</p>
      {hint && <p className="max-w-sm text-[13px] text-muted-foreground">{hint}</p>}
      {action}
    </div>
  );
}

export const Skeleton = ({ className }: { className?: string }) => (
  <div className={cn("skeleton rounded-md", className)} />
);

/** Page frame: consistent title block + fade-in. */
export function PageHeader({
  title,
  subtitle,
  label,
  chip,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  label?: ReactNode;
  chip?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        {/* `label` (the old blue eyebrow above the title) is no longer drawn: say it in the title or the finding. */}
        {label ? <span className="sr-only">{label}</span> : null}
        <h1 className="t-headline-lg flex flex-wrap items-center gap-2.5">
          {title}
          {chip}
        </h1>
        {subtitle && (
          <p className="mt-1 max-w-3xl text-[14px] text-secondary-foreground">{subtitle}</p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Thin hook for keyboard "/" to focus search, etc. */
export function useHotkey(key: string, handler: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        e.key === key &&
        !e.metaKey &&
        !e.ctrlKey &&
        t &&
        !/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) &&
        !t.isContentEditable
      ) {
        e.preventDefault();
        handler();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [key, handler]);
}

// ---- shared vocabulary: health, status, stage, tabs, key numbers, action rows, sync ---------------

export type HealthKey = "good" | "warning" | "critical";
// "Good" is quiet (a dot and plain text); only At risk / Critical get a tinted chip, so colour means "look here".
const HEALTH_PILL: Record<HealthKey, { label: string; cls: string }> = {
  good: { label: "Good", cls: "text-ink-2" },
  warning: { label: "At risk", cls: "bg-warn-bg text-warn px-2 py-1" },
  critical: { label: "Critical", cls: "bg-danger-bg text-danger px-2 py-1" },
};
export const HEALTH_NAMES: Record<HealthKey, string> = {
  good: "Good",
  warning: "At risk",
  critical: "Critical",
};

/** The one health vocabulary: Good / At risk / Critical. Dot + label on a tinted background. */
export function HealthPill({
  health,
  className,
  title,
}: {
  health: HealthKey;
  className?: string;
  title?: string | undefined;
}) {
  const h = HEALTH_PILL[health];
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[4px] text-[13px] font-medium leading-none",
        h.cls,
        className,
      )}
    >
      <span
        aria-hidden
        className={cn("size-1.5 rounded-full", health === "good" ? "bg-ok" : "bg-current")}
      />
      {h.label}
    </span>
  );
}

export type StatusTone = "ok" | "warn" | "danger" | "neutral";
const DOT_FILL: Record<StatusTone, string> = {
  ok: "border-ok bg-ok",
  warn: "border-warn bg-warn",
  danger: "border-danger bg-danger",
  neutral: "border-ink-3 bg-ink-3",
};
/** A small dot with a text label (never colour alone). `hollow` means not done yet. */
export function StatusDot({
  tone = "neutral",
  label,
  hollow,
  size = "sm",
  className,
}: {
  tone?: StatusTone;
  label: ReactNode;
  hollow?: boolean;
  size?: "sm" | "lg";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-ink-2",
        size === "lg" ? "text-[13px]" : "text-[12px]",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "box-border shrink-0",
          size === "lg" ? "size-3" : "size-2",
          "rounded-full border-[1.5px]",
          hollow ? "border-ink-3 bg-transparent" : DOT_FILL[tone],
        )}
      />
      {label}
    </span>
  );
}

export const STAGE_LABELS = [
  "New",
  "Pre sales",
  "Onboarding",
  "Ongoing",
  "Post campaign",
  "Closed",
] as const;

export type StageProgress = { done: number; total: number };

/**
 * Six equal segments. Each fills in proportion to how much of that stage's HubSpot checklist is ticked
 * ("3/5 · 60%"); a stage without a checklist reads full once passed. The current stage's name is bold.
 */
export function StageBar({
  current,
  progress,
  from = 0,
}: {
  current: number;
  progress?: StageProgress[] | undefined;
  /** The first stage shown: an internal hackathon skips feasibility (New and Pre sales). */
  from?: number;
}) {
  return (
    <ol
      aria-label="Lifecycle stage"
      className="grid max-w-[720px] gap-1"
      style={{ gridTemplateColumns: `repeat(${STAGE_LABELS.length - from}, minmax(0, 1fr))` }}
    >
      {STAGE_LABELS.map((label, i) => {
        if (i < from) return null;
        const past = i < current;
        const now = i === current;
        const p = progress?.[i];
        const hasList = !!p && p.total > 0;
        const pct = hasList ? Math.round((100 * p.done) / p.total) : past ? 100 : 0;
        const complete = pct === 100;
        return (
          <li key={label} aria-current={now ? "step" : undefined} className="min-w-0 space-y-1.5">
            <div
              role="progressbar"
              aria-label={`${label} checklist`}
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
              className="h-1 overflow-hidden rounded-full bg-border"
            >
              <div
                className={cn(
                  "bar-grow h-1 rounded-full transition-[width]",
                  // done stages are neutral grey, the current stage is the one blue
                  complete ? "bg-ink-2" : "bg-primary",
                )}
                style={{ width: `${pct}%` }}
              />
            </div>
            <p
              className={cn(
                "flex items-center gap-1 truncate text-[12px]",
                now ? "font-medium text-foreground" : "text-ink-2",
              )}
            >
              {complete && (past || hasList) && (
                <Check aria-hidden className="size-3 shrink-0 text-ink-2" />
              )}
              <span className="truncate">{label}</span>
            </p>
            {hasList && (
              <p className="t-data-sm text-ink-2">
                {p.done}/{p.total} · {pct}%
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export type TabItem = { id: string; label: string; badge?: string | number | undefined };
/**
 * Underline tabs. A badge appears only for counts that need the person's action (pending approvals,
 * due requests), never for plain totals.
 */
export function TabBar({
  items,
  active,
  label,
  renderLink,
}: {
  items: readonly TabItem[];
  active: string;
  label: string;
  renderLink: (
    item: TabItem,
    props: { className: string; "aria-current"?: "page"; children: ReactNode },
  ) => ReactNode;
}) {
  return (
    <nav
      aria-label={label}
      className="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-border"
    >
      {items.map((t) => {
        const on = active === t.id;
        const body = (
          <>
            {t.label}
            {t.badge !== undefined && t.badge !== 0 && (
              <span className="min-w-5 rounded-full bg-accent-bg px-1.5 py-px text-center text-[12px] font-medium text-primary">
                {t.badge}
              </span>
            )}
          </>
        );
        return (
          <span key={t.id} className="shrink-0">
            {renderLink(t, {
              className: cn(
                "-mb-px flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2.5 text-[14px] font-medium",
                on
                  ? "border-primary text-foreground"
                  : "border-transparent text-ink-2 hover:border-border hover:bg-raised hover:text-foreground",
              ),
              ...(on ? { "aria-current": "page" as const } : {}),
              children: body,
            })}
          </span>
        );
      })}
    </nav>
  );
}

const BAR_FILL: Record<StatusTone | "accent", string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
  neutral: "bg-ink-3",
  accent: "bg-primary",
};
const NOTE_TEXT: Record<StatusTone, string> = {
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
  neutral: "text-ink-2",
};
/** Key number: label, value, a thin progress bar and a one-line note. */
export function KpiTile({
  label,
  value,
  pct,
  bar = "accent",
  note,
  noteTone = "neutral",
  className,
}: {
  label: string;
  value: ReactNode;
  pct?: number | null | undefined;
  bar?: StatusTone | "accent";
  note?: ReactNode;
  noteTone?: StatusTone;
  className?: string;
}) {
  return (
    <div className={cn("surface p-4", className)}>
      <p className="text-[13px] text-ink-2">{label}</p>
      <p className="mt-1 text-[26px] font-semibold leading-8 tracking-[-0.01em]">{value}</p>
      <div className="my-2.5 h-1 overflow-hidden rounded-full bg-raised">
        <div
          className={cn("h-1 rounded-full", BAR_FILL[bar])}
          style={{ width: `${Math.max(0, Math.min(100, pct ?? 0))}%` }}
        />
      </div>
      {note && <p className={cn("text-[12px]", NOTE_TEXT[noteTone])}>{note}</p>}
    </div>
  );
}

// A row, not a tinted block: the dot carries the severity.
const ACTION_BG: Record<"danger" | "warn" | "neutral", string> = {
  danger: "",
  warn: "",
  neutral: "",
};
const ACTION_DOT: Record<"danger" | "warn" | "neutral", string> = {
  danger: "bg-danger",
  warn: "bg-warn",
  neutral: "bg-ink-3",
};
/** One thing that needs the person: dot, title, one-line detail and one secondary button. */
export function ActionItem({
  tone,
  title,
  detail,
  action,
}: {
  tone: "danger" | "warn" | "neutral";
  title: ReactNode;
  detail?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0",
        ACTION_BG[tone],
      )}
    >
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", ACTION_DOT[tone])} />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        {detail && <p className="text-[13px] text-ink-2">{detail}</p>}
      </div>
      {action}
    </div>
  );
}

/** "Synced 6 min ago" on one line. The tooltip lists each source's own time. */
export function SyncStatus({
  label,
  stale,
  live,
  detail,
  trailing,
}: {
  label: string;
  stale?: boolean;
  live?: boolean;
  detail: string;
  trailing?: ReactNode;
}) {
  return (
    <span
      title={detail}
      className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12px] text-ink-2"
    >
      <Dot tone={stale ? "warning" : "good"} live={Boolean(live) && !stale} />
      {label}
      {trailing}
    </span>
  );
}

// ---- activity log ---------------------------------------------------------------------------------

const dayLabel = (iso: string) => {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const yesterday = new Date(Date.now() - 864e5).toLocaleDateString("en-CA", {
    timeZone: "Asia/Kolkata",
  });
  return iso === today ? "Today" : iso === yesterday ? "Yesterday" : formatDay(iso);
};

/** A value in a log line: semicolon-joined checklist values become chips, everything else plain text. */
function LogValue({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === "") return <span>empty</span>;
  if (Array.isArray(value)) return <span>{value.length ? value.join(", ") : "none"}</span>;
  if (typeof value === "string" && value.includes(";"))
    return (
      <span className="inline-flex flex-wrap gap-1 align-middle">
        {splitList(value).map((v) => (
          <Chip key={v}>{v}</Chip>
        ))}
      </span>
    );
  return <span>{typeof value === "object" ? JSON.stringify(value) : String(value)}</span>;
}

/**
 * Readable log: grouped by day, one sentence per entry, consecutive edits collapsed, ISO times and ids kept for
 * hover. `sentence` turns an event into the part after the person's name.
 */
export function LogList<T extends LogEvent>({
  events,
  sentence,
}: {
  events: T[];
  sentence: (e: T) => string;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  return (
    <div>
      {groupLog(events, dayLabel).map((day) => (
        <section key={day.day}>
          <h3 className="border-y border-border bg-raised px-5 py-2 text-[12px] font-medium text-ink-2 first:border-t-0">
            {day.label}
          </h3>
          <ul>
            {day.entries.map((en) => {
              const first = en.events[0]!;
              const many = en.events.length > 1;
              const open = expanded[en.key];
              return (
                <li key={en.key} className="border-b border-border px-5 py-2.5 last:border-b-0">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="min-w-0 text-[14px]">
                      <span className="font-medium">{en.actor}</span> {sentence(first)}
                      {many && <span className="text-ink-3"> · {en.events.length} changes</span>}
                      {!many && first.field && (
                        <span className="mt-0.5 block text-[12px] text-ink-3">
                          {first.field.replace(/_/g, " ")}: <LogValue value={first.old} /> →{" "}
                          <span className="text-foreground">
                            <LogValue value={first.new} />
                          </span>
                        </span>
                      )}
                    </p>
                    <time
                      dateTime={first.at}
                      title={`${first.at} · #${first.id}`}
                      className="shrink-0 text-[12px] text-ink-3"
                    >
                      {formatWhen(first.at)}
                    </time>
                  </div>
                  {many && (
                    <>
                      <button
                        type="button"
                        onClick={() => setExpanded({ ...expanded, [en.key]: !open })}
                        className="mt-0.5 text-[12px] text-primary hover:underline"
                      >
                        {open ? "Hide details" : "Show details"}
                      </button>
                      {open && (
                        <ul className="mt-1.5 space-y-1 border-l border-border pl-3 text-[12px] text-ink-2">
                          {en.events.map((ev) => (
                            <li key={ev.id} className="flex justify-between gap-3">
                              <span>
                                {ev.field ? `${ev.field.replace(/_/g, " ")}: ` : ""}
                                <LogValue value={ev.old} /> → <LogValue value={ev.new} />
                              </span>
                              <span className="shrink-0 text-ink-3" title={`${ev.at} · #${ev.id}`}>
                                {formatWhen(ev.at)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

// ---- strips, notices, segmented bars, placeholder slots (the revamp's widget vocabulary) ---------------
// Real data or a missing required field only: no decorative icons, no sparklines on KPIs.

/**
 * One container split by 1px dividers into equal cells (instead of a row of separate KPI tiles). Two
 * columns on a phone, one column per cell from `md`.
 */
export function KpiStrip({
  children,
  className,
  label = "Key numbers",
}: {
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  const n = Array.isArray(children) ? children.filter(Boolean).length : 1;
  return (
    <section
      aria-label={label}
      className={cn(
        "surface reveal grid grid-cols-2 overflow-hidden md:[grid-template-columns:repeat(var(--n),minmax(0,1fr))]",
        className,
      )}
      style={{ ["--n" as string]: n }}
    >
      {children}
    </section>
  );
}

/** One cell of a KpiStrip: label, figure (24px), optional thin bar and one note line. */
export function KpiCell({
  label,
  value,
  unit,
  pct,
  bar = "accent",
  sub,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  pct?: number | null | undefined;
  bar?: StatusTone | "accent";
  sub?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "min-w-0 border-border px-4 py-3.5 max-md:border-t max-md:[&:nth-child(-n+2)]:border-t-0 max-md:[&:nth-child(even)]:border-l md:border-l md:first:border-l-0",
        className,
      )}
    >
      <p className="text-[13px] text-ink-2">{label}</p>
      <p className="mt-0.5 flex items-baseline gap-1.5 t-data-lg">
        {value}
        {unit && <span className="text-[13px] font-normal text-ink-2">{unit}</span>}
      </p>
      {pct !== undefined && pct !== null && (
        <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-border" aria-hidden>
          <div
            className={cn("bar-grow h-1 rounded-full", BAR_FILL[bar])}
            style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
          />
        </div>
      )}
      {sub && <p className="mt-1.5 text-[13px] text-ink-2">{sub}</p>}
    </div>
  );
}

/** A quiet one-line notice with a status dot and optional actions. Not a tinted banner. */
export function Notice({
  tone = "warn",
  children,
  actions,
  className,
}: {
  tone?: StatusTone;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "surface rise flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-2.5 text-[13px] text-ink-2",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          ACTION_DOT[tone === "ok" ? "neutral" : tone],
        )}
      />
      <div className="min-w-0 flex-1 [&_b]:font-medium [&_b]:text-foreground">{children}</div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** A horizontal bar split into proportional parts (pipeline by stage, organic vs other). One hue. */
export function SegBar({
  parts,
  label,
}: {
  parts: { label?: ReactNode; value: number; muted?: boolean }[];
  label: string;
}) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  return (
    <div role="img" aria-label={label} className="flex h-8 gap-0.5">
      {parts
        .filter((p) => p.value > 0)
        .map((p, i) => (
          <div
            key={i}
            style={{ flex: `${p.value} 1 0` }}
            className={cn(
              "grid min-w-0 place-items-center rounded-[4px] text-[13px] font-medium",
              p.muted ? "bg-raised text-ink-2" : "bg-accent-bg text-foreground",
            )}
          >
            {total > 0 && p.label}
          </div>
        ))}
    </div>
  );
}

/** Legend row: small squares + labels. `muted` swatches are the neutral series. */
export function Legend({ items }: { items: { label: ReactNode; muted?: boolean }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-ink-2">
      {items.map((it, i) => (
        <li key={i} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className={cn("size-2 rounded-[2px]", it.muted ? "bg-border" : "bg-primary")}
          />
          {it.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * A required field that is still missing: dashed outline, what it is, why, and the action that fills it.
 * The mandatory-placeholder widget.
 */
export function SlotRow({
  title,
  hint,
  action,
  className,
}: {
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg border border-dashed border-placeholder px-3 py-2.5",
        className,
      )}
    >
      <span
        aria-hidden
        className="size-3.5 shrink-0 rounded-full border-[1.5px] border-dashed border-placeholder"
      />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium">{title}</p>
        {hint && <p className="text-[12px] text-ink-2">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

/** A required field that is filled: tick, label, value. */
export function OkRow({ label, value }: { label: ReactNode; value?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-1.5 text-[13px]">
      <span
        aria-hidden
        className="grid size-3.5 shrink-0 place-items-center rounded-full bg-ok text-on-accent"
      >
        <Check className="size-2.5" strokeWidth={3.5} />
      </span>
      <span className="min-w-0 flex-1">{label}</span>
      {value && <span className="shrink-0 text-ink-2">{value}</span>}
    </div>
  );
}

/** A dashed empty stat (Views, Clicks, CTR before an activity is live). */
export function EmptyStat({ label, value = "—" }: { label: string; value?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-placeholder px-2.5 py-2">
      <p className="text-[12px] text-ink-2">{label}</p>
      <p className="text-[18px] font-semibold text-ink-2">{value}</p>
    </div>
  );
}

/** Approval · UTM · go-live date as three dots, one mark per marketing activity. */
export function ReadinessDots({
  approval,
  utm,
  date,
  showCount = true,
}: {
  approval: boolean;
  utm: boolean;
  date: boolean;
  showCount?: boolean;
}) {
  const done = [approval, utm, date];
  const n = done.filter(Boolean).length;
  const label = `Approval ${approval ? "done" : "missing"}, UTM ${utm ? "done" : "missing"}, go-live date ${date ? "done" : "missing"}`;
  return (
    <span role="img" aria-label={label} className="inline-flex items-center gap-1">
      {done.map((d, i) => (
        <span
          key={i}
          aria-hidden
          className={cn(
            "size-2 rounded-full border-[1.5px] transition-colors duration-150",
            d ? "border-ok bg-ok" : "border-placeholder bg-transparent",
          )}
        />
      ))}
      {showCount && <span className="ml-1.5 text-[12px] text-ink-2">{n} of 3</span>}
    </span>
  );
}
