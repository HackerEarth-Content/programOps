import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  AlertTriangle,
  Ban,
  Check,
  History,
  Lock,
  Mail,
  MoreHorizontal,
  Search,
  ShieldCheck,
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
  KpiCell,
  KpiStrip,
  LogList,
  MonoLabel,
  Notice,
  PageHeader,
  Skeleton,
  TabBar,
  roleTone,
} from "@/components/kit";
import { TimeDial } from "@/components/time-dial";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
  createInvites,
  invitesQuery,
  patchUser,
  revokeInvite,
  setUserPermissions,
  type AdminUser,
  type Invite,
  type InvitesResult,
} from "@/lib/ops-api";
import { cn } from "@/lib/utils";

const errorText = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong");
// Roles a person is given on purpose. Viewer is what everyone starts as, so it is never picked.
const GRANTABLE: UserRole[] = ROLES.filter((r) => r !== "viewer");
const SELF_REASON = "You can't change your own roles or access.";

const NAV: { id: Section; label: string; needs: string }[] = [
  { id: "users", label: "Users and personnel", needs: "users.manage" },
  { id: "roles", label: "Roles and policies", needs: "users.manage" },
  { id: "audit", label: "Audit log", needs: "audit.view" },
  { id: "settings", label: "Portal settings", needs: "settings.edit" },
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
        title="Admin is restricted"
        hint="Only super admins can manage access, settings and the audit log."
      />
    );
  }
  const wanted = parseSection(search.section);
  const section = visible.find((n) => n.id === wanted)?.id ?? visible[0]!.id;
  const canUsers = me.permissions.includes("users.manage");
  const tabs = (
    <TabBar
      label="Admin sections"
      active={section}
      items={visible}
      renderLink={(item, props) => (
        <button
          type="button"
          {...props}
          onClick={() => void navigate({ search: { section: item.id as Section } })}
        />
      )}
    />
  );
  return (
    <div className="page-in space-y-4">
      {section === "users" && <UsersSection meId={me.id} tabs={tabs} />}
      {section === "roles" && <RolesSection tabs={tabs} />}
      {section === "audit" && <AuditSection canUsers={canUsers} tabs={tabs} />}
      {section === "settings" && <SettingsSection tabs={tabs} />}
    </div>
  );
}

function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 rounded-[8px] border border-border bg-danger-bg px-3 py-2 text-[13px] text-danger"
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
        <Chip key={r} tone={roleTone(r)}>
          {ROLE_LABELS[r]}
        </Chip>
      ))}
    </div>
  );
}

// ---- Users & Personnel ---------------------------------------------------------------------------

type Row = { kind: "user"; user: AdminUser } | { kind: "invite"; invite: Invite };
type StatusFilter = "all" | "active" | "inactive" | "waiting" | "viewers";

