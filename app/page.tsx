import { redirect } from "next/navigation";

import { AuthForm } from "@/app/auth-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ModeToggle } from "@/components/mode-toggle";
import { isPasswordAuthEnabled } from "@/lib/auth-config";
import { resolveHomeRedirect } from "@/lib/home-redirect";
import { getOptionalUser } from "@/lib/session";

type HomePageProps = {
  searchParams?: Promise<{
    next?: string | string[];
    error?: string | string[];
  }>;
};

export default async function HomePage({ searchParams }: HomePageProps) {
  const user = await getOptionalUser();

  if (user) {
    redirect("/dashboard");
  }

  const params = await searchParams;
  const next = Array.isArray(params?.next) ? params.next[0] : params?.next;
  const error = Array.isArray(params?.error) ? params.error[0] : params?.error;
  const passwordAuthEnabled = isPasswordAuthEnabled();

  const homeRedirect = resolveHomeRedirect({ passwordAuthEnabled, next, error });
  if (homeRedirect) redirect(homeRedirect);

  return (
    <main className="mx-auto flex min-h-svh max-w-md flex-col justify-center gap-6 px-6 py-16">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-bold">Dives</h1>
          <p className="text-sm text-muted-foreground">
            Your personal scuba dive logbook.
          </p>
        </div>
        <ModeToggle />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{passwordAuthEnabled ? "Continue with email" : "Welcome"}</CardTitle>
          <CardDescription>
            {passwordAuthEnabled
              ? "Existing accounts continue with a password. New accounts receive a one-time setup link."
              : "Sign in to log and review your dives."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AuthForm
            next={next}
            oidcError={error === "oidc_failed"}
            passwordAuthEnabled={passwordAuthEnabled}
          />
        </CardContent>
      </Card>
    </main>
  );
}
