/**
 * GET /api/live-calls
 * Query params: status (LIVE | ENDED | all, default: LIVE)
 * Returns current live/ended call entries from the "Live Calls" sheet.
 *
 * Also detects NEW live calls and fires push notifications automatically —
 * no external trigger needed. Uses in-memory set to track which
 * agent+conference combos have already been notified.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  getLiveCalls,
  ensureSheetsReady,
  getAllPushSubscriptions,
  removePushSubscription,
  type LiveCall,
} from "@/lib/sheets";
import { withRetry } from "@/lib/retry";
import webpush from "web-push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VAPID_PUBLIC = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_EMAIL = process.env.VAPID_EMAIL || "mailto:admin@tradersutopia.com";

// Track which calls we've already sent push for (survives across requests in same serverless instance)
const notifiedCalls = new Set<string>();

function callKey(c: LiveCall): string {
  return `${c.agentNumber}::${c.conferenceName}`;
}

async function sendPushForNewCalls(liveCalls: LiveCall[]) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;

  const newCalls = liveCalls.filter((c) => !notifiedCalls.has(callKey(c)));
  if (newCalls.length === 0) return;

  // Mark as notified immediately to prevent duplicate sends
  for (const c of newCalls) notifiedCalls.add(callKey(c));

  // Prune old entries (keep set from growing forever)
  if (notifiedCalls.size > 500) {
    const liveKeys = new Set(liveCalls.map(callKey));
    for (const key of notifiedCalls) {
      if (!liveKeys.has(key)) notifiedCalls.delete(key);
    }
  }

  try {
    webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);
    const subs = await getAllPushSubscriptions();
    if (subs.length === 0) return;

    for (const call of newCalls) {
      const ts = call.startTime ? new Date(call.startTime) : new Date();
      const timeStr = ts.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/Toronto",
      });

      const payload = JSON.stringify({
        title: "Inbound Call Taken",
        body: `Agent ${call.agentNumber} took a call at ${timeStr} ET`,
        url: "/dashboard",
        tag: "tu-call-" + call.conferenceName.slice(-8),
      });

      await Promise.allSettled(
        subs.map(async (sub) => {
          try {
            await webpush.sendNotification(
              { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
              payload
            );
          } catch (err: unknown) {
            const code = err && typeof err === "object" && "statusCode" in err
              ? (err as { statusCode: number }).statusCode : 0;
            if (code === 410 || code === 404) {
              await removePushSubscription(sub.endpoint).catch(() => {});
            }
          }
        })
      );
    }
  } catch (err) {
    console.error("[live-calls] Push send error (non-fatal):", err);
  }
}

export async function GET(req: NextRequest) {
  try {
    await ensureSheetsReady();

    const status = (req.nextUrl.searchParams.get("status") || "LIVE") as
      | "LIVE"
      | "ENDED"
      | "all";

    const calls = await withRetry(() => getLiveCalls({ status }));

    // Fire-and-forget: detect new LIVE calls and send push notifications
    if (status === "LIVE" || status === "all") {
      const liveCalls = calls.filter((c) => c.status === "LIVE");
      sendPushForNewCalls(liveCalls).catch(() => {});
    }

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
