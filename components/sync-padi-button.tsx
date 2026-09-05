"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { syncPadiAction } from "@/app/actions/padi";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type PadiSyncStatus = "not_connected" | "needs_reconnect" | "connected";

// app/dashboard/page.tsx is an async server component and can't itself hold pending/transition
// state, so the interactive "Sync PADI" control lives here as its own client component, mirroring
// how the dive-add flow's own interactive bits are split out.
export function SyncPadiButton({ status }: { status: PadiSyncStatus }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  if (status !== "connected") {
    return (
      <Link href="/settings/integrations" className={cn(buttonVariants({ variant: "outline" }), "no-underline")}>
        <RefreshCw />
        {status === "needs_reconnect" ? "Reconnect PADI" : "Connect PADI"}
      </Link>
    );
  }

  function handleSync() {
    startTransition(async () => {
      const result = await syncPadiAction();

      if (!result.ok) {
        toast.error(result.error);
        if (result.reason === "reconnect_required" || result.reason === "not_connected") {
          router.refresh();
        }
        return;
      }

      if (result.remaining) {
        toast.success(`Imported ${result.imported} so far — click Sync again to continue.`);
      } else if (result.imported > 0) {
        toast.success(`Imported ${result.imported} new dive${result.imported === 1 ? "" : "s"}.`);
      } else {
        toast.success("No new dives found.");
      }

      router.refresh();
    });
  }

  return (
    <Button type="button" variant="outline" disabled={isPending} onClick={handleSync}>
      {isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
      Sync PADI
    </Button>
  );
}
