import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import logoUrl from "@/assets/hackerearth_logo_light.png";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  GOOGLE_LOGIN_URL,
  currentUserQueryOptions,
  updateUserRole,
  type UserRole,
} from "@/lib/api";

const ROLE_OPTIONS: { value: UserRole; label: string }[] = [
  { value: "account_manager", label: "Account Manager" },
  { value: "csm", label: "CSM" },
  { value: "manager", label: "Manager" },
  { value: "other", label: "Other" },
];

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

function SignInScreen() {
  return (
    <CenteredScreen>
      <div className="workspace-panel space-y-4 p-6 text-center">
        <h1 className="font-display text-xl font-semibold">Sign in to continue</h1>
        <p className="text-sm text-muted-foreground">
          ProgramOps is internal to HackerEarth -- sign in with your Google account to view the
          pipeline.
        </p>
        {/* Real navigation, not a fetch/Link -- the backend sets a first-party
            CSRF cookie on this request, which a client-side fetch can't do. */}
        <a href={GOOGLE_LOGIN_URL}>
          <Button className="w-full">Sign in with Google</Button>
        </a>
      </div>
    </CenteredScreen>
  );
}

function RoleSelectScreen({ currentName }: { currentName: string | null }) {
  const queryClient = useQueryClient();
  const [role, setRole] = useState<UserRole | null>(null);
  const mutation = useMutation({
    mutationFn: (value: UserRole) => updateUserRole(value),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
    },
  });

  return (
    <CenteredScreen>
      <div className="workspace-panel space-y-5 p-6">
        <div className="text-center">
          <h1 className="font-display text-xl font-semibold">
            {currentName ? `Welcome, ${currentName}` : "Welcome"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">One-time setup -- what's your role?</p>
        </div>
        <RadioGroup value={role} onValueChange={(value) => setRole(value as UserRole)}>
          {ROLE_OPTIONS.map((option) => (
            <label
              key={option.value}
              htmlFor={option.value}
              className="flex cursor-pointer items-center gap-3 rounded-md border border-border px-3 py-2.5 text-sm transition-colors hover:bg-secondary/60"
            >
              <RadioGroupItem value={option.value} id={option.value} />
              <Label htmlFor={option.value} className="cursor-pointer">
                {option.label}
              </Label>
            </label>
          ))}
        </RadioGroup>
        {mutation.isError && (
          <p className="text-xs text-destructive">Couldn't save your role -- try again.</p>
        )}
        <Button
          className="w-full"
          disabled={!role || mutation.isPending}
          onClick={() => role && mutation.mutate(role)}
        >
          {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : "Continue"}
        </Button>
      </div>
    </CenteredScreen>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const { data: user, isLoading } = useQuery(currentUserQueryOptions);

  if (isLoading) {
    return (
      <CenteredScreen>
        <div className="flex justify-center py-8">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      </CenteredScreen>
    );
  }

  if (!user) return <SignInScreen />;
  if (!user.role) return <RoleSelectScreen currentName={user.name} />;

  return <>{children}</>;
}
