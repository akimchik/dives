"use client";

import { useEffect, useState, useTransition } from "react";
import { Bookmark, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { createBookmarkAction } from "@/app/actions/bookmarks";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MAX_BOOKMARK_NAME_LENGTH, MAX_BOOKMARK_TEXT_LENGTH } from "@/lib/bookmark-limits";

const MIN_SELECTION_LENGTH = 2;

type FloatingButtonPosition = { top: number; left: number };

/**
 * Watches for text selections made inside any of `containerIds` (the dive detail page's textual
 * content -- the title/subtitle heading and the property/notes cards are two separate containers
 * since layout puts the action buttons between them in the DOM; charts and the site map are
 * deliberately in neither) and offers to bookmark the selection. Only single-element selections
 * are offered: a bookmark's stored text is later re-found with a plain substring search
 * (lib/text-fragment.ts), which only round-trips cleanly for one contiguous run of text, not an
 * arbitrary multi-field selection.
 *
 * `containerIds` is a dependency of the selectionchange listener's effect, so pass a
 * module-level/memoized array rather than an inline literal -- otherwise the listener would tear
 * down and re-attach on every render.
 */
export function BookmarkCapture({ diveId, containerIds }: { diveId: number; containerIds: string[] }) {
  const [buttonPosition, setButtonPosition] = useState<FloatingButtonPosition | null>(null);
  const [selectedText, setSelectedText] = useState("");
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    function handleSelectionChange() {
      if (isDialogOpen) return;

      const selection = window.getSelection();
      const text = selection?.toString().trim() ?? "";

      if (!selection || selection.rangeCount === 0 || text.length < MIN_SELECTION_LENGTH) {
        setButtonPosition(null);
        setSelectedText("");
        return;
      }

      const range = selection.getRangeAt(0);
      const anchor = selection.anchorNode;
      const focus = selection.focusNode;

      const withinAnyContainer = containerIds.some((id) => {
        const container = document.getElementById(id);
        return container !== null && anchor !== null && focus !== null &&
          container.contains(anchor) && container.contains(focus);
      });
      const sameElement = anchor?.parentElement !== undefined && anchor?.parentElement === focus?.parentElement;

      if (!withinAnyContainer || !sameElement) {
        setButtonPosition(null);
        setSelectedText("");
        return;
      }

      // getBoundingClientRect() is already viewport-relative, which is exactly what a `fixed`-
      // positioned element needs -- adding window.scrollX/scrollY here (as if this were
      // `absolute`-positioned against the document) pushed the button further off-screen the
      // more the page was scrolled, which is why it silently failed to appear for any selection
      // below the fold (e.g. Notes, near the bottom of a long dive page) while still "working"
      // near the top of an unscrolled page.
      const rect = range.getBoundingClientRect();
      setButtonPosition({ top: Math.max(8, rect.top - 40), left: Math.max(8, rect.left) });
      setSelectedText(text.slice(0, MAX_BOOKMARK_TEXT_LENGTH));
    }

    document.addEventListener("selectionchange", handleSelectionChange);
    return () => document.removeEventListener("selectionchange", handleSelectionChange);
  }, [containerIds, isDialogOpen]);

  function openDialog() {
    setName(selectedText.slice(0, MAX_BOOKMARK_NAME_LENGTH));
    setIsDialogOpen(true);
  }

  function save() {
    const trimmedName = name.trim();
    if (!trimmedName || !selectedText) return;

    startTransition(async () => {
      const result = await createBookmarkAction({ diveId, name: trimmedName, selectedText });

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      toast.success("Bookmarked.");
      setIsDialogOpen(false);
      setButtonPosition(null);
      setSelectedText("");
      window.getSelection()?.removeAllRanges();
    });
  }

  return (
    <>
      {buttonPosition && !isDialogOpen ? (
        <Button
          type="button"
          size="sm"
          data-testid="bookmark-selection-button"
          className="fixed z-40 shadow-md"
          style={{ top: buttonPosition.top, left: buttonPosition.left }}
          onMouseDown={(event) => {
            // A plain click fires after mouseup, by which point the browser would already have
            // collapsed the selection -- mousedown fires first, so preventDefault here is what
            // keeps the selection (and thus selectedText) alive into the dialog.
            event.preventDefault();
            openDialog();
          }}
        >
          <Bookmark /> Bookmark
        </Button>
      ) : null}

      <Dialog
        open={isDialogOpen}
        onOpenChange={(next) => {
          if (isPending) return;
          setIsDialogOpen(next);
          if (!next) setButtonPosition(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Bookmark this text</DialogTitle>
            <DialogDescription>&ldquo;{selectedText}&rdquo;</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bookmark-name">Name</Label>
            <Input
              id="bookmark-name"
              value={name}
              maxLength={MAX_BOOKMARK_NAME_LENGTH}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={isPending}
              onClick={() => setIsDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button type="button" disabled={isPending || !name.trim()} onClick={save}>
              {isPending ? <Loader2 className="animate-spin" /> : <Bookmark />}
              Save bookmark
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
