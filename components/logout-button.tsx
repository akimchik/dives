"use client";

import { useTransition } from "react";
import { Loader2, LogOut } from "lucide-react";
import { toast } from "sonner";

import { logoutAction } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";

// logoutAction ends with redirect(), which throws a NEXT_REDIRECT control-flow error rather than
// returning -- so there is no success branch to toast here, only a real failure to report. The
// button stays disabled for the whole transition (AGENTS.md) so a double click can't fire two
// logouts and race the redirect.
export function LogoutButton() {
  const [isPending, startTransition] = useTransition();

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={isPending}
      onClick={() =>
        startTransition(async () => {
          try {
            await logoutAction();
          } catch (error) {
            // Next's redirect signal must be re-thrown, not swallowed as a failure.
            if (error && typeof error === "object" && "digest" in error) throw error;
            toast.error("Could not sign out. Please try again.");
          }
        })
      }
    >
      {isPending ? <Loader2 className="animate-spin" /> : <LogOut />}
      Sign out
    </Button>
  );
}
