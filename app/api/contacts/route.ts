import { NextRequest, NextResponse } from "next/server";
import { getAllContacts, upsertContact } from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/contacts — returns all saved contacts
 */
export async function GET() {
  try {
    const contacts = await getAllContacts();
    return NextResponse.json(
      { ok: true, contacts },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[GET /api/contacts] Error:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

/**
 * POST /api/contacts — create or update a contact
 * Body: { phone: "+14375053539", name: "John Smith", accessCode: "..." }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { phone, name, accessCode } = body;

    if (accessCode !== process.env.AFFILIATE_ACCESS_CODE) {
      return NextResponse.json(
        { ok: false, error: "Invalid access code" },
        { status: 401 }
      );
    }

    if (!phone || typeof name !== "string") {
      return NextResponse.json(
        { ok: false, error: "Missing phone or name" },
        { status: 400 }
      );
    }

    await upsertContact(phone, name.trim());
    return NextResponse.json({ ok: true, phone, name: name.trim() });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[POST /api/contacts] Error:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
