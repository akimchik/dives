"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import {
  connectSuuntoAction,
  disconnectSuuntoAction,
  fetchSuuntoWorkoutsAction,
} from "@/app/actions/suunto";
import { Button } from "@/components/ui/button";
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

export type SuuntoConnectStatus = {
  status: "connected" | "needs_reconnect";
  connectedAt: string;
  lastFetchAt: string | null;
} | null;

export function SuuntoConnectForm({
  status,
  pendingCount,
}: {
  status: SuuntoConnectStatus;
  pendingCount: number;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [daysBack, setDaysBack] = useState("10");
  const [showReconnectForm, setShowReconnectForm] = useState(false);
  const [fetchOpen, setFetchOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleConnect(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    startTransition(async () => {
      const result = await connectSuuntoAction(email, password);
      if (result.ok) {
        setPassword("");
        setShowReconnectForm(false);
        toast.success("Suunto connected.");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  function handleDisconnect() {
    startTransition(async () => {
      const result = await disconnectSuuntoAction();
      if (result.ok) {
        setEmail("");
        setPassword("");
        setShowReconnectForm(false);
        toast.success("Suunto disconnected.");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  function handleFetch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const count = Number(daysBack);
    if (!Number.isFinite(count)) return;

    startTransition(async () => {
      const result = await fetchSuuntoWorkoutsAction(count);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      const skipped = result.alreadySaved + result.alreadyStaged + result.skippedNonDives + result.failedExports;
      toast.success(
        `Checked ${result.checked} workouts from the selected time window: staged ${result.staged}${skipped ? `, skipped ${skipped}` : ""}.`,
      );
      setFetchOpen(false);
      router.refresh();
      if (result.nextImportId !== null) {
        router.push(`/settings/integrations/suunto/imports/${result.nextImportId}`);
      }
    });
  }

  if (status?.status === "connected" && !showReconnectForm) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Connected since {new Date(status.connectedAt).toLocaleDateString()}.
          {status.lastFetchAt ? ` Last fetched ${new Date(status.lastFetchAt).toLocaleString()}.` : ""}
        </p>
        {pendingCount > 0 ? (
          <p className="text-sm text-muted-foreground">
            {pendingCount} staged {pendingCount === 1 ? "dive is" : "dives are"} waiting for review.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Dialog open={fetchOpen} onOpenChange={(open) => !isPending && setFetchOpen(open)}>
            <DialogTrigger asChild>
              <Button type="button" disabled={isPending} className="w-fit">
                Fetch Suunto workouts
              </Button>
            </DialogTrigger>
            <DialogContent>
              <form onSubmit={handleFetch} className="flex flex-col gap-4">
                <DialogHeader>
                  <DialogTitle>Fetch Suunto workouts</DialogTitle>
                  <DialogDescription>
                    Choose how many recent days to check. Dive workouts that are already staged or
                    saved are ignored.
                  </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="suunto-limit">Recent days to check</Label>
                  <Input
                    id="suunto-limit"
                    name="limit"
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
          <Button
            type="button"
            variant="outline"
            disabled={isPending}
            onClick={() => setShowReconnectForm(true)}
            className="w-fit"
          >
            Reconnect Suunto
          </Button>
          <Button type="button" variant="outline" disabled={isPending} onClick={handleDisconnect} className="w-fit">
            {isPending ? <Loader2 className="animate-spin" /> : null}
            Disconnect Suunto
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleConnect} className="flex flex-col gap-4">
      {status?.status === "needs_reconnect" ? (
        <p className="text-sm text-destructive">
          Your Suunto session expired. Enter your Suunto App login again below.
        </p>
      ) : null}
      {status?.status === "connected" && showReconnectForm ? (
        <p className="text-sm text-muted-foreground">
          Re-enter your Suunto App login below. {" "}
          <button
            type="button"
            onClick={() => setShowReconnectForm(false)}
            className="underline underline-offset-2"
          >
            Cancel
          </button>
        </p>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="suunto-email">Suunto email</Label>
        <Input
          id="suunto-email"
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="suunto-password">Suunto password</Label>
        <Input
          id="suunto-password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Your password is sent to suuntool once via stdin to create a reusable session, and is never stored.
      </p>
      <Button type="submit" disabled={isPending || !email || !password} className="w-fit">
        {isPending ? <Loader2 className="animate-spin" /> : null}
        {status ? "Reconnect Suunto" : "Connect Suunto"}
      </Button>
    </form>
  );
}
