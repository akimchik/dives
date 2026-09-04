import { afterEach, describe, expect, it } from "vitest";

import { orderedDiveColumns, renderDiveBackupEmail } from "../../../scripts/notifications/templates.mjs";

const BASE_URL_ENV = "NEXT_PUBLIC_BASE_URL";
const ORIGINAL_BASE_URL = process.env[BASE_URL_ENV];

afterEach(() => {
  if (ORIGINAL_BASE_URL === undefined) {
    delete process.env[BASE_URL_ENV];
  } else {
    process.env[BASE_URL_ENV] = ORIGINAL_BASE_URL;
  }
});

function dive(overrides = {}) {
  return {
    id: 12,
    occurred_at: "2026-08-09T07:30:00.000Z",
    site_name: "Blue Hole",
    site_location: "Dahab, Egypt",
    max_depth: "28.40",
    bottom_time_minutes: 44,
    gas_mix: "EAN32",
    notes: null,
    depth_profile: [{ t: 0, d: 0 }, { t: 60, d: 12 }],
    depth_profile_raw: "0,0\n60,12\n",
    ...overrides,
  };
}

describe("orderedDiveColumns", () => {
  // Postgres normalises jsonb key order, so the payload comes back out of the queue in an order
  // the server action never chose. Both the email body and the CSV attachment must not inherit it.
  it("is stable regardless of the payload's own key order", () => {
    const scrambled = { notes: "x", id: 1, gas_mix: "air", occurred_at: "2026-08-09T07:30:00.000Z" };
    const other = { occurred_at: "2026-08-09T07:30:00.000Z", gas_mix: "air", notes: "x", id: 1 };

    expect(orderedDiveColumns(scrambled)).toEqual(["id", "occurred_at", "gas_mix", "notes"]);
    expect(orderedDiveColumns(other)).toEqual(orderedDiveColumns(scrambled));
  });

  it("puts unknown columns last, alphabetically, so they are never dropped", () => {
    expect(orderedDiveColumns({ zeta: 1, id: 2, alpha: 3 })).toEqual(["id", "alpha", "zeta"]);
  });
});

describe("renderDiveBackupEmail", () => {
  it("names the event and the dive in the subject", () => {
    expect(renderDiveBackupEmail({ event: "create", dive: dive() }).subject).toBe(
      "Dive logged: Blue Hole — 2026-08-09T07:30:00.000Z",
    );
    expect(renderDiveBackupEmail({ event: "edit", dive: dive() }).subject).toBe(
      "Dive updated: Blue Hole — 2026-08-09T07:30:00.000Z",
    );
    expect(renderDiveBackupEmail({ event: "delete", dive: dive() }).subject).toBe(
      "Dive deleted: Blue Hole — 2026-08-09T07:30:00.000Z",
    );
  });

  it("falls back to the dive id when the snapshot has no site or date", () => {
    const email = renderDiveBackupEmail({ event: "delete", dive: { id: 9 } });
    expect(email.subject).toBe("Dive deleted: dive #9");
  });

  it("prefers a custom title over site — date, matching the app UI's own heading convention", () => {
    const email = renderDiveBackupEmail({
      event: "create",
      dive: dive({ title: "Night dive with the reef sharks" }),
    });
    expect(email.subject).toBe("Dive logged: Night dive with the reef sharks");
  });

  it("renders the dive's fields under human labels in both html and text", () => {
    const email = renderDiveBackupEmail({ event: "create", dive: dive() });

    expect(email.text).toContain("Dive site: Blue Hole");
    expect(email.text).toContain("Max depth: 28.40");
    expect(email.text).toContain("Bottom time (min): 44");
    expect(email.text).toContain("Gas mix: EAN32");
    expect(email.html).toContain("<strong>Dive site:</strong> Blue Hole");
  });

  it("omits empty fields and summarises the depth profile instead of inlining it", () => {
    const email = renderDiveBackupEmail({ event: "create", dive: dive() });

    expect(email.text).not.toContain("Notes:");
    expect(email.text).toContain("Depth profile: 2 sample(s) (see the attached JSON)");
    // The raw import text belongs in the attachment, not the body.
    expect(email.text).not.toContain("Depth profile raw");
  });

  it("renders an unknown column with a humanised label rather than dropping it", () => {
    const email = renderDiveBackupEmail({
      event: "edit",
      dive: dive({ deco_model: "Buhlmann ZHL-16C" }),
    });

    expect(email.text).toContain("Deco model: Buhlmann ZHL-16C");
  });

  it("escapes html in dive fields", () => {
    const email = renderDiveBackupEmail({
      event: "create",
      dive: dive({ buddy: "<script>bad</script>" }),
    });

    expect(email.html).toContain("&lt;script&gt;bad&lt;/script&gt;");
    expect(email.html).not.toContain("<script>bad</script>");
  });

  it("renders booleans as Yes/No, keeping explicit false (not worn) rather than dropping it", () => {
    const email = renderDiveBackupEmail({
      event: "create",
      dive: dive({ hood: true, gloves: false, boots: true }),
    });

    expect(email.text).toContain("Hood: Yes");
    expect(email.text).toContain("Gloves: No");
    expect(email.text).toContain("Boots: Yes");
  });

  it("renders the new profile/gear/conditions fields under their own human labels", () => {
    const email = renderDiveBackupEmail({
      event: "create",
      dive: dive({
        water_temp_low: "21.0",
        air_temp: "29.0",
        cylinder_size: "12",
        start_pressure: "200",
        end_pressure: "50",
        weight_feedback: "Perfect",
        waves: "Mild",
        water_type: "Salt",
        body_of_water: "Ocean",
      }),
    });

    expect(email.text).toContain("Water temperature — lowest: 21.0");
    expect(email.text).toContain("Air temperature: 29.0");
    expect(email.text).toContain("Cylinder size (L): 12");
    expect(email.text).toContain("Start pressure (bar): 200");
    expect(email.text).toContain("End pressure (bar): 50");
    expect(email.text).toContain("Weighting: Perfect");
    expect(email.text).toContain("Waves: Mild");
    expect(email.text).toContain("Water type: Salt");
    expect(email.text).toContain("Body of water: Ocean");
  });

  it("links to the dive on create/edit, trimming a trailing slash off the base URL", () => {
    process.env[BASE_URL_ENV] = "https://dives.aleksandr.vin/";

    const created = renderDiveBackupEmail({ event: "create", dive: dive({ id: 42 }) });
    expect(created.text).toContain("View this dive: https://dives.aleksandr.vin/dives/42");
    expect(created.html).toContain('<a href="https://dives.aleksandr.vin/dives/42">View this dive</a>');

    const edited = renderDiveBackupEmail({ event: "edit", dive: dive({ id: 42 }) });
    expect(edited.text).toContain("View this dive: https://dives.aleksandr.vin/dives/42");
  });

  it("omits the link entirely on delete -- the route 404s, nothing to link to", () => {
    process.env[BASE_URL_ENV] = "https://dives.aleksandr.vin";

    const email = renderDiveBackupEmail({ event: "delete", dive: dive({ id: 42 }) });
    expect(email.text).not.toContain("View this dive");
    expect(email.html).not.toContain("<a href");
  });

  it("omits the link when NEXT_PUBLIC_BASE_URL is unset rather than emailing a broken URL", () => {
    delete process.env[BASE_URL_ENV];

    const email = renderDiveBackupEmail({ event: "create", dive: dive({ id: 42 }) });
    expect(email.text).not.toContain("View this dive");
    expect(email.html).not.toContain("<a href");
  });
});
