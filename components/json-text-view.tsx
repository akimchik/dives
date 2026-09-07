"use client";

import { useMemo } from "react";

import { Highlight } from "@/lib/json-highlight";

// Captures a JSON key/string literal (with its trailing colon, if it's a key), a boolean/null
// keyword, or a number -- everything else (braces, commas, bare colons, whitespace) falls into
// the unmatched text between captures.
const TOKEN_PATTERN = /("(?:\\.|[^"\\])*"(?:\s*:)?|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

// One <span> per JSON token is what a real Suunto export (measured: ~90k JSON nodes, ~3MB
// pretty-printed) turns into hundreds of thousands of React children -- fall back to a plain
// (still searchable via the browser's own find) block past this size instead of hanging the tab.
// Well below where the token count itself becomes the bottleneck, not just the character count.
const MAX_HIGHLIGHT_CHARS = 250_000;

function classifyToken(token: string): string {
  if (token.startsWith('"')) {
    return token.endsWith(":") ? "text-foreground/80" : "text-emerald-700 dark:text-emerald-400";
  }
  if (token === "true" || token === "false") return "text-amber-600 dark:text-amber-400";
  if (token === "null") return "text-muted-foreground";
  return "text-blue-600 dark:text-blue-400";
}

export function JsonTextView({ data, query }: { data: unknown; query: string }) {
  const formatted = useMemo(() => JSON.stringify(data, null, 2), [data]);
  const trimmedQuery = query.trim();
  const tooLargeToHighlight = formatted.length > MAX_HIGHLIGHT_CHARS;

  // `split` on a pattern with one capturing group returns the string interleaved with its
  // matches: even indices are the untokenized text between matches, odd indices are the tokens.
  // Skipped once the fallback below is going to be used anyway -- no point tokenizing text that
  // won't be rendered token-by-token.
  const parts = useMemo(
    () => (tooLargeToHighlight ? null : formatted.split(TOKEN_PATTERN)),
    [formatted, tooLargeToHighlight],
  );

  if (tooLargeToHighlight || parts === null) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">
          Too large to syntax-highlight ({formatted.length.toLocaleString()} characters) — showing
          plain text. Your browser&apos;s own find (e.g. ⌘F / Ctrl+F) still works here; the search
          box above still works on the object viewer tab.
        </p>
        <pre className="overflow-x-auto rounded-md border border-border bg-muted/20 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
          {formatted}
        </pre>
      </div>
    );
  }

  return (
    <pre className="overflow-x-auto rounded-md border border-border bg-muted/20 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <span key={index} className={classifyToken(part)}>
            <Highlight text={part} query={trimmedQuery} />
          </span>
        ) : (
          <Highlight key={index} text={part} query={trimmedQuery} />
        ),
      )}
    </pre>
  );
}
