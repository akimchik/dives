"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Tag, X } from "lucide-react";
import { toast } from "sonner";

import { searchTagsAction } from "@/app/actions/dives";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { MISSING_PADI_TAG, MISSING_SUUNTO_TAG } from "@/lib/tags";

const RESERVED_TAGS = new Set([MISSING_PADI_TAG, MISSING_SUUNTO_TAG]);

// Case differences ("Wreck" vs "wreck") would otherwise fragment the tag cloud into look-alike
// entries; normalizing on add keeps one canonical spelling per tag.
function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

export function TagsField({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  const inputId = useId();
  const listId = useId();
  const [draft, setDraft] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const query = draft.trim();

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const rows = await searchTagsAction(query || undefined);
        if (!cancelled) setSuggestions(rows.filter((tag) => !value.includes(tag)));
      } catch {
        if (!cancelled) setSuggestions([]);
      }
    }, 150);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `value` intentionally excluded below: it would refire the network lookup on every chip
    // add/remove even though the query didn't change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  useEffect(() => {
    if (!isOpen) return;

    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setIsOpen(false);
    }

    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [isOpen]);

  function addTag(raw: string) {
    const tag = normalizeTag(raw);
    if (!tag) return;

    // Cleared on every attempt, accepted or not: leaving a rejected reserved tag's text sitting in
    // the input would silently glue onto whatever the user types next.
    setDraft("");
    setIsOpen(false);

    if (RESERVED_TAGS.has(tag)) {
      toast.error(`"${tag}" is a reserved tag and is added automatically.`);
      return;
    }

    if (!value.includes(tag)) onChange([...value, tag]);
  }

  function removeTag(tag: string) {
    onChange(value.filter((existing) => existing !== tag));
  }

  return (
    <div className="flex flex-col gap-1.5" ref={containerRef}>
      <Label htmlFor={inputId}>Tags</Label>

      <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-input bg-transparent px-2 py-1.5 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30">
        {value.map((tag) => (
          <Badge key={tag} variant="default">
            <Tag className="size-3" aria-hidden />
            {tag}
            <button
              type="button"
              aria-label={`Remove tag ${tag}`}
              onClick={() => removeTag(tag)}
              className="ml-0.5 rounded-full outline-none hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring/30"
            >
              <X className="size-3" aria-hidden />
            </button>
          </Badge>
        ))}

        <input
          id={inputId}
          role="combobox"
          aria-expanded={isOpen}
          aria-controls={listId}
          aria-autocomplete="list"
          autoComplete="off"
          placeholder={value.length === 0 ? "wreck, night-dive, shark" : ""}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              addTag(draft);
            } else if (event.key === "Backspace" && draft === "" && value.length > 0) {
              removeTag(value[value.length - 1]);
            }
          }}
          className="min-w-24 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>

      {isOpen && suggestions.length > 0 ? (
        <ul
          id={listId}
          role="listbox"
          aria-label="Matching tags"
          className="z-20 max-h-56 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {suggestions.map((tag) => (
            <li key={tag}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => addTag(tag)}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
              >
                <Tag className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="truncate">{tag}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
