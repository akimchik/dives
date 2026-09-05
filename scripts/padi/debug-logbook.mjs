#!/usr/bin/env node
// Ad-hoc debug tool for the 403 `lib/padi/sync.ts` hits when listing the logbook in the pod (see
// PROMPTLOG.md, issue #1). Reproduces the real login -> decode idToken -> fetch logbook page flow
// using the same `scripts/padi/client.mjs` this app runs in production, then fires the logbook
// call twice with different header sets (the app's current minimal set vs. a full browser-header
// set captured from an actual session, see `scratch`) so the two can be compared side by side.
//
// A fake-token probe against logbook.global-prod.padi.com from this machine returned 401
// (invalid_token) regardless of headers, meaning PADI's edge does let bare requests through to
// token validation here -- so the pod's 403 with a real token is more likely IP/ASN-based (cloud
// egress IP flagged by PADI's WAF) than a missing-header rejection, but this script exists to
// check both against the pod's own network path (run it as a one-off Job/exec in-cluster to
// compare against a run from a home/laptop network).
//
// Usage:
//   PADI_USERNAME=... PADI_PASSWORD=... node scripts/padi/debug-logbook.mjs [--minimal|--browser]
// Omit --minimal/--browser to run both variants back to back with the same token.
//
// Never commit real credentials -- always pass them via env vars at invocation time.

import { login, decodeIdTokenClaims, LOGBOOK_PAGE_QUERY, PADI_CLIENT_ID } from "./client.mjs";

const PADI_LOGBOOK_BASE_URL = "https://logbook.global-prod.padi.com";

const MINIMAL_HEADERS = {};

// Captured verbatim from a real browser session against the logbook API, see `scratch`.
const BROWSER_HEADERS = {
  "Sec-Fetch-Site": "same-site",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Sec-Fetch-Mode": "cors",
  Origin: "https://learning.padi.com",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  Referer: "https://learning.padi.com/",
  "Sec-Fetch-Dest": "empty",
  Priority: "u=3, i",
};

async function fetchLogbookPageRaw(accessToken, affiliateId, extraHeaders) {
  const response = await fetch(`${PADI_LOGBOOK_BASE_URL}/api/Logbook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
      Authorization: `Bearer ${accessToken}`,
      "x-platform": "web",
      "affiliate-id": affiliateId,
      ...extraHeaders,
    },
    body: JSON.stringify({
      query: LOGBOOK_PAGE_QUERY,
      variables: { affiliate_id: affiliateId, limit: 1, offset: 0 },
    }),
  });

  const body = await response.text();
  return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body };
}

async function runVariant(label, accessToken, affiliateId, extraHeaders) {
  console.log(`\n--- ${label} ---`);
  const result = await fetchLogbookPageRaw(accessToken, affiliateId, extraHeaders);
  console.log("status:", result.status);
  console.log("response headers:", result.headers);
  console.log("body:", result.body);
}

async function main() {
  const username = process.env.PADI_USERNAME;
  const password = process.env.PADI_PASSWORD;
  if (!username || !password) {
    console.error("Set PADI_USERNAME and PADI_PASSWORD env vars before running this script.");
    process.exitCode = 1;
    return;
  }

  const onlyMinimal = process.argv.includes("--minimal");
  const onlyBrowser = process.argv.includes("--browser");

  console.log("PADI_CLIENT_ID:", PADI_CLIENT_ID);
  console.log("Logging in as", username, "...");
  const { tokens } = await login(username, password);

  const claims = decodeIdTokenClaims(tokens.idToken);
  const affiliateId = String(claims.affiliateId);
  console.log("affiliateId (custom:affiliate_id claim):", affiliateId);

  if (!onlyBrowser) {
    await runVariant("minimal headers (current app behavior)", tokens.accessToken, affiliateId, MINIMAL_HEADERS);
  }
  if (!onlyMinimal) {
    await runVariant("full browser headers", tokens.accessToken, affiliateId, BROWSER_HEADERS);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
