import { NextResponse } from "next/server";

import { getDatabaseDriverStatus } from "@/lib/db";
import {
  ensureHealthcheckPingerStarted,
  getHealthcheckPingStatus,
} from "@/lib/healthcheck-ping";

ensureHealthcheckPingerStarted();

export async function GET() {
  return NextResponse.json({
    status: "ok",
    database: getDatabaseDriverStatus(),
    healthcheckPing: getHealthcheckPingStatus(),
  });
}
