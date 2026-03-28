/**
 * POST /api/live-calls/end
 *
 * Redundant endpoint for marking a live call as ENDED.
 * Called by agent_call_status.js (Twilio Function) alongside the GAS webhook,
 * so if either GAS or this endpoint succeeds, the LIVE row gets updated.
 *
 * Body: { agent, conference_name, call_status, call_duration, timestamp }
 *
 * Only processes calls with call_status === "completed" (same logic as GAS).
 */

import { NextRequest, NextResponse } from "next/server";
import { endLiveCall, ensureSheetsReady } from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      agent,
      conference_name,
      call_status,
      call_duration,
      timestamp,
    } = body;

    if (!agent || !conference_name) {
      return NextResponse.json(
        { ok: false, error: "Missing agent or conference_name" },
        { status: 400 }
      );
    }

    if (call_status !== "completed") {
      return NextResponse.json({
        ok: true,
        action: "ignored",
        reason: `Non-completed status: ${call_status}`,
      });
    }

    await ensureSheetsReady();

    const updated = await endLiveCall({
      agent,
      conferenceName: conference_name,
      callDuration: call_duration || "0",
      timestamp: timestamp || new Date().toISOString(),
    });

    return NextResponse.json({ ok: true, updated });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[POST /api/live-calls/end] Error:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
