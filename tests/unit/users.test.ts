import { describe, expect, it } from "vitest";

import { isTestUserEmail } from "@/lib/users";

// isTestUserEmail gates both the new_user_signup admin notification and its running count
// (issue #102) -- see lib/users.ts and lib/user-signup-notification.ts.
describe("isTestUserEmail", () => {
  it("matches the test*@aleksandr.vin convention, case-insensitively", () => {
    expect(isTestUserEmail("test.qa@aleksandr.vin")).toBe(true);
    expect(isTestUserEmail("TEST.QA@ALEKSANDR.VIN")).toBe(true);
    expect(isTestUserEmail("test.foo-bar@aleksandr.vin")).toBe(true);
    expect(isTestUserEmail("testqa@aleksandr.vin")).toBe(true);
    expect(isTestUserEmail("test@aleksandr.vin")).toBe(true);
  });

  it("does not match real users on the same domains", () => {
    expect(isTestUserEmail("kilo@aleksandr.vin")).toBe(false);
    expect(isTestUserEmail("someone@aleksandr.vin")).toBe(false);
  });

  it("does not match an address that merely contains 'test' but doesn't start with it", () => {
    expect(isTestUserEmail("nottest@aleksandr.vin")).toBe(false);
    expect(isTestUserEmail("attester@aleksandr.vin")).toBe(false);
  });

  it("does not match other domains even with a test prefix", () => {
    expect(isTestUserEmail("test.qa@example.com")).toBe(false);
    expect(isTestUserEmail("test@example.com")).toBe(false);
  });

  it("does not match a subdomain-style address", () => {
    expect(isTestUserEmail("test.qa@sub.aleksandr.vin")).toBe(false);
  });
});
