import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { LogOut, Moon, RefreshCw, Search, Sun, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Chip, SyncStatus, useHotkey } from "@/components/kit";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ROLE_LABELS,
  currentUserQueryOptions,
  logout,
  syncPrograms,
  syncRegistrations,
  useCan,
} from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { csmQueueQuery, marketingQueueQuery } from "@/lib/ops-api";
import { searchQuery, systemStatusQuery } from "@/lib/system-api";
import { currentTheme, setTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

const NAV = [
  {
    to: "/",
    label: "Programs",
    match: (p: string) => p === "/" || p.startsWith("/programs"),
    key: "d",
    admin: false,
  },
  {
    to: "/queue/csm",
    label: "CSM queue",
    match: (p: string) => p.startsWith("/queue/csm"),
    key: "c",
    admin: false,
    count: "csm",
  },
  {
    to: "/queue/marketing",
    label: "Marketing queue",
    match: (p: string) => p.startsWith("/queue/marketing"),
    key: "m",
    admin: false,
    count: "marketing",
  },
  {
    to: "/admin",
    label: "Admin",
    match: (p: string) => p.startsWith("/admin"),
    key: "a",
    admin: true,
  },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const queryClient = useQueryClient();
  const canAdmin = useCan("users.manage");
  const canSync = useCan("integrations.link");
  const { data: me } = useQuery(currentUserQueryOptions);
  const { data: status } = useQuery(systemStatusQuery);
  const { data: csm } = useQuery(csmQueueQuery("mine"));
  const { data: marketing } = useQuery(marketingQueueQuery);
  const todo = (list: { severity: string }[] | undefined) =>
    list?.filter((i) => i.severity !== "info").length;
  const counts = { csm: todo(csm?.items), marketing: todo(marketing?.items) };

  // "g" then a letter jumps between the main screens: g d directory, g c CSM queue, g m marketing queue, g a admin.
  const navigate = useNavigate();
  useEffect(() => {
    let armedAt = 0;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      if (e.key === "g") {
        armedAt = Date.now();
        return;
      }
      if (!armedAt || Date.now() - armedAt > 1200) return;
      armedAt = 0;
      if (e.key === "d") void navigate({ to: "/" });
      else if (e.key === "c") void navigate({ to: "/queue/csm" });
      else if (e.key === "m") void navigate({ to: "/queue/marketing" });
      else if (e.key === "a" && canAdmin) void navigate({ to: "/admin" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, canAdmin]);

  const [dark, setDark] = useState(false);
  useEffect(() => setDark(currentTheme() === "dark"), []);
  const toggleTheme = () => {
    const next = !dark;
    setDark(next);
    setTheme(next ? "dark" : "light");
  };

  const sync = useMutation({
    mutationFn: syncPrograms,
    onSuccess: () => queryClient.invalidateQueries(),
  });
  const reload = useMutation({
    mutationFn: syncRegistrations,
    onSuccess: () => queryClient.invalidateQueries(),
  });
  const signOut = useMutation({
    mutationFn: logout,
    onSuccess: () => queryClient.setQueryData(["auth", "me"], null),
  });
  const busy = sync.isPending || reload.isPending;

  const initials = (me?.name ?? me?.email ?? "?")
    .split(/[\s@.]+/)
    .filter(Boolean)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const stale = status?.hubspot_synced_at
    ? Date.now() -
        new Date(
          status.hubspot_synced_at + (status.hubspot_synced_at.endsWith("Z") ? "" : "Z"),
        ).getTime() >
      30 * 60000
    : false;

  const syncDetail = [
    `HubSpot: ${timeAgo(status?.hubspot_synced_at)}`,
    `Redash: ${timeAgo(status?.redash_registrations_synced_at)}`,
    `Sources: ${timeAgo(status?.sources_fetched_at)}`,
  ].join("\n");
  const syncLabel = `Synced ${timeAgo(status?.hubspot_synced_at)}`;

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="sticky top-0 z-50 border-b border-border bg-surface">
        <div className="mx-auto flex max-w-[1360px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 lg:px-8">
          <Link to="/" className="flex shrink-0 items-center gap-2.5" aria-label="ProgramOps home">
            <img
              src="/favicon.png"
              alt=""
              className="size-[30px] rounded-[8px] bg-white object-contain ring-1 ring-border dark:ring-white/40"
            />
            <span className="text-[15px] font-semibold">ProgramOps</span>
          </Link>

          <nav aria-label="Primary" className="flex flex-wrap items-center gap-1">
            {NAV.filter((n) => !n.admin || canAdmin).map((n) => {
              const active = n.match(pathname);
              const count = "count" in n ? counts[n.count] : undefined;
              return (
                <Link
                  key={n.to}
                  to={n.to}
                  aria-current={active ? "page" : undefined}
                  title={`${n.label} (press g, then ${n.key})`}
                  className={cn(
                    "flex items-center gap-1.5 rounded-[8px] px-3 py-1.5 text-[14px]",
                    active
                      ? "bg-raised font-medium text-foreground"
                      : "text-ink-2 hover:text-foreground",
                  )}
                >
                  {n.label}
                  {count !== undefined && count > 0 && (
                    <span className="rounded-full bg-accent-bg px-1.5 text-[12px] font-medium text-primary">
                      {count}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>

          <div className="flex min-w-0 flex-1 basis-52 items-center justify-end gap-3">
            <GlobalSearch />
            {canSync ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label="Sync status and actions"
                  title={syncDetail}
                  className="hidden rounded-[8px] px-1 py-1 hover:bg-raised md:inline-flex"
                >
                  <SyncStatus
                    label={syncLabel}
                    stale={stale}
                    live={!busy}
                    detail={syncDetail}
                    trailing={<RefreshCw className={cn("size-3", busy && "animate-spin")} />}
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="text-[14px]">
                  <DropdownMenuItem disabled={sync.isPending} onSelect={() => sync.mutate()}>
                    Sync HubSpot now{" "}
                    <span className="ml-3 text-[12px] text-muted-foreground">auto 10 min</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={reload.isPending} onSelect={() => reload.mutate()}>
                    Reload registrations{" "}
                    <span className="ml-3 text-[12px] text-muted-foreground">auto 6 h</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <span className="hidden md:inline-flex">
                <SyncStatus label={syncLabel} stale={stale} live detail={syncDetail} />
              </span>
            )}
            {!!status?.outbox_failed && (
              <Chip tone="critical">{status.outbox_failed} Slack failed</Chip>
            )}

            <button
              onClick={toggleTheme}
              aria-label={`Switch to ${dark ? "light" : "dark"} theme`}
              className="flex size-9 shrink-0 items-center justify-center rounded-[8px] border border-border text-ink-2 hover:bg-raised"
            >
              {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </button>

            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label="Account menu"
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-bg text-[12px] font-semibold text-primary"
              >
                {initials || "?"}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60">
                <div className="px-2 py-2">
                  <p className="truncate text-[14px] font-medium">{me?.name ?? me?.email}</p>
                  <p className="truncate text-[12px] text-muted-foreground">{me?.email}</p>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {me?.roles.map((r) => (
                      <Chip key={r}>{ROLE_LABELS[r]}</Chip>
                    ))}
                  </div>
                </div>
                <DropdownMenuItem onSelect={() => signOut.mutate()} className="gap-2 text-[14px]">
                  <LogOut className="size-3.5" /> Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <main
        key={pathname.split("/").slice(0, 3).join("/")}
        className="page-in mx-auto w-full max-w-[1360px] flex-1 px-4 py-6 lg:px-8"
      >
        {children}
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-2 px-4 py-3  text-[12px] text-muted-foreground lg:px-6">
          <span>ProgramOps · internal program operations</span>
          <span>© HackerEarth</span>
        </div>
      </footer>
    </div>
  );
}

function GlobalSearch() {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useHotkey("/", () => input.current?.focus());
  const { data: hits = [], isFetching } = useQuery(searchQuery(q));
  return (
    <div className="relative w-full max-w-[320px]">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <input
        ref={input}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => e.key === "Escape" && (setQ(""), input.current?.blur())}
        placeholder="Search tickets, programs, teams…"
        aria-label="Search programs"
        className="h-9 w-full rounded-[8px] bg-raised pl-8 pr-8 text-[13px] placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      />
      {q ? (
        <button
          aria-label="Clear search"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setQ("")}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      ) : (
        <kbd className="absolute right-2 top-1/2 -translate-y-1/2 rounded border border-border px-1.5 text-[11px] text-muted-foreground">
          /
        </kbd>
      )}
      {open && q.trim().length >= 2 && (
        <div className="drawer-in absolute left-0 right-0 top-10 z-50 overflow-hidden rounded-xl border border-border bg-popover">
          {hits.map((h) => (
            <Link
              key={h.ticket_id}
              to="/programs/$ticketId"
              params={{ ticketId: h.ticket_id }}
              search={{ tab: "overview" }}
              onClick={() => setQ("")}
              className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 last:border-0 hover:bg-secondary"
            >
              <span className="min-w-0">
                <span className="block truncate text-[14px] font-medium">{h.name}</span>
                <span className="block truncate text-[13px] text-muted-foreground">
                  {h.client ?? "No client"} · <span className="font-mono">{h.ticket_id}</span>
                </span>
              </span>
              <Chip>{h.stage}</Chip>
            </Link>
          ))}
          {!hits.length && (
            <p className="px-3 py-3 text-[13px] text-muted-foreground">
              {isFetching ? "Searching…" : "No programs match."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
