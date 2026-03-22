import { NextRequest, NextResponse } from "next/server";
import {
  getAgentAvailability,
  setAgentAvailability,
  getUnavailableAgents,
} from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/agent-availability
 * ?agent=+14375053539  → returns { available: true/false } for one agent
 * (no agent param)     → returns { unavailable: ["+14375053539"] } list of unavailable agents
 *
 * The second form is used by simulring_agents.js to filter agents before ringing.
 */
export async function GET(req: NextRequest) {
  try {
    const agent = req.nextUrl.searchParams.get("agent");

    if (agent) {
      const available = await getAgentAvailability(agent);
      return NextResponse.json(
        { ok: true, agent, available },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    const unavailableSet = await getUnavailableAgents();
    return NextResponse.json(
      { ok: true, unavailable: Array.from(unavailableSet) },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[GET /api/agent-availability] Error:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

/**
 * POST /api/agent-availability
 * Body: { agent: "+14375053539", available: true/false, accessCode: "..." }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { agent, available, accessCode } = body;

    if (accessCode !== process.env.AFFILIATE_ACCESS_CODE) {
      return NextResponse.json(
        { ok: false, error: "Invalid access code" },
        { status: 401 }
      );
    }

    if (!agent || typeof available !== "boolean") {
      return NextResponse.json(
        { ok: false, error: "Missing agent or available (boolean)" },
        { status: 400 }
      );
    }

    await setAgentAvailability(agent, available);
    return NextResponse.json({ ok: true, agent, available });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[POST /api/agent-availability] Error:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
