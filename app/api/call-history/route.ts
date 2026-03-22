import { NextRequest, NextResponse } from "next/server";
import { getCallHistory } from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/call-history
 * Query params:
 *   direction  — "inbound" | "outbound" | "all" (default: "all")
 *   status     — "completed" | "active" | "failed" | "all" (default: "all")
 *   limit      — max results per page (default: 50)
 *   offset     — pagination offset (default: 0)
 */
export async function GET(req: NextRequest) {
  try {
    const direction = (req.nextUrl.searchParams.get("direction") || "all") as
      | "inbound"
      | "outbound"
      | "all";
    const status = req.nextUrl.searchParams.get("status") || "all";
    const limit = parseInt(req.nextUrl.searchParams.get("limit") || "50", 10);
    const offset = parseInt(req.nextUrl.searchParams.get("offset") || "0", 10);

    const { entries, total } = await getCallHistory({ direction, status, limit, offset });

    return NextResponse.json(
      { ok: true, entries, total, count: entries.length },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[GET /api/call-history] Error:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
