/**
 * GET /api/live-calls
 * Query params: status (LIVE | ENDED | all, default: LIVE)
 * Returns current live/ended call entries from the "Live Calls" sheet.
 */

import { NextRequest, NextResponse } from "next/server";
import { getLiveCalls, ensureSheetsReady } from "@/lib/sheets";
import { withRetry } from "@/lib/retry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    await ensureSheetsReady();

    const status = (req.nextUrl.searchParams.get("status") || "LIVE") as
      | "LIVE"
      | "ENDED"
      | "all";

    const calls = await withRetry(() => getLiveCalls({ status }));
    return NextResponse.json(
      { ok: true, calls },
      { headers: { "Cache-Control": "no-store, no-cache, must-revalidate" } }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[GET /api/live-calls] Error:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
