"use client";

import { useActionState, useEffect, useMemo, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import {
  loginAction,
  startAuthAction,
  type AuthActionState,
} from "@/app/actions/auth";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

const initialLoginState: AuthActionState = {};

function LoginButton() {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? <Loader2 className="animate-spin" /> : null}
      Sign in
    </Button>
  );
}

export function AuthForm({
  next,
  oidcError,
  passwordAuthEnabled,
}: {
  next?: string;
  oidcError?: boolean;
  passwordAuthEnabled: boolean;
}) {
  const [email, setEmail] = useState("");
  const [mode, setMode] = useState<"email" | "password" | "magic_sent">("email");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [loginState, loginFormAction] = useActionState(loginAction, initialLoginState);

  const normalizedEmail = useMemo(() => email.trim(), [email]);

  useEffect(() => {
    if (loginState.error) {
      toast.error(loginState.error);
    }
  }, [loginState.error]);

  useEffect(() => {
    if (oidcError) {
      toast.error(
        passwordAuthEnabled
          ? "Sign in with Authentik failed. Try again or use your password."
          : "Sign in failed. Please try again.",
      );
    }
  }, [oidcError, passwordAuthEnabled]);

  function continueWithEmail(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    startTransition(async () => {
      try {
        const result = await startAuthAction(normalizedEmail);

        if (result.mode === "password") {
          setMode("password");
          toast.success("Enter your password to continue.");
          return;
        }

        setMode("magic_sent");
        toast.success("Check your email for a registration link.");
      } catch {
        setError("Unable to continue. Please try again.");
        toast.error("Unable to continue. Please try again.");
      }
    });
  }

  if (!passwordAuthEnabled) {
    return (
      <div className="flex flex-col gap-3">
        {/* Plain <a>s, not next/link: these hit Route Handlers that
            redirect off-site to Authentik, not internal pages. */}
        <a href="/api/auth/authentik" className={cn(buttonVariants({ variant: "outline" }), "w-full")}>
          Sign in
        </a>
        <a href="/api/auth/authentik/signup" className={cn(buttonVariants({ variant: "default" }), "w-full")}>
          Sign up
        </a>
      </div>
    );
  }

  if (mode === "magic_sent") {
    return (
      <div className="flex flex-col gap-4 text-sm">
        <p className="text-muted-foreground">
          Check your inbox for a one-time registration link.
        </p>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setMode("email");
            setError(null);
          }}
        >
          Use a different email
        </Button>
      </div>
    );
  }

  if (mode === "password") {
    return (
      <form action={loginFormAction} className="flex flex-col gap-4">
        <input type="hidden" name="email" value={normalizedEmail} />
        {next ? <input type="hidden" name="next" value={next} /> : null}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="login-email">Email</Label>
          <Input id="login-email" type="email" value={normalizedEmail} disabled />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </div>
        <LoginButton />
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setMode("email");
            setError(null);
          }}
        >
          Use a different email
        </Button>
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Plain <a>, not next/link: this hits a Route Handler that redirects
          off-site to Authentik, not an internal page. */}
      <a href="/api/auth/authentik" className={cn(buttonVariants({ variant: "outline" }), "w-full")}>
        Sign in with Authentik
      </a>
      <div className="flex items-center gap-3 text-muted-foreground text-sm">
        <div className="h-px flex-1 bg-border" />
        or
        <div className="h-px flex-1 bg-border" />
      </div>
      <form onSubmit={continueWithEmail} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Button type="submit" disabled={isPending || !normalizedEmail} className="w-full">
        {isPending ? <Loader2 className="animate-spin" /> : null}
        Continue
      </Button>
      </form>
    </div>
  );
}
