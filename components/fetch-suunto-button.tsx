"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { fetchSuuntoWorkoutsAction } from "@/app/actions/suunto";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export type SuuntoFetchStatus = "not_connected" | "needs_reconnect" | "connected";

export function FetchSuuntoButton({ status }: { status: SuuntoFetchStatus }) {
  const router = useRouter();
  const [daysBack, setDaysBack] = useState("10");
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  if (status !== "connected") {
    return (
      <Link href="/settings/integrations" className={cn(buttonVariants({ variant: "outline" }), "no-underline")}>
        <RefreshCw />
        {status === "needs_reconnect" ? "Reconnect Suunto" : "Connect Suunto"}
      </Link>
    );
  }

  function handleFetch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const count = Number(daysBack);
    if (!Number.isFinite(count)) return;

    startTransition(async () => {
      const result = await fetchSuuntoWorkoutsAction(count);
      if (!result.ok) {
        toast.error(result.error);
        router.refresh();
        return;
      }

      const skipped = result.alreadySaved + result.alreadyStaged + result.skippedNonDives + result.failedExports;
      toast.success(
        `Checked ${result.checked} workouts from the selected time window: staged ${result.staged}${skipped ? `, skipped ${skipped}` : ""}.`,
      );
      setOpen(false);
      router.refresh();
      if (result.nextImportId !== null) {
        router.push(`/settings/integrations/suunto/imports/${result.nextImportId}`);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !isPending && setOpen(nextOpen)}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" disabled={isPending}>
          {isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          Fetch Suunto
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={handleFetch} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Fetch Suunto workouts</DialogTitle>
            <DialogDescription>
              Choose how many recent days to check. Dive workouts that are already staged or saved are ignored.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dashboard-suunto-days">Recent days to check</Label>
            <Input
              id="dashboard-suunto-days"
              name="days"
              type="number"
              min={1}
              max={365}
              value={daysBack}
              onChange={(event) => setDaysBack(event.target.value)}
              required
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={isPending || Number(daysBack) < 1 || Number(daysBack) > 365}>
              {isPending ? <Loader2 className="animate-spin" /> : null}
              Fetch workouts
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
