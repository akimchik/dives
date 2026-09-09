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

    // Buffer IS a Uint8Array and undici accepts it as a body directly, so it's passed through
    // uncopied. The cast covers a pure typing gap: @types/node types Buffer as
    // Buffer<ArrayBufferLike>, while lib.dom's BodyInit wants the ArrayBuffer-backed Uint8Array.
    // Re-wrapping (new Uint8Array(zip)) would silence it by copying the whole archive -- not worth
    // a megabytes-sized copy per download to avoid one cast.
    return new Response(zip as BodyInit, {
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
