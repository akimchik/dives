import { NextResponse } from "next/server";

import { BackupTooLargeError, buildDivesBackupZip } from "@/lib/backup/dives-zip";
import { logger } from "@/lib/logger";
import { getOptionalUser } from "@/lib/session";

// A route handler rather than a server action because the payload is binary: a server action would
// have to base64 the whole zip through the RSC stream. Deliberately getOptionalUser() + 401 rather
// than requireUser() -- requireUser redirects to the login page, and a fetch() download would follow
// that redirect and hand the client an HTML page named "*.zip".
export async function GET() {
  const user = await getOptionalUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  try {
    const zip = await buildDivesBackupZip(user.id);
    // Same colon-free sortable stamp as lib/padi/backup.ts's padi-backup-<timestamp>.json filename.
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

    // Buffer is runtime-compatible as a Response body (Node/undici accept it directly), but its
    // type is generic over ArrayBufferLike while lib.dom.d.ts's BodyInit wants the ArrayBuffer-backed
    // Uint8Array specifically -- a TS/@types/node typing gap, not a real mismatch. Cast rather than
    // copy the archive again just to satisfy it.
    return new Response(zip as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="dives-backup-${timestamp}.zip"`,
        "Content-Length": String(zip.byteLength),
        // Per-user data export: never store it in a shared or on-disk cache.
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    if (error instanceof BackupTooLargeError) {
      logger.warn({ err: error, userId: user.id }, "Dives backup zip exceeded the size cap");
      return NextResponse.json(
        { error: "Your backup is too large to generate right now — contact support." },
        { status: 413 },
      );
    }

    logger.error({ err: error, userId: user.id }, "Dives backup zip failed");
    return NextResponse.json({ error: "Could not create backup. Please try again later." }, { status: 500 });
  }
}
