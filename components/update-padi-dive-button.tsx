"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, UploadCloud } from "lucide-react";
import { toast } from "sonner";

import { updatePadiDiveAction } from "@/app/actions/padi";
import { Button } from "@/components/ui/button";

export function UpdatePadiDiveButton({ diveId }: { diveId: number }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function handleUpdate() {
    startTransition(async () => {
      const result = await updatePadiDiveAction(diveId);

      if (!result.ok) {
        toast.error(result.error);
        if (result.reason === "not_connected" || result.reason === "reconnect_required") {
          router.refresh();
        }
        return;
      }

      toast.success(`Updated PADI dive #${result.padiDiveId}.`);
      router.refresh();
    });
  }

  return (
    <Button type="button" variant="outline" disabled={isPending} onClick={handleUpdate}>
      {isPending ? <Loader2 className="animate-spin" /> : <UploadCloud />}
      Update to PADI
    </Button>
  );
}
