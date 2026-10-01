import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  Bell,
  BriefcaseBusiness,
  ChevronDown,
  ChevronRight,
  Code2,
  Command,
  LayoutDashboard,
  LogOut,
  Moon,
  RefreshCw,
  Search,
  Sun,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import logoUrl from "@/assets/hackerearth_logo_light.png";
import { currentUserQueryOptions, logout, programsQueryOptions, syncPrograms, type UserRole } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const ROLE_LABELS: Record<UserRole, string> = {
  account_manager: "Account Manager",
  csm: "CSM",
  manager: "Manager",
  other: "Other",
};

const VIEW_OPTIONS = [
  { id: "all", label: "All programs", search: {} as { view?: "hackathons" | "hiring" } },
  { id: "hackathons", label: "Hackathons", icon: Code2, search: { view: "hackathons" as const } },
  {
    id: "hiring",
    label: "Hiring Challenges",
    icon: BriefcaseBusiness,
    search: { view: "hiring" as const },
  },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // Only "/" declares a view search param -- other routes' location.search
  // won't have it, hence the cast/optional-chaining below.
  const routeSearch = useRouterState({ select: (state) => state.location.search }) as
    { view?: "hackathons" | "hiring" } | undefined;
  const activeView = routeSearch?.view;
  const [query, setQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [dark, setDark] = useState(false);
  const queryClient = useQueryClient();
  const sync = useMutation({
    mutationFn: syncPrograms,
    onSuccess: () => queryClient.invalidateQueries(),
  });
  const { data: currentUser } = useQuery(currentUserQueryOptions);
  const logoutMutation = useMutation({
    mutationFn: logout,
    onSuccess: () => {
      setUserMenuOpen(false);
      queryClient.setQueryData(["auth", "me"], null);
    },
  });
  const initials = currentUser?.name
    ? currentUser.name
        .split(/\s+/)
        .map((part) => part[0])
        .slice(0, 2)
        .join("")
        .toUpperCase()
    : (currentUser?.email[0]?.toUpperCase() ?? "?");
  // Search only needs data once it's already loaded elsewhere (dashboard/detail
  // loaders prefetch it) -- a plain useQuery here reads that cache without
  // triggering its own fetch or suspending the whole shell if it hasn't landed yet.
  const { data: programs = [] } = useQuery(programsQueryOptions);
  const results = useMemo(
    () =>
      query.trim()
        ? programs
            .filter((p) =>
              `${p.subject} ${p.company_name ?? ""} ${p.ticket_id}`
                .toLowerCase()
                .includes(query.toLowerCase()),
            )
            .slice(0, 5)
        : [],
    [query, programs],
  );

  useEffect(() => {
    const saved = window.localStorage.getItem("programops-theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const useDark = saved ? saved === "dark" : prefersDark;
    setDark(useDark);
    document.documentElement.classList.toggle("dark", useDark);
  }, []);

  const toggleTheme = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    window.localStorage.setItem("programops-theme", next ? "dark" : "light");
  };

  return (
    <div className="relative min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-50 border-b border-border/70 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[1600px] items-center gap-4 px-4 sm:px-6 lg:px-8">
          <Link
            to="/"
            className="flex shrink-0 items-center gap-3"
            aria-label="ProgramOps dashboard"
          >
            <span className="flex size-9 items-center justify-center overflow-hidden rounded-lg bg-brand-panel ring-1 ring-border">
              <img src={logoUrl} alt="HackerEarth" className="brand-logo size-6 object-contain" />
            </span>
            <span className="hidden sm:block">
              <span className="block font-display text-sm font-semibold text-foreground">
                ProgramOps
              </span>
              <span className="block text-[10px] font-medium uppercase text-muted-foreground">
                HackerEarth
              </span>
            </span>
          </Link>

          <nav className="ml-2 hidden items-center md:flex">
            <div className="relative">
              <button
                onClick={() => setMenuOpen((open) => !open)}
                aria-expanded={menuOpen}
                className={cn(
                  "flex h-9 items-center gap-2 rounded-md px-3 text-sm transition-colors",
                  pathname === "/"
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                )}
              >
                <LayoutDashboard className="size-4" />
                {VIEW_OPTIONS.find((option) => option.id === (activeView ?? "all"))?.label ??
                  "Overview"}
                <ChevronDown
                  className={cn(
                    "size-3.5 transition-transform duration-200",
                    menuOpen && "rotate-180",
                  )}
                />
              </button>
              {menuOpen && (
                <>
                  <button
                    aria-hidden="true"
                    tabIndex={-1}
                    onClick={() => setMenuOpen(false)}
                    className="fixed inset-0 z-40 cursor-default"
                  />
                  <div className="absolute left-0 top-11 z-50 w-56 overflow-hidden rounded-md border border-border bg-popover py-1.5 shadow-2xl">
                    <p className="px-3 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Program type
                    </p>
                    {VIEW_OPTIONS.map((option) => {
                      const Icon = "icon" in option ? option.icon : undefined;
                      const active = (activeView ?? "all") === option.id;
                      return (
                        <Link
                          key={option.id}
                          to="/"
                          search={option.search}
                          onClick={() => setMenuOpen(false)}
                          className={cn(
                            "flex items-center gap-2.5 px-3 py-2 text-sm transition-colors",
                            active
                              ? "bg-secondary text-foreground"
                              : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                          )}
                        >
                          {Icon ? (
                            <Icon className="size-4" />
                          ) : (
                            <LayoutDashboard className="size-4" />
                          )}{" "}
                          {option.label}
                          {active && <span className="ml-auto size-1.5 rounded-full bg-primary" />}
                        </Link>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          </nav>

          <div className="relative ml-auto w-full max-w-sm">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search programs, accounts…"
              className="h-9 w-full rounded-md border border-border bg-secondary/50 pl-9 pr-16 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15"
            />
            {query ? (
              <button
                aria-label="Clear search"
                onClick={() => setQuery("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            ) : (
              <span className="absolute right-3 top-1/2 hidden -translate-y-1/2 items-center gap-1 text-[10px] text-muted-foreground sm:flex">
                <Command className="size-3" />K
              </span>
            )}
            {results.length > 0 && (
              <div className="absolute top-11 right-0 left-0 overflow-hidden rounded-md border border-border bg-popover shadow-2xl">
                {results.map((program) => (
                  <Link
                    key={program.ticket_id}
                    to="/programs/$ticketId"
                    params={{ ticketId: program.ticket_id }}
                    onClick={() => setQuery("")}
                    className="flex items-center justify-between border-b border-border/60 px-3 py-3 last:border-0 hover:bg-secondary/70"
                  >
                    <span>
                      <span className="block text-sm font-medium">{program.subject}</span>
                      <span className="text-xs text-muted-foreground">
                        {program.company_name} · {program.ticket_id}
                      </span>
                    </span>
                    <ChevronRight className="size-4 text-muted-foreground" />
                  </Link>
                ))}
              </div>
            )}
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger className="hidden items-center gap-2 rounded-md border border-success/20 bg-success/10 px-2.5 py-1.5 text-xs font-medium text-success lg:flex">
              <span className="size-1.5 rounded-full bg-success animate-pulse" />
              Live from HubSpot
              <ChevronDown className="size-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={sync.isPending} onSelect={() => sync.mutate()}>
                <RefreshCw className={cn("size-4", sync.isPending && "animate-spin")} />
                {sync.isPending ? "Syncing..." : sync.isError ? "Sync failed - retry" : "Sync now"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Switch to ${dark ? "light" : "dark"} theme`}
            onClick={toggleTheme}
            title={`Switch to ${dark ? "light" : "dark"} theme`}
          >
            {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
          <Button variant="ghost" size="icon" aria-label="Notifications" className="relative">
            <Bell className="size-4" />
            <span className="absolute right-2 top-2 size-1.5 rounded-full bg-accent-vivid" />
          </Button>
          <div className="relative">
            <button
              onClick={() => setUserMenuOpen((open) => !open)}
              aria-expanded={userMenuOpen}
              aria-label="Account menu"
              className="flex size-8 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground transition-opacity hover:opacity-90"
            >
              {initials}
            </button>
            {userMenuOpen && (
              <>
                <button
                  aria-hidden="true"
                  tabIndex={-1}
                  onClick={() => setUserMenuOpen(false)}
                  className="fixed inset-0 z-40 cursor-default"
                />
                <div className="absolute right-0 top-11 z-50 w-56 overflow-hidden rounded-md border border-border bg-popover py-1.5 shadow-2xl">
                  <div className="px-3 py-2">
                    <p className="truncate text-sm font-medium text-foreground">
                      {currentUser?.name ?? currentUser?.email}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">{currentUser?.email}</p>
                    {currentUser?.role && (
                      <p className="mt-1 text-[10px] font-semibold uppercase text-primary">
                        {ROLE_LABELS[currentUser.role]}
                      </p>
                    )}
                  </div>
                  <div className="my-1 h-px bg-border" />
                  <button
                    onClick={() => logoutMutation.mutate()}
                    disabled={logoutMutation.isPending}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground disabled:opacity-50"
                  >
                    <LogOut className="size-4" /> Sign out
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </header>
      <main className="relative z-10 mx-auto max-w-[1500px] px-4 py-7 sm:px-6 lg:px-10 lg:py-10">
        {children}
      </main>
    </div>
  );
}
