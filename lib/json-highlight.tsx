function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type HighlightSegment = { text: string; match: boolean };

function splitByQuery(text: string, query: string): HighlightSegment[] {
  if (!query) return [{ text, match: false }];

  const pattern = new RegExp(escapeRegExp(query), "gi");
  const segments: HighlightSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) segments.push({ text: text.slice(lastIndex, match.index), match: false });
    segments.push({ text: match[0], match: true });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) segments.push({ text: text.slice(lastIndex), match: false });

  return segments;
}

// Shared by the tree and syntax-highlighted-text views so a search query highlights consistently
// in both. Case-insensitive substring match, same as the tree view's own match detection.
export function Highlight({ text, query }: { text: string; query: string }) {
  const segments = splitByQuery(text, query);

  return segments.map((segment, index) =>
    segment.match ? (
      <mark key={index} className="rounded-sm bg-yellow-200 px-0.5 text-foreground dark:bg-yellow-500/40">
        {segment.text}
      </mark>
    ) : (
      segment.text
    ),
  );
}
