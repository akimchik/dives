"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, PlusCircle } from "lucide-react";
import { toast } from "sonner";

import { createPadiDiveAction } from "@/app/actions/padi";
import { Button } from "@/components/ui/button";

export function CreatePadiDiveButton({ diveId }: { diveId: number }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function handleCreate() {
    startTransition(async () => {
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

  return (
    <Button type="button" variant="outline" disabled={isPending} onClick={handleCreate}>
      {isPending ? <Loader2 className="animate-spin" /> : <PlusCircle />}
      Create in PADI
    </Button>
  );
}
