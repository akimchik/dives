function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function wrapHtml(inner) {
  return `<div style="font-family:sans-serif;font-size:14px;color:#0f172a;">${inner}</div>`;
}

// Growth/monitoring signal -- fired once per real (non-test) signup. userNumber is the running
// count of non-test users (see lib/users.ts's countNonTestUsers), so admins can see the growth
// trend at a glance.
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

const DIVE_EVENT_LABELS = {
  create: "logged",
  edit: "updated",
  delete: "deleted",
};

// Human labels for the columns of migrations/019_dives.sql, in the order they read best in an
// email. Any key the payload carries that isn't listed here still renders, with a humanised
// version of its own column name, so adding a dive column doesn't silently drop it from backups.
const DIVE_FIELD_LABELS = {
  id: "Dive id",
  occurred_at: "Date/time",
  site_name: "Dive site",
  site_location: "Location",
  site_lat: "Latitude",
  site_lng: "Longitude",
  max_depth: "Max depth",
  avg_depth: "Average depth",
  bottom_time_minutes: "Bottom time (min)",
  water_temp: "Water temperature",
  visibility: "Visibility",
  gas_mix: "Gas mix",
  tank_info: "Cylinder/tank",
  weight: "Weight",
  suit_type: "Suit",
  buddy: "Buddy/guide",
  dive_shop: "Dive shop/operator",
  current: "Current",
  surge: "Surge",
  weather: "Weather",
  entry_type: "Entry type",
  notes: "Notes",
  rating: "Rating",
  depth_profile: "Depth profile",
  created_at: "Created at",
  updated_at: "Updated at",
};

// The depth profile is reproduced in full in the JSON attachment; the email body only counts its
// samples, and the raw import text is attachment-only.
const DIVE_BODY_SKIPPED_FIELDS = new Set(["depth_profile_raw"]);

function humaniseKey(key) {
  const label = String(key).replaceAll("_", " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// Postgres normalises jsonb key order on write, so the payload's own key order coming back out of
// the queue is not the order the server action wrote. Both the email body and the CSV attachment
// (queue.mjs) order columns through here instead, so a backup's columns read the same every time.
export function orderedDiveColumns(dive) {
  const keys = Object.keys(dive ?? {});
  const known = Object.keys(DIVE_FIELD_LABELS).filter((key) => keys.includes(key));
  const extra = keys.filter((key) => !(key in DIVE_FIELD_LABELS)).sort();
  return [...known, ...extra];
}

function orderedDiveEntries(dive) {
  return orderedDiveColumns(dive).map((key) => [key, dive[key]]);
}

function formatBodyValue(key, value) {
  if (value === null || value === undefined || value === "") return null;
  if (key === "depth_profile") {
    const samples = Array.isArray(value) ? value.length : Object.keys(value).length;
    return `${samples} sample(s) (see the attached JSON)`;
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function diveTitle(dive) {
  const site = dive?.site_name ? String(dive.site_name) : null;
  const when = dive?.occurred_at ? String(dive.occurred_at) : null;
  if (site && when) return `${site} — ${when}`;
  return site ?? when ?? `dive #${dive?.id ?? "?"}`;
}

// dive_backup rows are never combined with other notifications (see queue.mjs's COMBINABLE_TYPES),
// so this renders a complete email rather than a section for renderCombinedEmail. The payload is
// `{ event: "create" | "edit" | "delete", dive: { ...flat column snapshot } }` — written by the
// dive server actions and serialised verbatim into the attachments.
export function renderDiveBackupEmail({ event, dive }) {
  const label = DIVE_EVENT_LABELS[event] ?? "changed";
  const title = diveTitle(dive);

  const fields = orderedDiveEntries(dive)
    .filter(([key]) => !DIVE_BODY_SKIPPED_FIELDS.has(key))
    .map(([key, value]) => [DIVE_FIELD_LABELS[key] ?? humaniseKey(key), formatBodyValue(key, value)])
    .filter(([, value]) => value !== null);

  const bodyHtml =
    `<p>Your dive log entry was <strong>${escapeHtml(label)}</strong>. This email is your backup ` +
    `copy — the full record is attached as JSON and CSV.</p>` +
    `<ul style="list-style:none;padding:0;margin:0 0 12px;">` +
    fields
      .map(
        ([field, value]) =>
          `<li style="margin:4px 0;"><strong>${escapeHtml(field)}:</strong> ${escapeHtml(value)}</li>`,
      )
      .join("") +
    `</ul>`;

  const bodyText = [
    `Your dive log entry was ${label}. This email is your backup copy — the full record is attached as JSON and CSV.`,
    ``,
    ...fields.map(([field, value]) => `${field}: ${value}`),
  ].join("\n");

  return {
    subject: `Dive ${label}: ${title}`,
    html: wrapHtml(bodyHtml),
    text: bodyText,
  };
}

// A single-section batch reuses that section's own subject verbatim so the common
// one-notification-per-recipient case is unchanged from the pre-queue emails; a multi-section
// batch gets a summary subject and each section under its own sub-heading joined by <hr>.
export function renderCombinedEmail(sections) {
  const subject =
    sections.length === 1 ? sections[0].subject : `Dives: ${sections.length} updates`;

  const inner =
    sections.length === 1
      ? sections[0].bodyHtml
      : sections
          .map(
            (section) =>
              `<h2 style="font-size:16px;margin:0 0 8px;">${escapeHtml(section.heading)}</h2>${section.bodyHtml}`,
          )
          .join(`<hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;" />`);

  const text =
    sections.length === 1
      ? sections[0].bodyText
      : sections.map((section) => `${section.heading}\n\n${section.bodyText}`).join("\n\n---\n\n");

  return { subject, html: wrapHtml(inner), text };
}
