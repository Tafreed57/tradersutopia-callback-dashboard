/**
 * GET /api/live-calls
 * Query params: status (LIVE | ENDED | all, default: LIVE)
 * Returns current live/ended call entries from the "Live Calls" sheet.
 *
 * Detects NEW live calls and sends push notifications. Uses "Push Notified"
 * sheet to track which agent+conference we already notified (works across
 * serverless invocations). We AWAIT the push so it completes before response.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  getLiveCalls,
  ensureSheetsReady,
  getAllPushSubscriptions,
  removePushSubscription,
  getAlreadyNotifiedRecent,
  recordPushNotified,
  type LiveCall,
} from "@/lib/sheets";
import { withRetry } from "@/lib/retry";
import webpush from "web-push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VAPID_PUBLIC = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_EMAIL = process.env.VAPID_EMAIL || "mailto:admin@tradersutopia.com";

function callKey(c: LiveCall): string {
  return `${c.agentNumber}::${c.conferenceName}`;
}

async function sendPushForNewCalls(liveCalls: LiveCall[]): Promise<void> {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    console.log("[live-calls] Push skip: VAPID keys not set");
    return;
  }

  const alreadyNotified = await getAlreadyNotifiedRecent();
  const newCalls = liveCalls.filter((c) => !alreadyNotified.has(callKey(c)));
  if (newCalls.length === 0) return;

  const subs = await getAllPushSubscriptions();
  if (subs.length === 0) {
    console.log("[live-calls] Push skip: no subscriptions");
    return;
  }

  console.log(
    `[live-calls] Push: ${newCalls.length} new call(s), ${subs.length} subscriber(s)`
  );

  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);

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

    let sent = 0;
    await Promise.allSettled(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: { p256dh: sub.p256dh, auth: sub.auth },
            },
            payload
          );
          sent++;
        } catch (err: unknown) {
          const code =
            err && typeof err === "object" && "statusCode" in err
              ? (err as { statusCode: number }).statusCode
              : 0;
          if (code === 410 || code === 404) {
            await removePushSubscription(sub.endpoint).catch(() => {});
          }
          console.error("[live-calls] Push send failed for one sub:", code, err);
        }
      })
    );

    console.log(`[live-calls] Push sent for ${call.agentNumber}: ${sent}/${subs.length}`);
    await recordPushNotified(call.agentNumber, call.conferenceName);
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

    if (status === "LIVE" || status === "all") {
      const liveCalls = calls.filter((c) => c.status === "LIVE");
      await sendPushForNewCalls(liveCalls);
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
