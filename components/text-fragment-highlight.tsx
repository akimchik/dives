"use client";

import { useEffect } from "react";

import { findTextOffset, parseBookmarkTextHash } from "@/lib/text-fragment";

/**
 * On mount, looks for a `#bookmark-text=` segment in the current URL (as produced by
 * lib/text-fragment.ts's buildTextFragmentHash) and, if the text is found inside
 * #<containerId>, wraps it in a <mark> and scrolls it into view. This is the app's OWN
 * highlight, independent of the browser's native Scroll-To-Text-Fragment handling of the
 * accompanying `:~:text=` segment: see lib/text-fragment.ts's file comment for why relying on
 * that alone doesn't work in practice (WebKit/Safari discard the directive without ever
 * highlighting anything).
 */
export function TextFragmentHighlight({ containerId }: { containerId: string }) {
  useEffect(() => {
    const needle = parseBookmarkTextHash(window.location.hash);
    if (!needle) return;

    const container = document.getElementById(containerId);
    if (!container) return;

    // React (dev/StrictMode) can invoke this effect twice for one mount; highlightText mutates
    // the DOM (wrapping text nodes in <mark>), which isn't idempotent -- a second run would find
    // its own previous <mark> and wrap it again. Skip if a highlight is already present.
    if (container.querySelector('[data-testid="bookmark-highlight"]')) return;

    highlightText(container, needle);
  }, [containerId]);

  return null;
}

type TextNodeSpan = { node: Text; start: number; end: number };

function collectTextNodeSpans(root: Element): { spans: TextNodeSpan[]; fullText: string } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const spans: TextNodeSpan[] = [];
  let fullText = "";
  let node = walker.nextNode();

  while (node) {
    const text = node.textContent ?? "";
    spans.push({ node: node as Text, start: fullText.length, end: fullText.length + text.length });
    fullText += text;
    node = walker.nextNode();
  }

  return { spans, fullText };
}

function highlightText(container: Element, needle: string) {
  const { spans, fullText } = collectTextNodeSpans(container);
  const match = findTextOffset(fullText, needle);
  if (!match) return;

  // Each overlapping text node is wrapped independently (rather than trying to wrap the whole
  // match in one <mark>), since a single element can't span across sibling elements' boundaries.
  // Nodes are snapshotted above before any mutation, so wrapping one doesn't invalidate the next.
  const overlapping = spans.filter((span) => span.start < match.end && span.end > match.start);
  let firstMark: HTMLElement | null = null;

  for (const span of overlapping) {
    const localStart = Math.max(0, match.start - span.start);
    const localEnd = Math.min(span.node.length, match.end - span.start);
    if (localStart >= localEnd) continue;

    const range = document.createRange();
    range.setStart(span.node, localStart);
    range.setEnd(span.node, localEnd);

    const mark = document.createElement("mark");
    mark.setAttribute("data-testid", "bookmark-highlight");
    mark.className = "bg-yellow-200 text-yellow-950 dark:bg-yellow-500/40 dark:text-yellow-50";

    try {
      range.surroundContents(mark);
    } catch {
      continue;
    }

    firstMark ??= mark;
  }

  firstMark?.scrollIntoView({ block: "center", behavior: "smooth" });
}
