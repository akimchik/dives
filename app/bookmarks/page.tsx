import type { Metadata } from "next";

import { AppShell } from "@/components/app-shell";
import { BookmarksList, type BookmarkListItem } from "@/components/bookmarks-list";
import { listBookmarks } from "@/lib/bookmarks";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = {
  title: "Bookmarks · Dives",
};

export default async function BookmarksPage() {
  const user = await requireUser("/bookmarks");
  const bookmarks = await listBookmarks(user.id);

  const items: BookmarkListItem[] = bookmarks.map((bookmark) => ({
    id: bookmark.id,
    diveId: bookmark.dive_id,
    name: bookmark.name,
    selectedText: bookmark.selected_text,
    diveLabel: bookmark.dive_title ?? bookmark.dive_site_name ?? "Unnamed dive",
    diveOccurredAt: bookmark.dive_occurred_at.toISOString(),
  }));

  return (
    <AppShell email={user.email}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Bookmarks</h1>
          <p className="text-sm text-muted-foreground">
            Jump back to specific pieces of a dive you bookmarked earlier.
          </p>
        </div>

        <BookmarksList bookmarks={items} />
      </div>
    </AppShell>
  );
}
