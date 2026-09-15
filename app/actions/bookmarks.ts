"use server";

import { revalidatePath } from "next/cache";

import {
  BookmarkNotFoundError,
  createBookmark,
  deleteBookmark,
  type BookmarkInput,
  type BookmarkRow,
} from "@/lib/bookmarks";
import { withActionTelemetry } from "@/lib/action-otel";
import { requireUser } from "@/lib/session";

export type BookmarkActionResult =
  | { ok: true; bookmark: BookmarkRow }
  | { ok: false; error: string };

function toActionError(error: unknown): { ok: false; error: string } {
  if (error instanceof BookmarkNotFoundError) {
    return { ok: false, error: "Dive not found." };
  }

  console.error("Bookmark action failed", error);
  return { ok: false, error: "Something went wrong. Please try again." };
}

export async function createBookmarkAction(input: BookmarkInput): Promise<BookmarkActionResult> {
  const user = await requireUser();

  return withActionTelemetry("createBookmark", () => user, async () => {
    try {
      const bookmark = await createBookmark(user.id, input);
      revalidatePath("/bookmarks");
      return { ok: true, bookmark };
    } catch (error) {
      return toActionError(error);
    }
  });
}

export async function deleteBookmarkAction(
  bookmarkId: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireUser();

  return withActionTelemetry("deleteBookmark", () => user, async () => {
    try {
      await deleteBookmark(user.id, bookmarkId);
      revalidatePath("/bookmarks");
      return { ok: true };
    } catch (error) {
      return toActionError(error);
    }
  });
}
