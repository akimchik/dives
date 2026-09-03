"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { deleteDiveAction } from "@/app/actions/dives";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

/**
 * Destructive action behind an explicit confirm step. The dialog is controlled rather than using
 * AlertDialogAction, so it stays open (with a spinner, and both buttons disabled) for the duration
 * of the server call instead of closing optimistically on click — a failed delete must leave the
 * user looking at the error, not at a dialog that already dismissed itself.
 */
export function DeleteDiveButton({ diveId, label }: { diveId: number; label: string }) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  function confirmDelete() {
    startTransition(async () => {
      const result = await deleteDiveAction(diveId);

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      setIsOpen(false);
      toast.success("Dive deleted.");
      router.push("/dives");
      router.refresh();
    });
  }

  return (
    <AlertDialog open={isOpen} onOpenChange={(next) => !isPending && setIsOpen(next)}>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="outline">
          <Trash2 /> Delete
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this dive?</AlertDialogTitle>
          <AlertDialogDescription>
            {label} will be removed from your logbook. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Keep dive</AlertDialogCancel>
          <Button
            type="button"
            variant="destructive"
            disabled={isPending}
            onClick={confirmDelete}
          >
            {isPending ? <Loader2 className="animate-spin" /> : <Trash2 />}
            Delete dive
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
