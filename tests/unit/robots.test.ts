import { afterEach, describe, expect, it } from "vitest";

import robots from "@/app/robots";
import { isDevStage } from "@/lib/deployment-stage";

const STAGE_ENV = "OTEL_DEPLOYMENT_ENVIRONMENT";
const ORIGINAL_STAGE = process.env[STAGE_ENV];

afterEach(() => {
  if (ORIGINAL_STAGE === undefined) {
    delete process.env[STAGE_ENV];
  } else {
    process.env[STAGE_ENV] = ORIGINAL_STAGE;
  }
});

describe("isDevStage", () => {
  it("is true only when the stage env var is exactly 'dev'", () => {
    process.env[STAGE_ENV] = "dev";
    expect(isDevStage()).toBe(true);

    process.env[STAGE_ENV] = "prod";
    expect(isDevStage()).toBe(false);

    delete process.env[STAGE_ENV];
    expect(isDevStage()).toBe(false);
  });
});

describe("robots", () => {
  it("disallows all crawling on the dev stage", () => {
    process.env[STAGE_ENV] = "dev";

    expect(robots()).toEqual({
      rules: { userAgent: "*", disallow: "/" },
    });
  });

  it("allows crawling outside the dev stage", () => {
    delete process.env[STAGE_ENV];

    expect(robots()).toEqual({
      rules: { userAgent: "*", allow: "/" },
    });
  });
});
