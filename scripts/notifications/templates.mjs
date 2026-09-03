const TONE_COLORS = {
  never: { bg: "#f1f5f9", text: "#334155", border: "#cbd5e1" },
  active: { bg: "#ecfdf5", text: "#047857", border: "#a7f3d0" },
  obsolete: { bg: "#fee2e2", text: "#991b1b", border: "#fecaca" },
  nrnd: { bg: "#fefce8", text: "#854d0e", border: "#fde68a" },
  unknown: { bg: "#fff7ed", text: "#9a3412", border: "#fed7aa" },
};

const SIDENOTE =
  "If you no longer want these notifications, delete the BOM file from the console.";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function badge(tone, label) {
  const colors = TONE_COLORS[tone] ?? TONE_COLORS.unknown;
  return (
    `<span style="display:inline-block;padding:2px 8px;border-radius:4px;` +
    `background:${colors.bg};color:${colors.text};border:1px solid ${colors.border};` +
    `font-size:12px;font-weight:600;">${escapeHtml(label)}</span>`
  );
}

function fileUrl(baseUrl, bomFileId) {
  return `${baseUrl.replace(/\/$/, "")}/dashboard/bom/${bomFileId}`;
}

export function renderBomUploadedSection({ filename, bomFileId, bomFileUrl, itemCount, manufacturerCounts }) {
  const manufacturers = Object.entries(manufacturerCounts ?? {}).sort(([, a], [, b]) => b - a);
  const listRows = manufacturers
    .map(
      ([manufacturer, count]) =>
        `<li>${escapeHtml(manufacturer || "(none)")}: ${count}</li>`,
    )
    .join("");

  const bodyHtml =
    `<p>Your BOM file <strong>${escapeHtml(filename)}</strong> was uploaded successfully.</p>` +
    `<p>Items: ${itemCount}<br />Unique manufacturers: ${manufacturers.length}</p>` +
    `<p>Items per manufacturer:</p><ul>${listRows}</ul>` +
    `<p>Lifecycle checks will run within 10 minutes and results will appear on the console.</p>` +
    `<p><a href="${bomFileUrl}">View this BOM file on the console</a></p>`;

  const bodyText = [
    `Your BOM file "${filename}" was uploaded successfully.`,
    ``,
    `Items: ${itemCount}`,
    `Unique manufacturers: ${manufacturers.length}`,
    ``,
    `Items per manufacturer:`,
    ...manufacturers.map(([manufacturer, count]) => `- ${manufacturer || "(none)"}: ${count}`),
    ``,
    `Lifecycle checks will run within 10 minutes and results will appear on the console.`,
    ``,
    bomFileUrl,
  ].join("\n");

  return {
    subject: `BOM uploaded: ${filename}`,
    heading: `BOM uploaded: ${filename}`,
    sectionId: bomFileId,
    bodyHtml,
    bodyText,
    footer: SIDENOTE,
  };
}

