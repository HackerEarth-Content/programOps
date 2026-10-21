import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { GOOGLE_LOGIN_URL, currentUserQueryOptions, logout } from "@/lib/api";

// Why a Google sign-in was refused: the backend redirects back with ?auth_error=<code>.
const AUTH_ERRORS: Record<string, string> = {
  outside_domain:
    "ProgramOps is for HackerEarth accounts. Sign in with your @hackerearth.com Google account.",
};

function CenteredScreen({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <img
            src="/favicon.png"
            alt="HackerEarth"
            className="size-12 rounded-xl bg-white object-contain ring-1 ring-border dark:ring-white/40"
          />
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
          ProgramOps is internal to HackerEarth. Sign in with your @hackerearth.com Google account.
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
  const { searchStr } = useRouterState({ select: (s) => s.location });
  const { data: user, isLoading } = useQuery(currentUserQueryOptions);

  if (isLoading) return <Spinner />;
  if (!user) return <SignInScreen errorCode={new URLSearchParams(searchStr).get("auth_error")} />;
  if (user.pending) return <PendingScreen name={user.name} />;

  return <>{children}</>;
}