function UsersSection({ meId, tabs }: { meId: string; tabs: ReactNode }) {
  const qc = useQueryClient();
  const users = useQuery(adminUsersQuery);
  const invites = useQuery(invitesQuery);
  const [roleFilter, setRoleFilter] = useState<UserRole | "all">("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [text, setText] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [permsFor, setPermsFor] = useState<string | null>(null);
  const [result, setResult] = useState<InvitesResult | null>(null);
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
  const revoke = useMutation({ mutationFn: revokeInvite, onSuccess: refreshInvites });
  const failure = patch.error ?? revoke.error ?? (exportError ? new Error(exportError) : null);

  const waiting = useMemo(
    () => (invites.data ?? []).filter((i) => i.status === "pending"),
    [invites.data],
  );
  const all = useMemo(() => users.data ?? [], [users.data]);
  const active = all.filter((u) => u.is_active);
  const superAdmins = active.filter((u) => u.roles.includes("super_admin"));
  const csms = active.filter((u) => u.roles.includes("csm"));
  // Signed in with a company account and not given a real role yet: newest first, so new people show up on top.
  const viewers = active
    .filter((u) => u.roles.every((r) => r === "viewer"))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

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
          (status === "inactive" && !u.is_active) ||
          (status === "viewers" && viewers.includes(u)),
      )
      .map((user) => ({ kind: "user", user }));
    const is: Row[] = waiting
      .filter((i) => matchRole(i.roles) && matchText(i.email))
      .filter(() => status === "all" || status === "waiting")
      .map((invite) => ({ kind: "invite", invite }));
    return [...us, ...is];
  }, [all, waiting, viewers, roleFilter, status, text]);
  const permsUser = all.find((u) => u.id === permsFor) ?? null;

  return (
    <>
      <PageHeader
        title="Users and access"
        subtitle={
          <>
            <b className="font-medium text-foreground">
              {all.length} {all.length === 1 ? "account" : "accounts"}
            </b>
            , {superAdmins.length} Super admin. Anyone signing in with a @hackerearth.com account
            starts as a Viewer until a Super admin gives them a role.
          </>
        }
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => exportAuditCsv().catch((e: unknown) => setExportError(errorText(e)))}
            >
              Export audit log
            </Button>
            <Button onClick={() => setInviteOpen(true)}>Pre-grant access</Button>
          </>
        }
      />
      {tabs}

      <KpiStrip label="Account summary">
        <KpiCell
          label="Total accounts"
          value={all.length}
          sub={`${active.length} active seats · ${waiting.length} pre-granted, not signed in yet`}
        />
        <KpiCell
          label="Super admins"
          value={superAdmins.length}
          sub={`${
            superAdmins
              .map((u) => u.name ?? u.email)
              .slice(0, 2)
              .join(", ") || "None"
          } · the last Super admin is protected`}
        />
        <KpiCell
          label="Client success (CSM)"
          value={csms.length}
          sub={`${csms.length} active · ${waiting.filter((i) => i.roles.includes("csm")).length} pre-granted`}
        />
        <KpiCell
          label="Viewers"
          value={viewers.length}
          sub={
            viewers.length ? "Give a role to anyone who should act" : "See progress, change nothing"
          }
        />
      </KpiStrip>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
          <Input
            aria-label="Filter by name or email"
            className="pl-8"
            placeholder="Filter by email or name"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <Select value={roleFilter} onValueChange={(v) => setRoleFilter(v as UserRole | "all")}>
          <SelectTrigger className="w-44" aria-label="Role">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Role: All</SelectItem>
            {ROLES.map((r) => (
              <SelectItem key={r} value={r}>
                {ROLE_LABELS[r]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
          <SelectTrigger className="w-44" aria-label="Status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Status: All</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
            <SelectItem value="viewers">Viewers only</SelectItem>
            <SelectItem value="waiting">Pre-granted</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        {failure && (
          <div className="p-3 pb-0">
            <ErrorBox error={failure} />
          </div>
        )}
        {result && (
          <Notice
            className="m-3"
            actions={
              <Button size="sm" variant="ghost" onClick={() => setResult(null)}>
                Dismiss
              </Button>
            }
          >
            Pre-granted {result.created.length}.
            {result.skipped.length > 0 &&
              ` Skipped ${result.skipped.length}: ${result.skipped
                .map((x) => `${x.email} (${SKIP_REASONS[x.reason] ?? x.reason})`)
                .join(", ")}.`}
          </Notice>
        )}
        {viewers.length > 0 && status !== "viewers" && (
          <Notice
            tone="neutral"
            className="m-3"
            actions={
              <Button size="sm" variant="outline" onClick={() => setStatus("viewers")}>
                Review who needs a role
              </Button>
            }
          >
            <b>{viewers.length}</b> {viewers.length === 1 ? "person has" : "people have"} signed in
            and can only view. Newest: {viewers[0]?.name ?? viewers[0]?.email}.
          </Notice>
        )}

        <div className="relative overflow-x-auto">
          <table className="w-full min-w-[960px] border-collapse text-left">
            <thead>
              <tr className="border-b border-border">
                {["User", "Role", "State", "Permissions", ""].map((h, i) => (
                  <th
                    key={i}
                    className={cn(
                      "px-4 py-2.5 text-[12px] font-medium text-ink-2",
                      i === 4 && "w-[260px]",
                    )}
                  >
                    {h || <span className="sr-only">Actions</span>}
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
                      onRevoke={() => revoke.mutate(row.invite.id)}
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
              hint="Clear a filter, or pre-grant access to someone."
            />
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2.5 text-[13px] text-ink-2">
          <span>
            Showing {rows.length} of {all.length + waiting.length} entries
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Lock aria-hidden className="size-3.5 shrink-0" />
            Nobody can change their own role, and the last Super admin can't be demoted or
            deactivated.
          </span>
        </div>
      </Card>

      <InviteSheet
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onCreated={(r) => {
          setResult(r);
          void refreshInvites();
          void qc.invalidateQueries({ queryKey: ["admin", "users"] });
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
      <td className="h-[72px] px-4 py-2">
        <div className="flex items-center gap-3">
          <Avatar name={u.name ?? u.email} className="size-8 text-[12px]" />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[14px] font-medium">
              {u.name ?? u.email}
              {isMe && <Chip tone="info">You</Chip>}
            </div>
            <div className="text-[13px] text-ink-2">
              <span className="break-all">{u.email}</span> · signed up {formatDate(u.created_at)}
            </div>
          </div>
        </div>
      </td>
      <td className="px-4 py-2">
        {u.roles.length ? <RoleChips roles={u.roles} /> : <Chip>No role yet</Chip>}
        {u.hubspot_csm_programs > 0 && !u.roles.includes("csm") && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12px] text-secondary-foreground">
            CSM on {u.hubspot_csm_programs} program{u.hubspot_csm_programs === 1 ? "" : "s"} in
            HubSpot
            <Button
              size="sm"
              variant="outline"
              disabled={isMe}
              title={isMe ? SELF_REASON : undefined}
              onClick={() => onPatch({ roles: [...u.roles.filter((r) => r !== "viewer"), "csm"] })}
            >
              Grant CSM
            </Button>
          </div>
        )}
      </td>
      <td className="px-4 py-2">
        <span className="inline-flex items-center gap-1.5 text-[13px]">
          <span
            aria-hidden
            className={cn("size-1.5 rounded-full", u.is_active ? "bg-ok" : "bg-ink-3")}
          />
          {u.is_active ? "Active" : "Inactive"}
        </span>
      </td>
      <td className="px-4 py-2 text-[13px]">
        {u.roles.length ? (
          <>
            <div>{defaults.size} role defaults</div>
            <div className="text-ink-2">
              {u.grants.length + u.revokes.length} customised ·{" "}
              <button
                type="button"
                onClick={onPerms}
                title={[
                  ...u.grants.map((p) => `+ ${PERMISSION_LABELS[p] ?? p}`),
                  ...u.revokes.map((p) => `− ${PERMISSION_LABELS[p] ?? p}`),
                ].join("\n")}
                className="text-primary hover:underline"
              >
                View all
              </button>
            </div>
          </>
        ) : (
          <span className="text-ink-2">No permissions</span>
        )}
      </td>
      <td className="px-4 py-2">
        <div className="flex items-center justify-end gap-1.5">
          <RolePopover user={u} disabled={isMe} onApply={(roles) => onPatch({ roles })} />
          <Button
            size="sm"
            variant="secondary"
            disabled={isMe}
            title={isMe ? SELF_REASON : undefined}
            onClick={onPerms}
          >
            Edit permissions
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
  const current: UserRole[] = user.roles.filter((r) => r !== "viewer");
  const [roles, setRoles] = useState<UserRole[]>(current);
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setRoles(current);
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
        {GRANTABLE.map((r) => (
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
          disabled={roles.length === current.length && roles.every((r) => current.includes(r))}
          onClick={() => {
            onApply(roles);
            setOpen(false);
          }}
        >
          Apply
        </Button>
        <p className="text-[12px] text-muted-foreground">
          No role means Viewer: sees progress only.
        </p>
      </PopoverContent>
    </Popover>
  );
}

function InviteRow({
  invite,
  index,
  onRevoke,
}: {
  invite: Invite;
  index: number;
  onRevoke: () => void;
}) {
  return (
    <tr
      className="border-b border-border bg-secondary/40 align-middle last:border-0"
      style={{ ["--i" as string]: index }}
    >
      <td className="h-[72px] px-4 py-2">
        <div className="flex items-center gap-3">
          <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground">
            <Mail className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="text-[14px] font-medium italic">{invite.email}</div>
            <div className="t-data-sm text-muted-foreground">
              pre-granted {formatDate(invite.created_at)}
            </div>
          </div>
        </div>
      </td>
      <td className="px-4 py-3">
        <RoleChips roles={invite.roles} />
      </td>
      <td className="px-4 py-3">
        <Chip tone="neutral">Waiting for first sign-in</Chip>
      </td>
      <td className="px-4 py-3 text-[13px] italic text-muted-foreground">
        Gets these roles instead of Viewer
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-1.5">
          <Button size="sm" variant="ghost" className="text-danger" onClick={onRevoke}>
            Revoke
          </Button>
        </div>
      </td>
    </tr>
  );
}

function RolePicker({ value, onChange }: { value: UserRole[]; onChange: (r: UserRole[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Roles">
      {GRANTABLE.map((r) => {
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

const SKIP_REASONS: Record<string, string> = {
  user_exists: "already has an account",
  outside_domain: "not a HackerEarth email",
};

const parseEmails = (text: string) => text.split(/[\s,;]+/).filter(Boolean);

function InviteSheet({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (r: InvitesResult) => void;
}) {
  const [text, setText] = useState("");
  const [roles, setRoles] = useState<UserRole[]>(["csm"]);
  const emails = parseEmails(text);
  const create = useMutation({
    mutationFn: () => createInvites(emails, roles),
    onSuccess: (r) => {
      onCreated(r);
      setText("");
      onOpenChange(false);
    },
  });
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Pre-grant access</SheetTitle>
          <SheetDescription>
            Set roles before someone first signs in. Paste one or many @hackerearth.com emails. They
            get these roles on their first sign-in instead of starting as a Viewer.
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
            <MonoLabel>Emails</MonoLabel>
            <Textarea
              required
              rows={5}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={"priya@hackerearth.com\nneha@hackerearth.com"}
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
            disabled={emails.length === 0 || roles.length === 0 || create.isPending}
          >
            {create.isPending
              ? "Saving..."
              : `Pre-grant ${emails.length || ""} ${emails.length === 1 ? "person" : "people"}`}
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

function RolesSection({ tabs }: { tabs: ReactNode }) {
  return (
    <>
      <PageHeader
        title="Roles and policies"
        subtitle="What each role can do by default. Individual overrides are set per user."
      />
      {tabs}
      <Card>
        <CardHeader
          title="Role defaults"
          meta="read-only · individual overrides are set per user"
          divided
        />
        <div className="relative overflow-x-auto">
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
                "Company sign-in only",
                "Google sign-in works only for @hackerearth.com accounts. New people start as read-only Viewers.",
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

function AuditSection({ canUsers, tabs }: { canUsers: boolean; tabs: ReactNode }) {
  const [f, setF] = useState<AuditFilters>({ entity: "", actor: "", ticket: "" });
  const users = useQuery({ ...adminUsersQuery, enabled: canUsers });
  const q = useInfiniteQuery(globalAuditQuery(f));
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];
  const names = new Map((users.data ?? []).map((u) => [u.id, u.name ?? u.email]));
  const sel = (v: string) => (v === "all" ? "" : v);
  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle="Who changed what, newest first."
        actions={
          <Button variant="outline" disabled={rows.length === 0} onClick={() => downloadCsv(rows)}>
            Export loaded rows
          </Button>
        }
      />
      {tabs}
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

function SettingsSection({ tabs }: { tabs: ReactNode }) {
  const q = useQuery(settingsQuery);
  return (
    <>
      <PageHeader
        title="Portal settings"
        subtitle="Working days, hours and defaults for the whole portal."
      />
      {tabs}
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
            Reminders stay off until a reminder time is set. Open the dial and choose Clear to turn
            them off again.
          </p>
          <div className="grid gap-4 sm:grid-cols-3">
            {field(
              "Daily reminder time",
              <TimeDial
                label="Daily reminder time"
                value={s.reminders.reminder_time}
                onChange={(v) => set({ reminder_time: v })}
              />,
            )}
            {field(
              "Work starts",
              <TimeDial
                label="Work starts"
                required
                value={s.reminders.work_start}
                onChange={(v) => set({ work_start: v ?? s.reminders.work_start })}
              />,
            )}
            {field(
              "Work ends",
              <TimeDial
                label="Work ends"
                required
                value={s.reminders.work_end}
                onChange={(v) => set({ work_end: v ?? s.reminders.work_end })}
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
        <CardHeader title="Registration counts" divided />
        <CardBody className="space-y-2 pt-4">
          {field(
            "Daily Redash fetch time",
            <TimeDial
              label="Daily Redash fetch time"
              value={s.redash_sync_time}
              onChange={(v) => {
                setSaved(false);
                setS({ ...s, redash_sync_time: v });
              }}
            />,
          )}
          <p className="text-[13px] text-muted-foreground">
            In the time zone above. Each day at this time, programs in an active stage that are
            inside their registration period are refreshed from Redash and today's count is posted
            to their Slack channel. Empty keeps the scheduled fetch off.
          </p>
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
