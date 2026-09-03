import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { isPasswordAuthEnabled } from "@/lib/auth-config";

import { RegistrationForm } from "./registration-form";

type RegisterPageProps = {
  params: Promise<{
    token: string;
  }>;
};

export default async function RegisterPage({ params }: RegisterPageProps) {
  const { token } = await params;
  const passwordAuthEnabled = isPasswordAuthEnabled();

  return (
    <main className="mx-auto flex min-h-svh max-w-md flex-col justify-center gap-6 px-6 py-16">
      <h1 className="text-3xl font-bold">Dives</h1>
      <Card>
        <CardHeader>
          <CardTitle>
            {passwordAuthEnabled ? "Create your password" : "Password sign-up is disabled"}
          </CardTitle>
          <CardDescription>
            {passwordAuthEnabled
              ? "Finish setting up your account with a password of at least 8 characters."
              : "This app signs in through Authentik. Ask an administrator for access."}
          </CardDescription>
        </CardHeader>
        {passwordAuthEnabled ? (
          <CardContent>
            <RegistrationForm token={token} />
          </CardContent>
        ) : null}
      </Card>
    </main>
  );
}
