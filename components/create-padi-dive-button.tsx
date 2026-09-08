"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, PlusCircle } from "lucide-react";
import { toast } from "sonner";

import { backupPadiAction, createPadiDiveAction, dismissPadiBackupPromptAction } from "@/app/actions/padi";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { downloadTextFile } from "@/lib/download-file";

// `needsBackupPrompt` reflects issue #14's nudge: the caller (app/dives/[id]/page.tsx) derives it
// from padi_integrations.backup_done_at/backup_prompt_dismissed_at both being null, i.e. the user
// has never backed up their PADI logbook and never explicitly skipped the offer either. The
// prompt, once shown, is a controlled dialog (mirroring delete-dive-button.tsx) rather than
// AlertDialogAction/Cancel's default auto-close, since both of its real choices ("Back up now" and
// "Skip and upload") kick off an async server call that must finish -- with the dialog still open
// and disabled -- before it's safe to close.
export function CreatePadiDiveButton({
  diveId,
  needsBackupPrompt = false,
}: {
  diveId: number;
  needsBackupPrompt?: boolean;
}) {
  const router = useRouter();
  const [isCreating, startCreateTransition] = useTransition();
  const [isBackingUp, startBackupTransition] = useTransition();
  const [isSkipping, startSkipTransition] = useTransition();
  const [promptOpen, setPromptOpen] = useState(false);
  // Once either choice in the dialog resolves, `needsBackupPrompt` itself may still read stale
  // (the server prop only refreshes via router.refresh()/navigation) -- this overrides it locally
  // for the rest of this component's lifetime so a later click can't reopen an already-resolved
  // prompt, e.g. after Skip's dismissal succeeds but the chained create fails for a reason that
  // doesn't itself trigger a refresh (validation, already_linked).
  const [promptResolved, setPromptResolved] = useState(false);

  const isPromptBusy = isBackingUp || isSkipping;
  const isBusy = isCreating || isPromptBusy;

  function runCreate() {
    startCreateTransition(async () => {
      const result = await createPadiDiveAction(diveId);

      if (!result.ok) {
        toast.error(result.error);
        if (result.reason === "not_connected" || result.reason === "reconnect_required") {
          router.refresh();
        }
        return;
      }

      toast.success(`Created in PADI (#${result.padiDiveId}).`);
      router.refresh();
    });
  }

  function handleCreateClick() {
    if (needsBackupPrompt && !promptResolved) {
      setPromptOpen(true);
      return;
    }
    runCreate();
  }

  function handleBackupNow() {
    startBackupTransition(async () => {
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
      setPromptResolved(true);
      setPromptOpen(false);
      runCreate();
    });
  }

  function handleSkip() {
    startSkipTransition(async () => {
      await dismissPadiBackupPromptAction();
      setPromptResolved(true);
      setPromptOpen(false);
      runCreate();
    });
  }

  return (
    <>
      <Button type="button" variant="outline" disabled={isBusy} onClick={handleCreateClick}>
        {isCreating ? <Loader2 className="animate-spin" /> : <PlusCircle />}
        Create in PADI
      </Button>
      <AlertDialog open={promptOpen} onOpenChange={(next) => !isPromptBusy && setPromptOpen(next)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Back up your PADI logbook first?</AlertDialogTitle>
            <AlertDialogDescription>
              You haven&apos;t backed up your PADI dives yet. We recommend downloading a backup
              before uploading changes to PADI.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPromptBusy}>Cancel</AlertDialogCancel>
            <Button type="button" variant="outline" disabled={isPromptBusy} onClick={handleSkip}>
              {isSkipping ? <Loader2 className="animate-spin" /> : null}
              Skip and upload
            </Button>
            <Button type="button" disabled={isPromptBusy} onClick={handleBackupNow}>
              {isBackingUp ? <Loader2 className="animate-spin" /> : null}
              Back up now
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
