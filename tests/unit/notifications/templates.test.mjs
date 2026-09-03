import { describe, expect, it } from "vitest";

import {
  renderBomUploadedSection,
  renderCombinedEmail,
  renderFirstCheckSection,
  renderNewUserSignupSection,
  renderStatusChangeSection,
  renderTosAcceptanceSection,
} from "../../../scripts/notifications/templates.mjs";

const BASE_URL = "https://dives.aleksandr.vin";

function firstCheckSection(filename = "parts.csv", bomFileId = "11") {
  return renderFirstCheckSection({
    filename,
    bomFileId,
    baseUrl: BASE_URL,
    items: [{ mpn: "MPN1", manufacturer: "Acme", tone: "active", label: "Active" }],
  });
}

function statusChangeSection(filename = "parts.csv", bomFileId = "11") {
  return renderStatusChangeSection({
    filename,
    bomFileId,
    baseUrl: BASE_URL,
    changes: [
      { mpn: "MPN1", manufacturer: "Acme", tone: "obsolete", label: "Obsolete", previousLabel: "Active" },
    ],
  });
}

function bomUploadedSection(filename = "parts.csv", bomFileId = "11") {
  return renderBomUploadedSection({
    filename,
    bomFileId,
    bomFileUrl: `${BASE_URL}/dashboard/bom/${bomFileId}`,
    itemCount: 3,
    manufacturerCounts: { Acme: 2, Beta: 1 },
  });
}

describe("renderCombinedEmail single-notification path", () => {
  it("reuses the first-check subject verbatim", () => {
    const email = renderCombinedEmail([firstCheckSection()]);
    expect(email.subject).toBe("Lifecycle check complete: parts.csv");
  });

  it("reuses the status-change subject verbatim", () => {
    const email = renderCombinedEmail([statusChangeSection()]);
    expect(email.subject).toBe("Lifecycle status changed: parts.csv");
  });

  it("reuses the bom-uploaded subject verbatim", () => {
    const email = renderCombinedEmail([bomUploadedSection()]);
    expect(email.subject).toBe("BOM uploaded: parts.csv");
  });
});

describe("renderCombinedEmail multi-notification path", () => {
  it("produces a summary subject with one section per distinct notification", () => {
    const email = renderCombinedEmail([
      bomUploadedSection(),
      firstCheckSection(),
      statusChangeSection(),
    ]);

    expect(email.subject).toBe("Dives: 3 updates");
    expect(email.html).toContain("BOM uploaded: parts.csv");
    expect(email.html).toContain("Lifecycle check complete: parts.csv");
    expect(email.html).toContain("Lifecycle status changed: parts.csv");
    // One shared sidenote footer, not one per section.
    expect(email.text.match(/delete the BOM file from the console/g)).toHaveLength(1);
  });
});

describe("renderCombinedEmail heading disambiguation (issue #109)", () => {
  it("tags colliding headings with their BOM file id when several files share a name", () => {
    const email = renderCombinedEmail([
      statusChangeSection("bill_of_materials 2.csv", "6"),
      statusChangeSection("bill_of_materials 2.csv", "7"),
      statusChangeSection("bill_of_materials 2.csv", "8"),
    ]);

    expect(email.subject).toBe("Dives: 3 updates");
    expect(email.html).toContain("Lifecycle status changed: bill_of_materials 2.csv (BOM file #6)");
    expect(email.html).toContain("Lifecycle status changed: bill_of_materials 2.csv (BOM file #7)");
    expect(email.html).toContain("Lifecycle status changed: bill_of_materials 2.csv (BOM file #8)");
    expect(email.text).toContain("bill_of_materials 2.csv (BOM file #6)");
    expect(email.text).toContain("bill_of_materials 2.csv (BOM file #7)");
    expect(email.text).toContain("bill_of_materials 2.csv (BOM file #8)");
  });

  it("leaves headings untouched when every section is for a distinct filename", () => {
    const email = renderCombinedEmail([
      bomUploadedSection("a.csv", "1"),
      firstCheckSection("b.csv", "2"),
      statusChangeSection("c.csv", "3"),
    ]);

    expect(email.html).not.toContain("BOM file #");
    expect(email.text).not.toContain("BOM file #");
  });

  it("leaves a single-section email's heading untouched even if a sectionId is present", () => {
    const email = renderCombinedEmail([statusChangeSection("bill_of_materials 2.csv", "6")]);

    expect(email.html).not.toContain("BOM file #");
    expect(email.subject).toBe("Lifecycle status changed: bill_of_materials 2.csv");
  });
});

