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

const DIVE_EVENT_LABELS = {
  create: "logged",
  edit: "updated",
  delete: "deleted",
};

// Human labels for the columns of migrations/019_dives.sql + 020_dives_extra_fields.sql, in the
// order they read best in an email. Any key the payload carries that isn't listed here still
// renders, with a humanised version of its own column name, so adding a dive column doesn't
// silently drop it from backups.
const DIVE_FIELD_LABELS = {
  id: "Dive id",
  title: "Title",
  occurred_at: "Date/time",
  site_name: "Dive site",
  site_location: "Location",
  site_lat: "Latitude",
  site_lng: "Longitude",
  max_depth: "Max depth",
  avg_depth: "Average depth",
  bottom_time_minutes: "Bottom time (min)",
  water_temp: "Water temperature — surface",
  water_temp_low: "Water temperature — lowest",
  air_temp: "Air temperature",
  visibility: "Visibility",
  gas_mix: "Gas mix",
  tank_info: "Cylinder/tank",
  cylinder_size: "Cylinder size (L)",
  start_pressure: "Start pressure (bar)",
  end_pressure: "End pressure (bar)",
  weight: "Weight",
  weight_feedback: "Weighting",
  suit_type: "Suit",
  hood: "Hood",
  gloves: "Gloves",
  boots: "Boots",
  buddy: "Buddy/guide",
  dive_shop: "Dive shop/operator",
  current: "Current",
  surge: "Surge",
  waves: "Waves",
  weather: "Weather",
  water_type: "Water type",
  body_of_water: "Body of water",
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
  // Explicit false (e.g. hood/gloves/boots not worn) is real information, not absence -- shown
  // as "No" rather than dropped, unlike the detail page's summary view which only lists what
  // was worn (a backup should stay complete).
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// Matches the app UI's own heading convention (detail/list/dashboard pages): a custom title wins
// when set, falling back to "site — date".
function diveTitle(dive) {
  if (dive?.title) return String(dive.title);

  const site = dive?.site_name ? String(dive.site_name) : null;
  const when = dive?.occurred_at ? String(dive.occurred_at) : null;
  if (site && when) return `${site} — ${when}`;
  return site ?? when ?? `dive #${dive?.id ?? "?"}`;
}

// dive_backup is the only notification type left -- each row renders its own complete email
// rather than a combinable section. The payload is `{ event: "create" | "edit" | "delete",
// dive: { ...flat column snapshot } }` — written by the dive server actions and serialised
// verbatim into the attachments.
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
