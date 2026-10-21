import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import logoUrl from "@/assets/hackerearth_logo_light.png";
import { Button } from "@/components/ui/button";
import {
  GOOGLE_LOGIN_URL,
  ROLE_LABELS,
  currentUserQueryOptions,
  fetchInvitePreview,
  logout,
} from "@/lib/api";

// Why a Google sign-in was refused: the backend redirects back with ?auth_error=<code>.
const AUTH_ERRORS: Record<string, string> = {
  not_invited: "ProgramOps is invite-only. Ask a super admin to invite you.",
  invite_invalid: "That invite link isn't valid. Ask a super admin for a new one.",
  invite_expired: "That invite link has expired. Ask a super admin for a new one.",
  invite_email_mismatch: "Sign in with the Google account the invite was sent to.",
};

const INVITE_PATH = /^\/invite\/([^/]+)/;

function CenteredScreen({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <span className="flex size-12 items-center justify-center overflow-hidden rounded-xl bg-brand-panel ring-1 ring-border">
            <img src={logoUrl} alt="HackerEarth" className="brand-logo size-7 object-contain" />
          </span>
          <span className="font-display text-lg font-semibold text-foreground">ProgramOps</span>
        </div>
        {children}
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <CenteredScreen>
      <div className="flex justify-center py-8">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    </CenteredScreen>
  );
}

function SignInScreen({ errorCode }: { errorCode: string | null }) {
  const error = errorCode ? (AUTH_ERRORS[errorCode] ?? "Sign-in failed. Try again.") : null;
  return (
    <CenteredScreen>
      <div className="workspace-panel space-y-4 p-6 text-center">
        <h1 className="font-display text-xl font-semibold">Sign in to continue</h1>
        <p className="text-sm text-muted-foreground">
          ProgramOps is internal to HackerEarth and invite-only. Sign in with the Google account you
          were invited with.
        </p>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {/* Real navigation, not a fetch/Link -- the backend sets a first-party
            CSRF cookie on this request, which a client-side fetch can't do. */}
        <a href={GOOGLE_LOGIN_URL}>
          <Button className="w-full">Sign in with Google</Button>
        </a>
      </div>
    </CenteredScreen>
  );
}

function InviteScreen({ token }: { token: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["invite", token],
    queryFn: () => fetchInvitePreview(token),
    retry: false,
  });
  if (isLoading) return <Spinner />;
  return (
    <CenteredScreen>
      <div className="workspace-panel space-y-4 p-6 text-center">
        {data ? (
          <>
            <h1 className="font-display text-xl font-semibold">You're invited</h1>
            <p className="text-sm text-muted-foreground">
              Join ProgramOps as <b>{data.roles.map((role) => ROLE_LABELS[role]).join(" + ")}</b>.
              Sign in with the Google account for <b>{data.email_hint}</b>.
            </p>
            <a href={`${GOOGLE_LOGIN_URL}?invite=${encodeURIComponent(token)}`}>
              <Button className="w-full">Continue with Google</Button>
            </a>
          </>
        ) : (
          <>
            <h1 className="font-display text-xl font-semibold">Invite not valid</h1>
            <p className="text-sm text-destructive">
              {error instanceof Error ? error.message : "This invite link is not valid."}
            </p>
            <p className="text-sm text-muted-foreground">Ask a super admin for a new link.</p>
          </>
        )}
      </div>
    </CenteredScreen>
  );
}

function PendingScreen({ name }: { name: string | null }) {
  const queryClient = useQueryClient();
  return (
    <CenteredScreen>
      <div className="workspace-panel space-y-4 p-6 text-center">
        <h1 className="font-display text-xl font-semibold">
          {name ? `Welcome, ${name}` : "Welcome"}
        </h1>
        <p className="text-sm text-muted-foreground">
          You're signed in, but you don't have a role yet. A super admin needs to give you access.
        </p>
        <Button
          variant="outline"
          className="w-full"
          onClick={async () => {
            await logout();
            await queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
          }}
        >
          Sign out
        </Button>
      </div>
    </CenteredScreen>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const { pathname, searchStr } = useRouterState({ select: (s) => s.location });
  const { data: user, isLoading } = useQuery(currentUserQueryOptions);

  // The invite page is public: the person isn't signed in yet.
  const invite = INVITE_PATH.exec(pathname);
  if (invite?.[1]) return <InviteScreen token={decodeURIComponent(invite[1])} />;

  if (isLoading) return <Spinner />;
  if (!user) return <SignInScreen errorCode={new URLSearchParams(searchStr).get("auth_error")} />;
  if (user.pending) return <PendingScreen name={user.name} />;

  return <>{children}</>;
}
