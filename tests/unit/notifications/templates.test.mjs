import { describe, expect, it } from "vitest";

import {
  orderedDiveColumns,
  renderCombinedEmail,
  renderDiveBackupEmail,
  renderNewUserSignupSection,
} from "../../../scripts/notifications/templates.mjs";

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

describe("renderCombinedEmail single-notification path", () => {
  it("reuses the section's own subject verbatim", () => {
    const email = renderCombinedEmail([
      renderNewUserSignupSection({ email: "new-user@example.com", userNumber: 3 }),
    ]);

    expect(email.subject).toBe("New user signup: new-user@example.com");
    expect(email.html).not.toContain("<h2");
  });
});

describe("renderCombinedEmail multi-notification path", () => {
  it("produces a summary subject with one section per notification", () => {
    const email = renderCombinedEmail([
      renderNewUserSignupSection({ email: "first@example.com", userNumber: 1 }),
      renderNewUserSignupSection({ email: "second@example.com", userNumber: 2 }),
    ]);

    expect(email.subject).toBe("Dives: 2 updates");
    expect(email.html).toContain("New user signup: first@example.com");
    expect(email.html).toContain("New user signup: second@example.com");
    expect(email.text).toContain("This is user #1 (excluding test accounts).");
    expect(email.text).toContain("This is user #2 (excluding test accounts).");
  });
});

describe("renderNewUserSignupSection", () => {
  it("includes the email and running non-test user count", () => {
    const email = renderCombinedEmail([
      renderNewUserSignupSection({ email: "new-user@example.com", userNumber: 42 }),
    ]);

    expect(email.subject).toBe("New user signup: new-user@example.com");
    expect(email.text).toContain("New user signed up: new-user@example.com");
    expect(email.text).toContain("This is user #42 (excluding test accounts).");
  });

  it("escapes the email in the rendered body", () => {
    const email = renderCombinedEmail([
      renderNewUserSignupSection({ email: "<script>bad</script>@example.com", userNumber: 1 }),
    ]);

    expect(email.html).toContain("&lt;script&gt;bad&lt;/script&gt;@example.com");
    expect(email.html).not.toContain("<script>bad</script>");
  });
});

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
});
