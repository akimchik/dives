"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { backupPadiAction } from "@/app/actions/padi";
import { Button } from "@/components/ui/button";
import { downloadTextFile } from "@/lib/download-file";

export function BackupPadiButton() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function handleBackup() {
    startTransition(async () => {
      const result = await backupPadiAction();

      if (!result.ok) {
        toast.error(result.error);
        if (result.reason === "not_connected" || result.reason === "reconnect_required") {
          router.refresh();
        }
        return;
      }

      downloadTextFile(result.filename, result.data);
      toast.success(
        result.skipped > 0
          ? `Backed up ${result.count} PADI dive${result.count === 1 ? "" : "s"} (${result.skipped} could not be fetched).`
          : `Backed up ${result.count} PADI dive${result.count === 1 ? "" : "s"}.`,
      );
      router.refresh();
    });
  }

  return (
    <Button type="button" variant="outline" disabled={isPending} onClick={handleBackup}>
      {isPending ? <Loader2 className="animate-spin" /> : <Download />}
      Backup PADI dives
    </Button>
  );
}
