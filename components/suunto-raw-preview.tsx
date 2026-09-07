"use client";

import { useEffect, useState } from "react";
import { Search } from "lucide-react";

import { JsonTextView } from "@/components/json-text-view";
import { JsonTreeView } from "@/components/json-tree-view";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// A real Suunto export has tens of thousands of JSON nodes, so recomputing search/highlight state
// on every keystroke (each one landing mid-word, before the query means anything) is wasted, janky
// work -- debouncing the query that actually reaches the views keeps typing itself responsive.
const SEARCH_DEBOUNCE_MS = 250;

export function SuuntoRawPreview({ data }: { data: unknown }) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  return (
    <div className="flex flex-col gap-4">
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search keys and values…"
          className="pl-9"
          aria-label="Search raw Suunto data"
        />
      </div>

      <Tabs defaultValue="tree">
        <TabsList>
          <TabsTrigger value="tree">Object viewer</TabsTrigger>
          <TabsTrigger value="text">Syntax highlighted</TabsTrigger>
        </TabsList>
        <TabsContent value="tree">
          <JsonTreeView data={data} query={debouncedQuery} />
        </TabsContent>
        <TabsContent value="text">
          <JsonTextView data={data} query={debouncedQuery} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
