import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  AlertTriangle,
  Ban,
  Check,
  Copy,
  Download,
  History,
  Lock,
  Mail,
  MoreHorizontal,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users as UsersIcon,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import {
  Avatar,
  Card,
  CardBody,
  CardHeader,
  Chip,
  EmptyState,
  Kpi,
  LogList,
  MonoLabel,
  Num,
  Skeleton,
  type Tone,
} from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import {
  AUDIT_ENTITIES,
  PERMISSION_GROUPS,
  ROLES,
  ROLE_DEFAULTS,
  describeEvent,
  globalAuditQuery,
  parseSection,
  roleDefaults,
  saveSettings,
  settingsQuery,
  showValue,
  type AuditFilters,
  type AuditPage,
  type AuditRow,
  type PortalSettings,
  type Section,
} from "@/lib/admin-api";
import { ROLE_LABELS, apiFetch, currentUserQueryOptions, type UserRole } from "@/lib/api";
import { formatDate, formatDateTime } from "@/lib/format";
import {
  PERMISSION_LABELS,
  adminUsersQuery,
  createInvite,
  deleteInvite,
  invitesQuery,
  patchUser,
  resendInvite,
  revokeInvite,
  setUserPermissions,
  type AdminUser,
  type Invite,
  type InviteLink,
} from "@/lib/ops-api";
import { cn } from "@/lib/utils";

const errorText = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong");
const ROLE_TONE: Record<UserRole, Tone> = {
  super_admin: "critical",
  csm: "info",
  marketing: "indigo",
  account_manager: "neutral",
};
const SELF_REASON = "You can't change your own roles or access.";
const daysLeft = (iso: string) =>
  Math.max(
    0,
    Math.ceil((new Date(iso.endsWith("Z") ? iso : `${iso}Z`).getTime() - Date.now()) / 86_400_000),
  );

const NAV: { id: Section; label: string; icon: ReactNode; needs: string }[] = [
  { id: "users", label: "Users & Personnel", icon: <UsersIcon />, needs: "users.manage" },
  { id: "roles", label: "Roles & Policies", icon: <ShieldCheck />, needs: "users.manage" },
  { id: "audit", label: "Audit Log", icon: <History />, needs: "audit.view" },
  { id: "settings", label: "Portal Settings", icon: <SettingsIcon />, needs: "settings.edit" },
];

export function AdminPage() {
  const { data: me, isLoading } = useQuery(currentUserQueryOptions);
  const search = useSearch({ from: "/admin" });
  const navigate = useNavigate({ from: "/admin" });
  if (isLoading) return <Skeleton className="h-64 w-full" />;
  const visible = NAV.filter((n) => me?.permissions.includes(n.needs));
  if (!me || visible.length === 0) {
    return (
      <EmptyState
        icon={<Lock />}
        title="Admin & Governance is restricted"
        hint="Only super admins can manage access, settings and the audit log."
      />
    );
  }
  const wanted = parseSection(search.section);
  const section = visible.find((n) => n.id === wanted)?.id ?? visible[0]!.id;
  const canUsers = me.permissions.includes("users.manage");
  return (
    <div className="page-in grid gap-6 lg:grid-cols-[208px_minmax(0,1fr)]">
      <nav
        aria-label="Admin sections"
        className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible"
      >
        <MonoLabel className="mb-2 hidden px-3 lg:block">Governance &amp; IAM</MonoLabel>
        {visible.map((n) => (
          <button
            key={n.id}
            type="button"
            aria-current={section === n.id ? "page" : undefined}
            onClick={() => void navigate({ search: { section: n.id } })}
            className={cn(
              "flex h-9 shrink-0 items-center gap-2.5 rounded-[8px] px-3 text-[14px] font-medium [&_svg]:size-4",
              section === n.id
                ? "bg-primary/10 text-primary"
                : "text-secondary-foreground hover:bg-secondary hover:text-foreground",
            )}
          >
            {n.icon}
            {n.label}
          </button>
        ))}
      </nav>
      <div className="min-w-0 space-y-5">
        {section === "users" && <UsersSection meId={me.id} />}
        {section === "roles" && <RolesSection />}
        {section === "audit" && <AuditSection canUsers={canUsers} />}
        {section === "settings" && <SettingsSection />}
      </div>
    </div>
  );
}

function Crumbs({ here }: { here: string }) {
  return (
    <p className="t-mono-label text-muted-foreground">
      Admin &amp; Governance <span aria-hidden>/</span>{" "}
      <span className="text-foreground">{here}</span>
    </p>
  );
}

