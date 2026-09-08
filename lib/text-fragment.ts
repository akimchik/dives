// A URL fragment text directive (https://wicg.github.io/scroll-to-text-fragment/): a `#:~:text=`
// suffix that names a piece of page text instead of an element id, so a browser that implements
// the spec scrolls to and highlights it on load.
//
// The `:~:` sequence is a *fragment directive* marker, and it turns out every browser that
// recognizes the syntax strips it (and everything after it) from script-visible state
// (`location.hash`) regardless of whether that browser actually implements the highlighting
// behavior -- confirmed against both this project's Playwright WebKit build and real Safari,
// neither of which currently highlights anything, but both still silently discard the directive.
// So a bare `#:~:text=…` link is a dead end for this app's own JS: there'd be nothing left to
// read back out in the browsers this project's users actually run.
//
// The fix is a second, ordinary fragment segment placed BEFORE the `:~:` marker. Per the same
// stripping rule, browsers only remove the marker and what follows it -- content before it is
// left alone. `#bookmark-text=<value>:~:text=<value>` therefore survives as `location.hash ===
// "#bookmark-text=<value>"` in every browser (verified: a fresh `page.goto()` *and* a
// `history.pushState` both preserve it), while browsers that DO implement native Scroll-To-Text
// still get the `:~:text=` part for free. This app's own highlighter
// (components/text-fragment-highlight.tsx) reads the `bookmark-text=` segment; nothing reads the
// `:~:text=` segment back out, by design -- it's there only for native browser handling.
const BOOKMARK_TEXT_PARAM = "bookmark-text=";

export function buildTextFragmentHash(text: string): string {
  const encoded = encodeURIComponent(text);
  return `#${BOOKMARK_TEXT_PARAM}${encoded}:~:text=${encoded}`;
}

// Reads the bookmark-text= segment back out of a location.hash (already stripped of any `:~:`
// suffix by the browser by the time page JS sees it). Returns null if absent.
export function parseBookmarkTextHash(hash: string): string | null {
  if (!hash.startsWith(`#${BOOKMARK_TEXT_PARAM}`)) return null;

  const raw = hash.slice(`#${BOOKMARK_TEXT_PARAM}`.length);
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export type TextOffsetMatch = { start: number; end: number };

// Locates `needle` inside `haystack`. Tries an exact substring match first (the common case, since
// a browser selection is copied verbatim), then falls back to matching with runs of whitespace
// collapsed (a value re-rendered from stored text can wrap differently, changing which whitespace
// characters fall between words without changing the words themselves). The fallback still returns
// offsets into the ORIGINAL haystack, not the collapsed one.
export function findTextOffset(haystack: string, needle: string): TextOffsetMatch | null {
  if (needle.length === 0) return null;

  const exactIndex = haystack.indexOf(needle);
  if (exactIndex !== -1) return { start: exactIndex, end: exactIndex + needle.length };

  const collapsedNeedle = needle.trim().replace(/\s+/g, " ");
  if (collapsedNeedle.length === 0) return null;

  // Map each character of a whitespace-collapsed haystack back to its index in the original.
  const collapsedChars: string[] = [];
  const originalIndices: number[] = [];
  let previousWasSpace = false;

  for (let i = 0; i < haystack.length; i++) {
    const char = haystack[i];
    const isSpace = /\s/.test(char);

    if (isSpace) {
      if (previousWasSpace) continue;
      collapsedChars.push(" ");
      originalIndices.push(i);
      previousWasSpace = true;
    } else {
      collapsedChars.push(char);
      originalIndices.push(i);
      previousWasSpace = false;
    }
  }

  const collapsedHaystack = collapsedChars.join("");
  const collapsedIndex = collapsedHaystack.indexOf(collapsedNeedle);
  if (collapsedIndex === -1) return null;

  const start = originalIndices[collapsedIndex];
  const endCollapsedIndex = collapsedIndex + collapsedNeedle.length - 1;
  const end = originalIndices[endCollapsedIndex] + 1;

  return { start, end };
}