// Never include per-item identifiers (MPN, manufacturer) in email bodies — only aggregated
// counts. Recipients follow the BOM file link to see which specific parts changed.
function countByLabel(items) {
  const counts = new Map();
  for (const item of items) {
    const existing = counts.get(item.label);
    if (existing) existing.count += 1;
    else counts.set(item.label, { tone: item.tone, label: item.label, count: 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

function countByTransition(changes) {
  const counts = new Map();
  for (const change of changes) {
    const key = `${change.previousLabel} ${change.label}`;
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else
      counts.set(key, {
        previousLabel: change.previousLabel,
        tone: change.tone,
        label: change.label,
        count: 1,
      });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

export function renderFirstCheckSection({ filename, bomFileId, baseUrl, items }) {
  const url = fileUrl(baseUrl, bomFileId);
  const summary = countByLabel(items);

  const listRows = summary
    .map(({ tone, label, count }) => `<li style="margin:4px 0;">${count} &times; ${badge(tone, label)}</li>`)
    .join("");

  const bodyHtml =
    `<p>All ${items.length} item(s) from BOM file <strong>${escapeHtml(filename)}</strong> have been checked for lifecycle status.</p>` +
    `<ul style="list-style:none;padding:0;margin:0 0 12px;">${listRows}</ul>` +
    `<p><a href="${url}">View this BOM file on the console</a> to see which parts have which status.</p>`;

  const bodyText = [
    `All ${items.length} item(s) from BOM file ${filename} have been checked for lifecycle status.`,
    ``,
    ...summary.map(({ label, count }) => `- ${count} x ${label}`),
    ``,
    `View the file to see which parts have which status: ${url}`,
  ].join("\n");

  return {
    subject: `Lifecycle check complete: ${filename}`,
    heading: `Lifecycle check complete: ${filename}`,
    sectionId: bomFileId,
    bodyHtml,
    bodyText,
    footer: SIDENOTE,
  };
}

export function renderStatusChangeSection({ filename, bomFileId, baseUrl, changes }) {
  const url = fileUrl(baseUrl, bomFileId);
  const summary = countByTransition(changes);

  const listRows = summary
    .map(
      ({ previousLabel, tone, label, count }) => `
        <li style="margin:4px 0;">
          ${count} part(s):
          <span style="text-decoration:line-through;color:#94a3b8;margin-right:6px;">${escapeHtml(previousLabel)}</span>
          ${badge(tone, label)}
        </li>`,
    )
    .join("");

  const bodyHtml =
    `<p>${changes.length} item(s) from BOM file <strong>${escapeHtml(filename)}</strong> changed lifecycle status.</p>` +
    `<ul style="list-style:none;padding:0;margin:0 0 12px;">${listRows}</ul>` +
    `<p><a href="${url}">View this BOM file on the console</a> to see which parts changed.</p>`;

  const bodyText = [
    `${changes.length} item(s) from BOM file ${filename} changed lifecycle status.`,
    ``,
    ...summary.map(({ previousLabel, label, count }) => `- ${count} part(s): ${previousLabel} -> ${label}`),
    ``,
    `View the file to see which parts changed: ${url}`,
  ].join("\n");

  return {
    subject: `Lifecycle status changed: ${filename}`,
    heading: `Lifecycle status changed: ${filename}`,
    sectionId: bomFileId,
    bodyHtml,
    bodyText,
    footer: SIDENOTE,
  };
}

// Anchors the tos_acceptance hash chain's tip to an email a human can keep
// -- see dives issue #56's "External anchor" section. Sent to every
// configured recipient both on every new acceptance and on a daily
// heartbeat (scripts/tos-anchor-heartbeat.mjs), so a stale tip (nothing
// arriving for a day) is itself a signal worth noticing.
export function renderTosAcceptanceSection({ seq, recordHashHex, acceptedAt, totalRowCount }) {
  const bodyHtml =
    `<p>tos_acceptance chain tip:</p>` +
    `<ul style="list-style:none;padding:0;margin:0 0 12px;">` +
    `<li>seq: <strong>${escapeHtml(seq)}</strong></li>` +
    `<li>record_hash: <code>${escapeHtml(recordHashHex)}</code></li>` +
    `<li>accepted_at: ${escapeHtml(acceptedAt)}</li>` +
    `<li>total rows: ${escapeHtml(totalRowCount)}</li>` +
    `</ul>` +
    `<p>Keep this email; it is the external anchor for the append-only ToS acceptance log. ` +
    `See the verification runbook in issue #56 for how to check a stored row against an anchor.</p>`;

  const bodyText = [
    `tos_acceptance chain tip:`,
    ``,
    `seq: ${seq}`,
    `record_hash: ${recordHashHex}`,
    `accepted_at: ${acceptedAt}`,
    `total rows: ${totalRowCount}`,
    ``,
    `Keep this email; it is the external anchor for the append-only ToS acceptance log.`,
    `See the verification runbook in issue #56 for how to check a stored row against an anchor.`,
  ].join("\n");

  return {
    subject: `tos_acceptance anchor: seq ${seq}`,
    heading: `tos_acceptance anchor: seq ${seq}`,
    bodyHtml,
    bodyText,
  };
}

// Growth/monitoring signal for issue #102 -- fired once per real (non-test) signup, distinct from
// the per-acceptance tos_acceptance anchor above. userNumber is the running count of non-test
// users (see lib/users.ts's countNonTestUsers), so admins can see growth trend at a glance.
export function renderNewUserSignupSection({ email, userNumber }) {
  const bodyHtml =
    `<p>New user signed up: <strong>${escapeHtml(email)}</strong></p>` +
    `<p>This is user #${escapeHtml(userNumber)} (excluding test accounts).</p>`;

  const bodyText = [
    `New user signed up: ${email}`,
    ``,
    `This is user #${userNumber} (excluding test accounts).`,
  ].join("\n");

  return {
    subject: `New user signup: ${email}`,
    heading: `New user signup: ${email}`,
    bodyHtml,
    bodyText,
  };
}

// When multiple sections in one combined email share the exact same heading (e.g. the same
// filename uploaded more than once -- issue #109), the batch reads like one event sent several
// times. Tag each colliding section with its BOM file id so a recipient can tell they're distinct
// uploads. Sections without a sectionId (tos_acceptance) are left alone.
function disambiguateHeadings(sections) {
  const counts = new Map();
  for (const section of sections) {
    counts.set(section.heading, (counts.get(section.heading) ?? 0) + 1);
  }

  return sections.map((section) => {
    if (counts.get(section.heading) <= 1 || section.sectionId == null) return section;
    return { ...section, heading: `${section.heading} (BOM file #${section.sectionId})` };
  });
}

// A single-section batch reuses that section's own subject verbatim so the common
// one-notification-per-recipient case is unchanged from the pre-queue emails; a multi-section
// batch gets a summary subject and each section under its own sub-heading joined by <hr>, with
// one copy of each distinct section footer (e.g. SIDENOTE) instead of repeating it per section.
// tos_acceptance sections carry no footer at all -- SIDENOTE's "delete the BOM file" advice
// doesn't apply to an anchor email, and this recipient never uploaded anything.
export function renderCombinedEmail(sections) {
  const subject =
    sections.length === 1 ? sections[0].subject : `Dives: ${sections.length} updates`;

  const displaySections = sections.length === 1 ? sections : disambiguateHeadings(sections);

  const inner =
    sections.length === 1
      ? sections[0].bodyHtml
      : displaySections
          .map(
            (section) =>
              `<h2 style="font-size:16px;margin:0 0 8px;">${escapeHtml(section.heading)}</h2>${section.bodyHtml}`,
          )
          .join(`<hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;" />`);

  const footers = [...new Set(sections.map((section) => section.footer).filter(Boolean))];

  const html =
    `<div style="font-family:sans-serif;font-size:14px;color:#0f172a;">` +
    inner +
    footers.map((footer) => `<p style="color:#64748b;font-size:12px;">${footer}</p>`).join("") +
    `</div>`;

  const text =
    (sections.length === 1
      ? sections[0].bodyText
      : displaySections
          .map((section) => `${section.heading}\n\n${section.bodyText}`)
          .join("\n\n---\n\n")) +
    (footers.length ? `\n\n${footers.join("\n\n")}` : "");

  return { subject, html, text };
}