function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 rounded-[8px] border border-status-critical/40 bg-status-critical/10 px-3 py-2 text-[13px] text-status-critical"
    >
      <span>{errorText(error)}</span>
      {retry && (
        <Button size="sm" variant="outline" onClick={retry}>
          Retry
        </Button>
      )}
    </div>
  );
}

function RoleChips({ roles }: { roles: UserRole[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {roles.map((r) => (
        <Chip key={r} tone={ROLE_TONE[r]}>
          {ROLE_LABELS[r]}
        </Chip>
      ))}
    </div>
  );
}

// ---- Users & Personnel ---------------------------------------------------------------------------

type Row = { kind: "user"; user: AdminUser } | { kind: "invite"; invite: Invite };
type StatusFilter = "all" | "active" | "inactive" | "invited" | "expired";

function UsersSection({ meId }: { meId: string }) {
  const qc = useQueryClient();
  const users = useQuery(adminUsersQuery);
  const invites = useQuery(invitesQuery);
  const [roleFilter, setRoleFilter] = useState<UserRole | "all">("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [text, setText] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [permsFor, setPermsFor] = useState<string | null>(null);
  const [link, setLink] = useState<InviteLink | null>(null);
  const [copied, setCopied] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const refreshInvites = () => qc.invalidateQueries({ queryKey: ["admin", "invites"] });
  const saveUser = (user: AdminUser) => {
    qc.setQueryData<AdminUser[]>(adminUsersQuery.queryKey, (all) =>
      all?.map((u) => (u.id === user.id ? user : u)),
    );
    void qc.invalidateQueries({ queryKey: ["admin", "audit"] });
  };
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Parameters<typeof patchUser>[1] }) =>
      patchUser(id, body),
    onSuccess: saveUser,
  });
  const resend = useMutation({
    mutationFn: resendInvite,
    onSuccess: (r) => {
      setLink(r);
      setCopied(false);
      void refreshInvites();
    },
  });
  const revoke = useMutation({ mutationFn: revokeInvite, onSuccess: refreshInvites });
  const remove = useMutation({ mutationFn: deleteInvite, onSuccess: refreshInvites });
  const failure =
    patch.error ??
    resend.error ??
    revoke.error ??
    remove.error ??
    (exportError ? new Error(exportError) : null);

  const live = useMemo(
    () => (invites.data ?? []).filter((i) => i.status === "pending" || i.status === "expired"),
    [invites.data],
  );
  const pending = live.filter((i) => i.status === "pending");
  const expired = live.filter((i) => i.status === "expired");
  const all = useMemo(() => users.data ?? [], [users.data]);
  const active = all.filter((u) => u.is_active);
  const superAdmins = active.filter((u) => u.roles.includes("super_admin"));
  const csms = active.filter((u) => u.roles.includes("csm"));
  const soonest = pending.length ? Math.min(...pending.map((i) => daysLeft(i.expires_at))) : null;

  const rows: Row[] = useMemo(() => {
    const t = text.trim().toLowerCase();
    const matchRole = (roles: UserRole[]) => roleFilter === "all" || roles.includes(roleFilter);
    const matchText = (...s: (string | null)[]) =>
      !t || s.some((x) => x?.toLowerCase().includes(t));
    const us: Row[] = all
      .filter((u) => matchRole(u.roles) && matchText(u.name, u.email))
      .filter(
        (u) =>
          status === "all" ||
          (status === "active" && u.is_active) ||
          (status === "inactive" && !u.is_active),
      )
      .map((user) => ({ kind: "user", user }));
    const is: Row[] = live
      .filter((i) => matchRole(i.roles) && matchText(i.email))
      .filter(
        (i) =>
          status === "all" ||
          (status === "invited" && i.status === "pending") ||
          (status === "expired" && i.status === "expired"),
      )
      .map((invite) => ({ kind: "invite", invite }));
    return [...us, ...is];
  }, [all, live, roleFilter, status, text]);

  const copy = async (value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
  };
  const permsUser = all.find((u) => u.id === permsFor) ?? null;

  return (
    <>
      <div className="space-y-3">
        <Crumbs here="Users & Permissions" />
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h1 className="t-headline-lg flex flex-wrap items-center gap-2.5">
            Users &amp; Access Governance
            <Chip tone="neutral">{all.length} total accounts</Chip>
            <Chip tone={pending.length ? "critical" : "neutral"}>
              {pending.length} pending invites
            </Chip>
          </h1>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              onClick={() => exportAuditCsv().catch((e: unknown) => setExportError(errorText(e)))}
            >
              <Download className="size-4" /> Export audit log (CSV)
            </Button>
            <Button onClick={() => setInviteOpen(true)}>
              <UserPlus className="size-4" /> Invite person
            </Button>
          </div>
        </div>
      </div>

      <div className="reveal grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          index={0}
          label="Total accounts"
          icon={<UsersIcon />}
          value={<Num value={all.length} />}
          unit={`${active.length} active seats`}
          sub={`${pending.length} invited · ${expired.length} expired`}
        />
        <Kpi
          index={1}
          label="Super admins"
          tone="critical"
          icon={<ShieldCheck />}
          value={<Num value={superAdmins.length} />}
          unit={superAdmins
            .map((u) => u.name ?? u.email)
            .slice(0, 2)
            .join(", ")}
          sub={
            <span className="inline-flex items-center gap-1">
              <Lock className="size-3" /> Last super admin is protected
            </span>
          }
        />
        <Kpi
          index={2}
          label="Client success (CSM)"
          tone="info"
          icon={<UsersIcon />}
          value={<Num value={csms.length} />}
          unit="active"
          sub={`+${live.filter((i) => i.status === "pending" && i.roles.includes("csm")).length} pending invites`}
        />
        <Kpi
          index={3}
          label="Pending / expired invites"
          tone={expired.length ? "warning" : "neutral"}
          icon={<Mail />}
          value={<Num value={live.length} />}
          unit={`${pending.length} valid / ${expired.length} expired`}
          sub={soonest === null ? "No invite waiting" : `Expiring soonest in ${soonest}d`}
        />
      </div>

      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-border p-3">
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Filter by name or email"
              className="pl-8"
              placeholder="Filter by email or name..."
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Role filter">
            <MonoLabel className="mr-1">Role:</MonoLabel>
            {(["all", ...ROLES] as const).map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={roleFilter === r}
                onClick={() => setRoleFilter(r)}
                className={cn(
                  "h-7 rounded-full px-3 text-[13px] font-medium",
                  roleFilter === r
                    ? "bg-accent-fill text-on-accent"
                    : "text-secondary-foreground hover:bg-secondary",
                )}
              >
                {r === "all" ? "All" : ROLE_LABELS[r]}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <MonoLabel>Status:</MonoLabel>
            <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
              <SelectTrigger className="w-40" aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="inactive">Inactive</SelectItem>
                <SelectItem value="invited">Invited</SelectItem>
                <SelectItem value="expired">Expired token</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {failure && (
          <div className="p-3 pb-0">
            <ErrorBox error={failure} />
          </div>
        )}
        {link && (
          <div className="m-3 flex flex-wrap items-center gap-2 rounded-[8px] border border-border bg-secondary p-2.5">
            <code className="t-data-sm min-w-0 flex-1 truncate">{link.link}</code>
            <Button size="sm" variant="outline" onClick={() => void copy(link.link)}>
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}{" "}
              {copied ? "Copied" : "Copy"}
            </Button>
            <span className="t-data-sm text-muted-foreground">
              shown once · {link.invite.email} · expires {formatDate(link.invite.expires_at)}
            </span>
            <Button size="sm" variant="ghost" onClick={() => setLink(null)}>
              Dismiss
            </Button>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] border-collapse text-left">
            <thead>
              <tr className="border-b border-border">
                {[
                  "User & identity",
                  "Assigned role(s)",
                  "State",
                  "Permissions profile",
                  "Access controls",
                ].map((h, i) => (
                  <th key={h} className={cn("t-th px-4 py-2.5", i === 4 && "text-right")}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            {users.isLoading || invites.isLoading ? (
              <tbody>
                {[0, 1, 2, 3].map((i) => (
                  <tr key={i}>
                    <td colSpan={5} className="p-3">
                      <Skeleton className="h-9 w-full" />
                    </td>
                  </tr>
                ))}
              </tbody>
            ) : (
              <tbody className="reveal">
                {rows.map((row, i) =>
                  row.kind === "user" ? (
                    <UserRow
                      key={row.user.id}
                      u={row.user}
                      index={i}
                      isMe={row.user.id === meId}
                      onPatch={(body) => patch.mutate({ id: row.user.id, body })}
                      onPerms={() => setPermsFor(row.user.id)}
                    />
                  ) : (
                    <InviteRow
                      key={row.invite.id}
                      invite={row.invite}
                      index={i}
                      onResend={() => resend.mutate(row.invite.id)}
                      onRevoke={() => revoke.mutate(row.invite.id)}
                      onDelete={() => remove.mutate(row.invite.id)}
                    />
                  ),
                )}
              </tbody>
            )}
          </table>
        </div>
        {users.isError && (
          <div className="p-3">
            <ErrorBox error={users.error} retry={() => void users.refetch()} />
          </div>
        )}
        {invites.isError && (
          <div className="p-3">
            <ErrorBox error={invites.error} retry={() => void invites.refetch()} />
          </div>
        )}
        {!users.isLoading && !invites.isLoading && rows.length === 0 && (
          <div className="p-4">
            <EmptyState
              icon={<UsersIcon />}
              title="No accounts match"
              hint="Clear a filter, or invite someone."
            />
          </div>
        )}
        <div className="flex flex-wrap justify-between gap-2 border-t border-border px-4 py-2 t-data-sm text-muted-foreground">
          <span>
            Showing {rows.length} of {all.length + live.length} entries
          </span>
          <span>Invite-only sign-in · links last 3 days</span>
        </div>
      </Card>

      <Card>
        <div className="flex flex-wrap items-center gap-3 p-4">
          <ShieldCheck className="size-5 shrink-0 text-status-critical" aria-hidden />
          <div className="min-w-0">
            <h2 className="text-[16px] font-semibold tracking-[-0.01em]">
              Access policy safeguard
            </h2>
            <p className="text-[13px] text-secondary-foreground">
              Nobody can change their own roles or access, the last active super admin can't be
              demoted or deactivated, and sign-in works only through an invite a super admin issued.
            </p>
          </div>
        </div>
      </Card>

      <InviteSheet
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onCreated={(l) => {
          setLink(l);
          setCopied(false);
          void refreshInvites();
        }}
      />
      {permsUser && (
        <PermissionsSheet
          key={permsUser.id}
          user={permsUser}
          isMe={permsUser.id === meId}
          onClose={() => setPermsFor(null)}
          onSaved={saveUser}
        />
      )}
    </>
  );
}

function UserRow({
  u,
  index,
  isMe,
  onPatch,
  onPerms,
}: {
  u: AdminUser;
  index: number;
  isMe: boolean;
  onPatch: (b: { roles?: UserRole[]; is_active?: boolean }) => void;
  onPerms: () => void;
}) {
  const defaults = roleDefaults(u.roles);
  return (
    <tr
      className={cn(
        "row-hover border-b border-border last:border-0 align-middle",
        !u.is_active && "opacity-70",
      )}
      style={{ ["--i" as string]: index }}
    >
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          <Avatar name={u.name ?? u.email} className="size-9 text-[12px]" />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[14px] font-medium">
              {u.name ?? u.email}
              {isMe && <Chip tone="info">You</Chip>}
            </div>
            <div className="t-data-sm truncate text-muted-foreground">{u.email}</div>
          </div>
        </div>
      </td>
      <td className="px-4 py-3">
        {u.roles.length ? <RoleChips roles={u.roles} /> : <Chip>No role yet</Chip>}
      </td>
      <td className="px-4 py-3">
        <Chip tone={u.is_active ? "good" : "neutral"}>{u.is_active ? "Active" : "Inactive"}</Chip>
      </td>
      <td className="px-4 py-3">
        <div className="flex max-w-[260px] flex-wrap items-center gap-1 text-[13px] text-secondary-foreground">
          <span>{u.roles.length ? `Role defaults (${defaults.size})` : "No permissions"}</span>
          {u.grants.map((p) => (
            <Chip key={p} tone="good">
              + {PERMISSION_LABELS[p] ?? p}
            </Chip>
          ))}
          {u.revokes.map((p) => (
            <Chip key={p} tone="critical">
              − {PERMISSION_LABELS[p] ?? p}
            </Chip>
          ))}
        </div>
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-1.5">
          <RolePopover user={u} disabled={isMe} onApply={(roles) => onPatch({ roles })} />
          <Button
            size="sm"
            variant="secondary"
            disabled={isMe}
            title={isMe ? SELF_REASON : undefined}
            onClick={onPerms}
          >
            Edit perms
            {u.grants.length + u.revokes.length > 0
              ? ` (${u.grants.length + u.revokes.length})`
              : ""}
          </Button>
          <Popover>
            <PopoverTrigger asChild>
              <Button size="icon" variant="ghost" aria-label={`More actions for ${u.email}`}>
                <MoreHorizontal className="size-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-44 p-1">
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                disabled={isMe}
                title={isMe ? SELF_REASON : undefined}
                onClick={() => onPatch({ is_active: !u.is_active })}
              >
                <Ban className="size-4" /> {u.is_active ? "Deactivate" : "Reactivate"}
              </Button>
            </PopoverContent>
          </Popover>
        </div>
      </td>
    </tr>
  );
}

function RolePopover({
  user,
  disabled,
  onApply,
}: {
  user: AdminUser;
  disabled: boolean;
  onApply: (roles: UserRole[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [roles, setRoles] = useState<UserRole[]>(user.roles);
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setRoles(user.roles);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          title={disabled ? SELF_REASON : undefined}
        >
          Change role
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 space-y-2 p-3">
        <MonoLabel>Roles</MonoLabel>
        {ROLES.map((r) => (
          <label key={r} className="flex items-center gap-2 text-[14px]">
            <Checkbox
              checked={roles.includes(r)}
              onCheckedChange={(c) => setRoles(c ? [...roles, r] : roles.filter((x) => x !== r))}
            />
            {ROLE_LABELS[r]}
          </label>
        ))}
        <Button
          size="sm"
          className="w-full"
          disabled={
            roles.length === user.roles.length && roles.every((r) => user.roles.includes(r))
          }
          onClick={() => {
            onApply(roles);
            setOpen(false);
          }}
        >
          Apply
        </Button>
      </PopoverContent>
    </Popover>
  );
}

function InviteRow({
  invite,
  index,
  onResend,
  onRevoke,
  onDelete,
}: {
  invite: Invite;
  index: number;
  onResend: () => void;
  onRevoke: () => void;
  onDelete: () => void;
}) {
  const expired = invite.status === "expired";
  return (
    <tr
      className="border-b border-border bg-secondary/40 align-middle last:border-0"
      style={{ ["--i" as string]: index }}
    >
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground">
            <Mail className="size-4" />
          </span>
          <div className="min-w-0">
            <div
              className={cn(
                "text-[14px] font-medium italic",
                expired && "line-through text-muted-foreground",
              )}
            >
              {invite.email}
            </div>
            <div className="t-data-sm text-muted-foreground">
              invited {formatDate(invite.created_at)}
            </div>
          </div>
        </div>
      </td>
      <td className="px-4 py-3">
        <RoleChips roles={invite.roles} />
      </td>
      <td className="px-4 py-3">
        <Chip tone={expired ? "critical" : "neutral"}>
          {expired ? "Expired token" : `Invited · expires in ${daysLeft(invite.expires_at)}d`}
        </Chip>
      </td>
      <td className="px-4 py-3 text-[13px] italic text-muted-foreground">
        {expired ? "Token inactive (past 3-day TTL)" : "Pending token acceptance"}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-1.5">
          {expired ? (
            <>
              <Button size="sm" variant="outline" onClick={onResend}>
                Re-issue invite
              </Button>
              <Button size="sm" variant="ghost" onClick={onDelete}>
                <Trash2 className="size-3.5" /> Delete
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={onResend}
                title="Issues a fresh link; the old one stops working"
              >
                <Copy className="size-3.5" /> Copy link
              </Button>
              <Button size="sm" variant="ghost" onClick={onResend}>
                Resend
              </Button>
              <Button size="sm" variant="ghost" className="text-status-critical" onClick={onRevoke}>
                Revoke
              </Button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

function RolePicker({ value, onChange }: { value: UserRole[]; onChange: (r: UserRole[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Roles">
      {ROLES.map((r) => {
        const on = value.includes(r);
        return (
          <button
            key={r}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((x) => x !== r) : [...value, r])}
            className={cn(
              "h-7 rounded-full border px-3 text-[13px] font-medium",
              on
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-secondary-foreground hover:bg-secondary",
            )}
          >
            {ROLE_LABELS[r]}
          </button>
        );
      })}
    </div>
  );
}

function InviteSheet({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (l: InviteLink) => void;
}) {
  const [email, setEmail] = useState("");
  const [roles, setRoles] = useState<UserRole[]>(["csm"]);
  const create = useMutation({
    mutationFn: () => createInvite(email.trim(), roles),
    onSuccess: (l) => {
      onCreated(l);
      setEmail("");
      onOpenChange(false);
    },
  });
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Invite person</SheetTitle>
          <SheetDescription>
            You choose their roles; nobody picks their own. The link works once, for this email, for
            3 days.
          </SheetDescription>
        </SheetHeader>
        <form
          className="mt-5 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <label className="block space-y-1.5">
            <MonoLabel>Email</MonoLabel>
            <Input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@hackerearth.com"
            />
          </label>
          <div className="space-y-1.5">
            <MonoLabel>Roles (at least one)</MonoLabel>
            <RolePicker value={roles} onChange={setRoles} />
          </div>
          {create.isError && <ErrorBox error={create.error} />}
          <Button
            type="submit"
            className="w-full"
            disabled={!email || roles.length === 0 || create.isPending}
          >
            {create.isPending ? "Creating..." : "Create invite link"}
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function PermissionsSheet({
  user,
  isMe,
  onClose,
  onSaved,
}: {
  user: AdminUser;
  isMe: boolean;
  onClose: () => void;
  onSaved: (u: AdminUser) => void;
}) {
  const defaults = roleDefaults(user.roles);
  const [want, setWant] = useState<Set<string>>(() => new Set(user.permissions));
  const save = useMutation({
    mutationFn: () => {
      const keys = Object.keys(PERMISSION_LABELS);
      return setUserPermissions(
        user.id,
        keys.filter((k) => want.has(k) && !defaults.has(k)),
        keys.filter((k) => !want.has(k) && defaults.has(k)),
      );
    },
    onSuccess: (u) => {
      onSaved(u);
      onClose();
    },
  });
  const toggle = (k: string, on: boolean) =>
    setWant((s) => {
      const n = new Set(s);
      if (on) n.add(k);
      else n.delete(k);
      return n;
    });
  const dirty = Object.keys(PERMISSION_LABELS).some(
    (k) => want.has(k) !== user.permissions.includes(k),
  );
  return (
    <Sheet
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Edit permissions</SheetTitle>
          <SheetDescription>
            {user.name ?? user.email} ·{" "}
            {user.roles.map((r) => ROLE_LABELS[r]).join(" + ") || "no role"}
          </SheetDescription>
        </SheetHeader>
        <div className="mt-4 space-y-5">
          {PERMISSION_GROUPS.map((g) => (
            <section key={g.title} className="space-y-1">
              <MonoLabel>{g.title}</MonoLabel>
              <ul className="divide-y divide-border rounded-[8px] border border-border">
                {g.keys.map((k) => {
                  const isDefault = defaults.has(k);
                  const on = want.has(k);
                  const override = on !== isDefault;
                  return (
                    <li key={k} className="flex items-center justify-between gap-3 px-3 py-2">
                      <div className="min-w-0">
                        <div className="text-[14px]">{PERMISSION_LABELS[k] ?? k}</div>
                        <div className="t-data-sm text-muted-foreground">
                          {isDefault ? "default from role" : "not in role"}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {override && (
                          <Chip tone={on ? "good" : "critical"}>
                            {on ? "+ granted" : "− revoked"}
                          </Chip>
                        )}
                        <Switch
                          checked={on}
                          disabled={isMe}
                          onCheckedChange={(c) => toggle(k, c)}
                          aria-label={PERMISSION_LABELS[k] ?? k}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
          {save.isError && <ErrorBox error={save.error} />}
          <div className="sticky bottom-0 flex gap-2 bg-background py-3">
            <Button
              className="flex-1"
              disabled={!dirty || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? "Saving..." : "Save permissions"}
            </Button>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ---- Roles & Policies ------------------------------------------------------------------------------

function RolesSection() {
  return (
    <>
      <div className="space-y-3">
        <Crumbs here="Roles & Policies" />
        <h1 className="t-headline-lg">Roles &amp; Policies</h1>
      </div>
      <Card>
        <CardHeader
          title="Role defaults"
          meta="read-only · individual overrides are set per user"
          divided
        />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-left">
            <thead>
              <tr className="border-b border-border">
                <th className="t-th px-4 py-2.5">Permission</th>
                {ROLES.map((r) => (
                  <th key={r} className="t-th px-4 py-2.5 text-center">
                    {ROLE_LABELS[r]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PERMISSION_GROUPS.flatMap((g) => [
                <tr key={g.title} className="bg-secondary/50">
                  <td colSpan={5} className="px-4 py-1.5">
                    <MonoLabel>{g.title}</MonoLabel>
                  </td>
                </tr>,
                ...g.keys.map((k) => (
                  <tr key={k} className="border-b border-border last:border-0">
                    <td className="px-4 py-2 text-[14px]">
                      {PERMISSION_LABELS[k]}
                      <span className="t-data-sm ml-2 text-muted-foreground">{k}</span>
                    </td>
                    {ROLES.map((r) => (
                      <td key={r} className="px-4 py-2 text-center">
                        {ROLE_DEFAULTS[r].includes(k) ? (
                          <Check className="mx-auto size-4 text-status-good" aria-label="Allowed" />
                        ) : (
                          <span className="text-muted-foreground" aria-label="Not allowed">
                            —
                          </span>
                        )}
                      </td>
                    ))}
                  </tr>
                )),
              ])}
            </tbody>
          </table>
        </div>
      </Card>
      <Card>
        <CardHeader title="Safeguards" />
        <CardBody>
          <ul className="space-y-2 text-[14px]">
            {[
              [
                "No self role change",
                "Nobody can change their own roles or permissions; another super admin has to.",
              ],
              [
                "Last super admin protected",
                "A change that would leave no active super admin is refused.",
              ],
              [
                "Invite-only sign-in",
                "Google sign-in works only with a valid invite link, issued for that exact email.",
              ],
            ].map(([t, d]) => (
              <li key={t} className="flex items-start gap-2">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-status-good" />
                <span>
                  <span className="font-medium">{t}.</span>{" "}
                  <span className="text-secondary-foreground">{d}</span>
                </span>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
    </>
  );
}

// ---- Audit log -------------------------------------------------------------------------------------

const csvCell = (v: string) => `"${v.replace(/"/g, '""')}"`;
function downloadCsv(rows: AuditRow[]) {
  const head = [
    "id",
    "at",
    "actor",
    "entity",
    "entity_id",
    "action",
    "field",
    "old",
    "new",
    "ticket_id",
  ];
  const body = rows.map((r) =>
    [
      r.id,
      r.at,
      r.actor_name,
      r.entity,
      r.entity_id,
      r.action,
      r.field ?? "",
      showValue(r.old),
      showValue(r.new),
      r.ticket_id ?? "",
    ]
      .map((c) => csvCell(String(c)))
      .join(","),
  );
  const url = URL.createObjectURL(
    new Blob([[head.join(","), ...body].join("\n")], { type: "text/csv" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "audit-log.csv";
  a.click();
  URL.revokeObjectURL(url);
}
/** Users-page header button: exports the newest 200 audit events, built client-side. */
async function exportAuditCsv() {
  downloadCsv((await apiFetch<AuditPage>("/audit?limit=200")).items);
}

function AuditSection({ canUsers }: { canUsers: boolean }) {
  const [f, setF] = useState<AuditFilters>({ entity: "", actor: "", ticket: "" });
  const users = useQuery({ ...adminUsersQuery, enabled: canUsers });
  const q = useInfiniteQuery(globalAuditQuery(f));
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];
  const names = new Map((users.data ?? []).map((u) => [u.id, u.name ?? u.email]));
  const sel = (v: string) => (v === "all" ? "" : v);
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-3">
          <Crumbs here="Audit Log" />
          <h1 className="t-headline-lg">Audit Log</h1>
        </div>
        <Button variant="outline" disabled={rows.length === 0} onClick={() => downloadCsv(rows)}>
          <Download className="size-4" /> Export loaded rows (CSV)
        </Button>
      </div>
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
          <Select value={f.entity || "all"} onValueChange={(v) => setF({ ...f, entity: sel(v) })}>
            <SelectTrigger className="w-44" aria-label="Entity">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All entities</SelectItem>
              {AUDIT_ENTITIES.map((e) => (
                <SelectItem key={e} value={e}>
                  {e.replace(/_/g, " ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {canUsers && (
            <Select value={f.actor || "all"} onValueChange={(v) => setF({ ...f, actor: sel(v) })}>
              <SelectTrigger className="w-48" aria-label="Actor">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any actor</SelectItem>
                {(users.data ?? []).map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.name ?? u.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Input
            aria-label="Program ticket id"
            className="w-44 font-mono"
            placeholder="Ticket id"
            value={f.ticket}
            onChange={(e) => setF({ ...f, ticket: e.target.value })}
          />
        </div>
        {q.isLoading ? (
          <div className="space-y-2 p-3">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : q.isError ? (
          <div className="p-3">
            <ErrorBox error={q.error} retry={() => void q.refetch()} />
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4">
            <EmptyState icon={<History />} title="No events match" hint="Try clearing a filter." />
          </div>
        ) : (
          <LogList events={rows} sentence={(e) => describeEvent(e, (id) => names.get(id))} />
        )}
        {q.hasNextPage && (
          <div className="border-t border-border p-3 text-center">
            <Button
              variant="outline"
              size="sm"
              disabled={q.isFetchingNextPage}
              onClick={() => void q.fetchNextPage()}
            >
              {q.isFetchingNextPage ? "Loading..." : "Load older"}
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}

// ---- Portal settings -------------------------------------------------------------------------------

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function SettingsSection() {
  const q = useQuery(settingsQuery);
  return (
    <>
      <div className="space-y-3">
        <Crumbs here="Portal Settings" />
        <h1 className="t-headline-lg">Portal Settings</h1>
      </div>
      {q.isLoading && <Skeleton className="h-72 w-full" />}
      {q.isError && <ErrorBox error={q.error} retry={() => void q.refetch()} />}
      {q.data && <SettingsForm initial={q.data} />}
    </>
  );
}

function SettingsForm({ initial }: { initial: PortalSettings }) {
  const qc = useQueryClient();
  const [s, setS] = useState<PortalSettings>(initial);
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () => saveSettings(s),
    onSuccess: (r) => {
      qc.setQueryData(settingsQuery.queryKey, r);
      setS(r);
      setSaved(true);
    },
  });
  const set = (patch: Partial<PortalSettings["reminders"]>) => {
    setSaved(false);
    setS({ ...s, reminders: { ...s.reminders, ...patch } });
  };
  const field = (label: string, node: ReactNode) => (
    <label className="block space-y-1.5">
      <MonoLabel>{label}</MonoLabel>
      {node}
    </label>
  );
  const hhmm = (v: string | null) => (v ?? "").slice(0, 5);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
      className="space-y-5"
    >
      <Card>
        <CardHeader title="Reminders & working hours" divided />
        <CardBody className="space-y-4 pt-4">
          <p className="flex items-start gap-2 rounded-[8px] bg-secondary p-2.5 text-[13px] text-secondary-foreground">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-status-warning" aria-hidden />
            Reminders stay off until a reminder time is set. Clear the field to turn them off again.
          </p>
          <div className="grid gap-4 sm:grid-cols-3">
            {field(
              "Daily reminder time",
              <Input
                type="time"
                value={hhmm(s.reminders.reminder_time)}
                onChange={(e) => set({ reminder_time: e.target.value || null })}
              />,
            )}
            {field(
              "Work starts",
              <Input
                type="time"
                required
                value={hhmm(s.reminders.work_start)}
                onChange={(e) => set({ work_start: e.target.value })}
              />,
            )}
            {field(
              "Work ends",
              <Input
                type="time"
                required
                value={hhmm(s.reminders.work_end)}
                onChange={(e) => set({ work_end: e.target.value })}
              />,
            )}
          </div>
          <div className="space-y-1.5">
            <MonoLabel>Working days</MonoLabel>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Working days">
              {DAYS.map((d, i) => {
                const on = s.reminders.work_days.includes(i);
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      set({
                        work_days: on
                          ? s.reminders.work_days.filter((x) => x !== i)
                          : [...s.reminders.work_days, i].sort(),
                      })
                    }
                    className={cn(
                      "h-7 rounded-full border px-3 text-[13px]",
                      on
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-secondary-foreground hover:bg-secondary",
                    )}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
          </div>
          {field(
            "Time zone (IANA name)",
            <Input
              className="max-w-xs font-mono"
              value={s.reminders.timezone}
              onChange={(e) => set({ timezone: e.target.value })}
            />,
          )}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="History retention" divided />
        <CardBody className="space-y-2 pt-4">
          {field(
            "Keep history for (days)",
            <Input
              type="number"
              min={1}
              className="max-w-[160px] font-mono"
              placeholder="Forever"
              value={s.retention_days ?? ""}
              onChange={(e) => {
                setSaved(false);
                setS({ ...s, retention_days: e.target.value ? Number(e.target.value) : null });
              }}
            />,
          )}
          <p className="text-[13px] text-muted-foreground">
            Empty keeps history forever. Nothing is deleted automatically yet; this only records the
            choice.
          </p>
        </CardBody>
      </Card>
      {save.isError && <ErrorBox error={save.error} />}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? "Saving..." : "Save settings"}
        </Button>
        {saved && <span className="t-data-sm text-status-good">Saved</span>}
      </div>
    </form>
  );
}
