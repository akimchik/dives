"use client";

import { useId, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Upload, X } from "lucide-react";
import { toast } from "sonner";

import { DepthProfileChart } from "@/components/depth-profile-chart";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { DepthProfileParseResult } from "@/lib/depth-profile";

// Parsing happens in the parent (so it can block submit) and the result is handed down here purely
// to be displayed. The raw text is always kept verbatim alongside the parsed JSON — `depth_profile`
// is derived data, `depth_profile_raw` is what the user actually gave us, so a future parser change
// can re-derive the JSON from it.
export function DepthProfileField({
  value,
  onChange,
  result,
}: {
  value: string;
  onChange: (next: string) => void;
  result: DepthProfileParseResult | null;
}) {
  const fieldId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isReading, setIsReading] = useState(false);

  async function readFile(file: File) {
    setIsReading(true);
    try {
      onChange(await file.text());
    } catch {
      toast.error("Could not read that file.");
    } finally {
      setIsReading(false);
      // Reset so re-picking the same file still fires a change event.
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label htmlFor={fieldId}>Depth profile</Label>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            id={`${fieldId}-file`}
            type="file"
            accept=".csv,.txt,.uddf,.xml,text/csv,text/plain,application/xml"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void readFile(file);
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isReading}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload /> Upload file
          </Button>
          {value ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => onChange("")}>
              <X /> Clear
            </Button>
          ) : null}
        </div>
      </div>

      <Textarea
        id={fieldId}
        rows={5}
        spellCheck={false}
        placeholder={"Paste CSV or UDDF, e.g.\n0:00, 0\n3:00, 12.4\n18:00, 27.1"}
        className="font-mono text-xs"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={result?.ok === false}
        aria-describedby={`${fieldId}-status`}
      />

      <p id={`${fieldId}-status`} className="text-xs">
        {result === null ? (
          <span className="text-muted-foreground">
            Optional. Accepts a &quot;time, depth&quot; list (CSV, tab or space separated) or a UDDF
            export.
          </span>
        ) : result.ok ? (
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <CheckCircle2 className="size-3.5" aria-hidden />
            Parsed {result.points.length} points.
          </span>
        ) : (
          // The parser's own message, verbatim — it names the offending line, which a generic
          // "invalid profile" string would throw away.
          <span
            role="alert"
            data-testid="depth-profile-error"
            className="flex items-center gap-1.5 text-destructive"
          >
            <AlertCircle className="size-3.5" aria-hidden />
            {result.error}
          </span>
        )}
      </p>

      {result?.ok ? (
        <div className="rounded-md border border-border p-3">
          <DepthProfileChart points={result.points} />
        </div>
      ) : null}
    </div>
  );
}
