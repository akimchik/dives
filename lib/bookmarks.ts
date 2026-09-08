import "server-only";

import { MAX_BOOKMARK_NAME_LENGTH, MAX_BOOKMARK_TEXT_LENGTH } from "./bookmark-limits";
import { getPool, queryRead } from "./db";

// Same ownership contract as lib/dives.ts's DiveNotFoundError: a bookmark id (or dive id) that
// doesn't belong to the session user resolves to "not found", never to someone else's row.
export class BookmarkNotFoundError extends Error {
  constructor(message = "Bookmark not found") {
    super(message);
    this.name = "BookmarkNotFoundError";
  }
}

export type BookmarkRow = {
  id: number;
  dive_id: number;
  name: string;
  selected_text: string;
  created_at: Date;
};

export type BookmarkWithDive = BookmarkRow & {
  dive_title: string | null;
  dive_occurred_at: Date;
  dive_site_name: string | null;
};

export type BookmarkInput = {
  diveId: number;
  name: string;
  selectedText: string;
};

function normalizeBookmarkInput(input: BookmarkInput) {
  const name = input.name.trim().slice(0, MAX_BOOKMARK_NAME_LENGTH);
  const selectedText = input.selectedText.trim().slice(0, MAX_BOOKMARK_TEXT_LENGTH);

  if (name.length === 0) throw new Error("Bookmark name is required");
  if (selectedText.length === 0) throw new Error("Bookmarked text is required");

  return { name, selectedText };
}

// Throws BookmarkNotFoundError (reused here for "no such dive of mine") rather than a dive-specific
// error, since the caller only ever needs to report one generic failure back through the action.
export async function createBookmark(userId: string, input: BookmarkInput): Promise<BookmarkRow> {
  const { name, selectedText } = normalizeBookmarkInput(input);

  const result = await getPool().query<BookmarkRow>(
    `
      insert into dive_bookmarks (user_id, dive_id, name, selected_text)
      select $1, d.id, $3, $4
      from dives d
      where d.id = $2
        and d.user_id = $1
      returning id, dive_id, name, selected_text, created_at
    `,
    [userId, input.diveId, name, selectedText],
  );

  const row = result.rows[0];
  if (!row) throw new BookmarkNotFoundError("Dive not found");

  return row;
}

export async function listBookmarks(userId: string): Promise<BookmarkWithDive[]> {
  const result = await queryRead<BookmarkWithDive>(
    `
      select
        b.id,
        b.dive_id,
        b.name,
        b.selected_text,
        b.created_at,
        d.title as dive_title,
        d.occurred_at as dive_occurred_at,
        s.name as dive_site_name
      from dive_bookmarks b
      join dives d on d.id = b.dive_id and d.user_id = b.user_id
      left join dive_sites s on s.id = d.dive_site_id and s.user_id = d.user_id
      where b.user_id = $1
      order by b.created_at desc
    `,
    [userId],
  );

  return result.rows;
}

export async function deleteBookmark(userId: string, bookmarkId: number): Promise<void> {
  const result = await getPool().query("delete from dive_bookmarks where id = $1 and user_id = $2", [
    bookmarkId,
    userId,
  ]);

  if (result.rowCount === 0) throw new BookmarkNotFoundError();
}