describe("renderTosAcceptanceSection", () => {
  const tip = {
    seq: "3",
    recordHashHex: "deadbeef",
    acceptedAt: "2026-08-09T12:00:00.000Z",
    totalRowCount: "3",
  };

  it("includes seq, record hash, accepted_at and total row count", () => {
    const email = renderCombinedEmail([renderTosAcceptanceSection(tip)]);

    expect(email.subject).toBe("tos_acceptance anchor: seq 3");
    expect(email.text).toContain("seq: 3");
    expect(email.text).toContain("record_hash: deadbeef");
    expect(email.text).toContain("accepted_at: 2026-08-09T12:00:00.000Z");
    expect(email.text).toContain("total rows: 3");
  });

  it("carries no footer -- the BOM-file sidenote doesn't apply to an anchor email", () => {
    const email = renderCombinedEmail([renderTosAcceptanceSection(tip)]);

    expect(email.text).not.toContain("delete the BOM file");
    expect(email.html).not.toContain("delete the BOM file");
  });

  it("keeps the BOM-file sidenote when batched alongside a bom_uploaded section", () => {
    const email = renderCombinedEmail([renderTosAcceptanceSection(tip), bomUploadedSection()]);

    expect(email.text.match(/delete the BOM file from the console/g)).toHaveLength(1);
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

  it("carries no footer -- the BOM-file sidenote doesn't apply to a signup email", () => {
    const email = renderCombinedEmail([
      renderNewUserSignupSection({ email: "new-user@example.com", userNumber: 1 }),
    ]);

    expect(email.text).not.toContain("delete the BOM file");
    expect(email.html).not.toContain("delete the BOM file");
  });

  it("escapes the email in the rendered body", () => {
    const email = renderCombinedEmail([
      renderNewUserSignupSection({ email: "<script>bad</script>@example.com", userNumber: 1 }),
    ]);

    expect(email.html).toContain("&lt;script&gt;bad&lt;/script&gt;@example.com");
    expect(email.html).not.toContain("<script>bad</script>");
  });
});

describe("HTML escaping", () => {
  it("escapes the filename in the rendered body", () => {
    const section = renderFirstCheckSection({
      filename: "<script>bad</script>.csv",
      bomFileId: "11",
      baseUrl: BASE_URL,
      items: [{ mpn: "MPN1", manufacturer: "Acme", tone: "active", label: "Active" }],
    });
    const email = renderCombinedEmail([section]);

    expect(email.html).toContain("&lt;script&gt;bad&lt;/script&gt;.csv");
    expect(email.html).not.toContain("<script>bad</script>");
  });
});

describe("no per-part identifiers in email bodies", () => {
  it("first-check emails contain only aggregated status counts, never MPNs", () => {
    const items = [
      { mpn: "MPN1", manufacturer: "Acme", tone: "active", label: "Active" },
      { mpn: "MPN2", manufacturer: "Beta", tone: "active", label: "Active" },
      { mpn: "MPN3", manufacturer: "Gamma", tone: "obsolete", label: "Obsolete" },
    ];
    const section = renderFirstCheckSection({
      filename: "parts.csv",
      bomFileId: "11",
      baseUrl: BASE_URL,
      items,
    });
    const email = renderCombinedEmail([section]);

    for (const item of items) {
      expect(email.html).not.toContain(item.mpn);
      expect(email.html).not.toContain(item.manufacturer);
      expect(email.text).not.toContain(item.mpn);
      expect(email.text).not.toContain(item.manufacturer);
    }
    expect(email.html).toContain("2 &times;");
    expect(email.text).toContain("- 2 x Active");
    expect(email.text).toContain("- 1 x Obsolete");
  });

  it("status-change emails contain only aggregated transition counts, never MPNs", () => {
    const changes = [
      { mpn: "MPN1", manufacturer: "Acme", tone: "obsolete", label: "Obsolete", previousLabel: "Active" },
      { mpn: "MPN2", manufacturer: "Beta", tone: "obsolete", label: "Obsolete", previousLabel: "Active" },
      { mpn: "MPN3", manufacturer: "Gamma", tone: "nrnd", label: "NRND", previousLabel: "Active" },
    ];
    const section = renderStatusChangeSection({
      filename: "parts.csv",
      bomFileId: "11",
      baseUrl: BASE_URL,
      changes,
    });
    const email = renderCombinedEmail([section]);

    for (const change of changes) {
      expect(email.html).not.toContain(change.mpn);
      expect(email.html).not.toContain(change.manufacturer);
      expect(email.text).not.toContain(change.mpn);
      expect(email.text).not.toContain(change.manufacturer);
    }
    expect(email.text).toContain("- 2 part(s): Active -> Obsolete");
    expect(email.text).toContain("- 1 part(s): Active -> NRND");
  });
});
