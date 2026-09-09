"use client";

import { useState, useTransition } from "react";
import { Loader2, MessageSquare, Send } from "lucide-react";
import { toast } from "sonner";

import { submitFeedbackAction } from "@/app/actions/feedback";
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
import { Textarea } from "@/components/ui/textarea";

// Header icon button (sized to match ModeToggle) that opens a dialog for a free-form message.
// The action resolves the submitting user server-side, so this component needs no props.
export function FeedbackButton() {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();

  function handleSubmit() {
    startTransition(async () => {
      const result = await submitFeedbackAction(message);

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      toast.success("Thanks for the feedback!");
      setMessage("");
      setOpen(false);
    });
  }

  return (
    <Dialog
      open={open}
      // Closing mid-submit would leave the transition running against an unmounted dialog, so the
      // dialog stays put until the server action settles (AGENTS.md rule 5).
      onOpenChange={(next) => {
        if (isPending) return;
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="size-7" aria-label="Send feedback">
          <MessageSquare className="size-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send feedback</DialogTitle>
          <DialogDescription>
            Found a bug or have an idea? It goes straight to the issue tracker.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          disabled={isPending}
          placeholder="What would you like us to know?"
          className="min-h-32"
          aria-label="Feedback message"
        />
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={isPending}
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
          <Button type="button" disabled={isPending || !message.trim()} onClick={handleSubmit}>
            {isPending ? <Loader2 className="animate-spin" /> : <Send />}
            Send feedback
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
