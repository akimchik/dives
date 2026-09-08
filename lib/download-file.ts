// Client-only: triggers a browser "Save As" for in-memory text content, e.g. the JSON payload a
// server action already fetched (so there's no separate authenticated download route to build).
// The anchor is appended/removed synchronously around the click because Firefox ignores a click on
// an <a> that was never attached to the document. WebKit (this repo's e2e/AGENTS.md-mandated
// engine) starts the download asynchronously, so revoking the object URL in the same tick can race
// it and cancel the download -- the revoke is deferred to a macrotask instead.
export function downloadTextFile(filename: string, content: string, mimeType = "application/json") {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);

  setTimeout(() => URL.revokeObjectURL(url), 0);
}
