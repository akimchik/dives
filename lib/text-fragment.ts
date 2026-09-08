// A URL fragment text directive (https://wicg.github.io/scroll-to-text-fragment/): a `#:~:text=`
// suffix that names a piece of page text instead of an element id, so a browser that implements
// the spec scrolls to and highlights it on load.
//
// Deliberately no reader/parser for this on the app's own side: the `:~:` marker is a *fragment
// directive*, and every browser that recognizes the syntax strips it from script-visible state
// (`location.hash`) before running any page JS -- confirmed against this project's own Playwright
// WebKit build, where even a fresh `page.goto()` to a `:~:text=` URL comes back with an empty
// hash. That's the spec's own design (a page must not be able to read what text a link claimed to
// highlight), not a bug to work around, so there is no reliable way for this app's JS to read the
// directive back out and re-implement the highlight itself -- the browser's native handling (where
// supported) is the only thing that ever sees it.
export function buildTextFragmentHash(text: string): string {
  return `#:~:text=${encodeURIComponent(text)}`;
}
