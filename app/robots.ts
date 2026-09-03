import type { MetadataRoute } from "next";

import { isDevStage } from "@/lib/deployment-stage";

// The same container image is built once and deployed to every stage, so
// this must be evaluated per-request (not baked in at build time) to read
// the stage's runtime env var.
export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  if (isDevStage()) {
    return {
      rules: {
        userAgent: "*",
        disallow: "/",
      },
    };
  }

  return {
    rules: {
      userAgent: "*",
      allow: "/",
    },
  };
}
