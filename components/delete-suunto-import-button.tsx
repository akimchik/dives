"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { deleteSuuntoImportAction } from "@/app/actions/suunto";
import { Button } from "@/components/ui/button";

export function DeleteSuuntoImportButton({ importId }: { importId: number }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function handleDelete() {
    startTransition(async () => {
      const result = await deleteSuuntoImportAction(importId);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success("Suunto import deleted.");
      router.refresh();
      router.push("/settings/integrations");
    });
  }

  return (
    <Button type="button" variant="outline" disabled={isPending} onClick={handleDelete} className="w-fit">
      {isPending ? <Loader2 className="animate-spin" /> : <Trash2 />}
      Delete staged import
    </Button>
  );
}
