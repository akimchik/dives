"use client";

import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { downloadBlobFile } from "@/lib/download-file";

const GENERIC_ERROR = "Could not create backup. Please try again later.";

// No useTransition here (unlike components/backup-padi-button.tsx): the zip comes from a route
// handler, not a server action, so there's no server-state transition to await -- just a plain
// pending flag guarding double clicks for the duration of the fetch.
export function BackupDivesButton() {
  const [isPending, setIsPending] = useState(false);

  async function handleBackup() {
    setIsPending(true);
    try {
      const response = await fetch("/api/backup/dives");

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        toast.error(body?.error ?? GENERIC_ERROR);
        return;
      }

      const blob = await response.blob();
      const filename =
        /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "")?.[1] ?? "dives-backup.zip";

      downloadBlobFile(filename, blob);
      toast.success("Backup downloaded.");
    } catch {
      toast.error(GENERIC_ERROR);
    } finally {
      setIsPending(false);
    }
  }

  return (
    <Button type="button" variant="outline" disabled={isPending} onClick={handleBackup}>
      {isPending ? <Loader2 className="animate-spin" /> : <Download />}
      Backup dives
    </Button>
  );
}
