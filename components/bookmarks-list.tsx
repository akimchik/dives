"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { deleteBookmarkAction } from "@/app/actions/bookmarks";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDiveDate } from "@/lib/dive-format";
import { buildTextFragmentHash } from "@/lib/text-fragment";

export type BookmarkListItem = {
  id: number;
  diveId: number;
  name: string;
  selectedText: string;
  diveLabel: string;
  diveOccurredAt: string;
};

export function BookmarksList({ bookmarks }: { bookmarks: BookmarkListItem[] }) {
  if (bookmarks.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No bookmarks yet. Select some text on a dive page and click “Bookmark” to save it here.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Dive</TableHead>
          <TableHead>Bookmarked text</TableHead>
          <TableHead className="w-0" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {bookmarks.map((bookmark) => (
          <BookmarkRow key={bookmark.id} bookmark={bookmark} />
        ))}
      </TableBody>
    </Table>
  );
}

// Mirrors DeleteDiveButton's controlled-dialog approach (components/delete-dive-button.tsx): the
// dialog stays open with a spinner and both buttons disabled for the duration of the server call
// instead of closing optimistically, so a failed delete leaves the user looking at the error.
function BookmarkRow({ bookmark }: { bookmark: BookmarkListItem }) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  function confirmDelete() {
    startTransition(async () => {
      const result = await deleteBookmarkAction(bookmark.id);

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      setIsOpen(false);
      toast.success("Bookmark deleted.");
      router.refresh();
    });
  }

  return (
    <TableRow data-testid="bookmark-row">
      <TableCell className="font-medium">
        <Link
          href={`/dives/${bookmark.diveId}${buildTextFragmentHash(bookmark.selectedText)}`}
          className="no-underline hover:underline"
          data-testid="bookmark-link"
        >
          {bookmark.name}
        </Link>
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {bookmark.diveLabel} · {formatDiveDate(bookmark.diveOccurredAt)}
      </TableCell>
      <TableCell
        className="max-w-xs truncate text-sm text-muted-foreground"
        title={bookmark.selectedText}
      >
        {bookmark.selectedText}
      </TableCell>
      <TableCell>
        <AlertDialog open={isOpen} onOpenChange={(next) => !isPending && setIsOpen(next)}>
          <AlertDialogTrigger asChild>
            <Button type="button" variant="ghost" size="icon" aria-label="Delete bookmark">
              <Trash2 />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this bookmark?</AlertDialogTitle>
              <AlertDialogDescription>
                &ldquo;{bookmark.name}&rdquo; will be removed. This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isPending}>Keep bookmark</AlertDialogCancel>
              <Button type="button" variant="destructive" disabled={isPending} onClick={confirmDelete}>
                {isPending ? <Loader2 className="animate-spin" /> : <Trash2 />}
                Delete
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </TableCell>
    </TableRow>
  );
}
