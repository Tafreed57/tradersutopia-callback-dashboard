/**
 * lib/sheets.ts
 * Google Sheets as a hidden backend database.
 * All reads/writes happen server-side only via Service Account.
 */

import { google, sheets_v4 } from "googleapis";

// ── Auth ──────────────────────────────────────────────────────────────────────
function getAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON env var");

  const creds = JSON.parse(raw);
  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

function getSheets(): sheets_v4.Sheets {
  return google.sheets({ version: "v4", auth: getAuth() });
}

const SHEET_ID = () => {
  const id = process.env.GOOGLE_SHEET_ID;
  if (!id) throw new Error("Missing GOOGLE_SHEET_ID env var");
  return id;
};

const CALLBACKS_TAB = () =>
  process.env.GOOGLE_SHEET_CALLBACKS_TAB || "Callbacks";
const LOGS_TAB = () => process.env.GOOGLE_SHEET_LOGS_TAB || "CallLogs";
const LIVE_CALLS_TAB = () =>
  process.env.GOOGLE_SHEET_LIVE_CALLS_TAB || "Live Calls";
const PUSH_SUBS_TAB = () =>
  process.env.GOOGLE_SHEET_PUSH_SUBS_TAB || "Push Subscriptions";
const PUSH_NOTIFIED_TAB = () =>
  process.env.GOOGLE_SHEET_PUSH_NOTIFIED_TAB || "Push Notified";
const AVAILABILITY_TAB = () =>
  process.env.GOOGLE_SHEET_AVAILABILITY_TAB || "Agent Availability";
const CONTACTS_TAB = () =>
  process.env.GOOGLE_SHEET_CONTACTS_TAB || "Contacts";

// "Callback Queue" tab uses different columns; we map them to our Lead shape
const IS_QUEUE_LAYOUT = () =>
  CALLBACKS_TAB().toLowerCase().replace(/\s+/g, "") === "callbackqueue";

// ── Headers ───────────────────────────────────────────────────────────────────
const CALLBACK_HEADERS = [
  "id",
  "createdAt",
  "name",
  "phone",
  "reason",
  "status",
  "calledAt",
  "calledBy",
  "notes",
  "lastUpdatedAt",
];

// Callback Queue columns: A=created_at, B=caller, C=tag, D=status, E=assigned_to, F=notes, G=call_sid, H=called_number, I=digits
function queueRowToLead(row: string[], rowIndex: number): Lead {
  const caller = (row[1] || "").trim();
  const phone = caller ? (caller.startsWith("+") ? caller : `+${caller}`) : "";
  const status = (row[3] || "").trim().toUpperCase() === "NEW" ? "pending" : (row[3] || "pending").toLowerCase();
  return {
    id: (row[6] || `row-${rowIndex}`).trim() || `row-${rowIndex}`,
    createdAt: row[0] || "",
    name: row[2] ? `Lead (${row[2]})` : "Lead",
    phone,
    reason: row[2] || "",
    status,
    calledAt: "",
    calledBy: row[4] || "",
    notes: row[5] || "",
    lastUpdatedAt: row[0] || "",
    _rowIndex: rowIndex,
  };
}

function leadToQueueRow(lead: Lead): string[] {
  const status = lead.status === "pending" ? "NEW" : lead.status;
  return [
    lead.createdAt,
    lead.phone.replace(/^\+/, ""),
    lead.reason,
    status,
    lead.calledBy,
    lead.notes,
    lead.id,
    "", // called_number
    "", // digits
  ];
}

const LOG_HEADERS = [
  "logId",
  "timestamp",
  "leadId",
  "action",
  "affiliatePhone",
  "details",
  "twilioCallSid",
];

// ── Ensure headers exist (cached — only runs once per server lifecycle) ───────
let _sheetsReady = false;

export async function ensureSheetsReady() {
  if (_sheetsReady) return;
  const sheets = getSheets();
  const spreadsheetId = SHEET_ID();

  // Get existing sheet tab names
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existingTabs = (meta.data.sheets || []).map(
    (s) => s.properties?.title
  );

  // Create tabs if missing
  const requests: sheets_v4.Schema$Request[] = [];
  if (!existingTabs.includes(CALLBACKS_TAB())) {
    requests.push({
      addSheet: { properties: { title: CALLBACKS_TAB() } },
    });
  }
  if (!existingTabs.includes(LOGS_TAB())) {
    requests.push({
      addSheet: { properties: { title: LOGS_TAB() } },
    });
  }
  if (requests.length > 0) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  }

  // Ensure Callbacks headers (skip if using "Callback Queue" — we don't overwrite their headers)
  if (!IS_QUEUE_LAYOUT()) {
    await ensureHeaders(sheets, spreadsheetId, CALLBACKS_TAB(), CALLBACK_HEADERS);
  }
  // Ensure Logs headers
  await ensureHeaders(sheets, spreadsheetId, LOGS_TAB(), LOG_HEADERS);
  _sheetsReady = true;
}

async function ensureHeaders(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  tab: string,
  headers: string[]
) {
  const range = `${tab}!A1:${colLetter(headers.length)}1`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const row = res.data.values?.[0];

  if (!row || row[0] !== headers[0]) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: "RAW",
      requestBody: { values: [headers] },
    });
    console.log(`[sheets] Wrote headers to ${tab}`);
  }
}

function colLetter(n: number): string {
  // 1→A, 2→B, ..., 10→J, 26→Z
  let s = "";
  while (n > 0) {
    n--;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

// ── Row <-> Object helpers ────────────────────────────────────────────────────
export interface Lead {
  id: string;
  createdAt: string;
  name: string;
  phone: string;
  reason: string;
  status: string;
  calledAt: string;
  calledBy: string;
  notes: string;
  lastUpdatedAt: string;
  _rowIndex?: number; // 1-based sheet row (header=1, first data=2)
}

function rowToLead(row: string[], rowIndex: number): Lead {
  return {
    id: row[0] || "",
    createdAt: row[1] || "",
    name: row[2] || "",
    phone: row[3] || "",
    reason: row[4] || "",
    status: row[5] || "pending",
    calledAt: row[6] || "",
    calledBy: row[7] || "",
    notes: row[8] || "",
    lastUpdatedAt: row[9] || "",
    _rowIndex: rowIndex,
  };
}

function leadToRow(lead: Lead): string[] {
  return [
    lead.id,
    lead.createdAt,
    lead.name,
    lead.phone,
    lead.reason,
    lead.status,
    lead.calledAt,
    lead.calledBy,
    lead.notes,
    lead.lastUpdatedAt,
  ];
}

// ── Read leads ────────────────────────────────────────────────────────────────
export async function getLeads(opts?: {
  status?: string;
  q?: string;
  sort?: string;
  order?: string;
}): Promise<Omit<Lead, "_rowIndex">[]> {
  const sheets = getSheets();
  const spreadsheetId = SHEET_ID();
  const tab = CALLBACKS_TAB();
  const useQueue = IS_QUEUE_LAYOUT();

  const range = useQueue ? `${tab}!A2:I` : `${tab}!A2:J`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });

  const rows = res.data.values || [];
  let leads: Lead[] = useQueue
    ? rows.map((row, i) => queueRowToLead(row, i + 2)).filter((l) => l.phone || l.id)
    : rows.map((row, i) => rowToLead(row, i + 2));

  // Filter by status
  if (opts?.status && opts.status !== "all") {
    leads = leads.filter((l) => l.status === opts.status);
  }

  // Search by name or phone
  if (opts?.q) {
    const q = opts.q.toLowerCase();
    leads = leads.filter(
      (l) =>
        l.name.toLowerCase().includes(q) ||
        l.phone.includes(q)
    );
  }

  // Sort
  const sortField = opts?.sort || "createdAt";
  const order = opts?.order || "desc";
  leads.sort((a, b) => {
    const aVal = String((a as unknown as Record<string, string>)[sortField] || "");
    const bVal = String((b as unknown as Record<string, string>)[sortField] || "");
    const cmp = aVal.localeCompare(bVal);
    return order === "asc" ? cmp : -cmp;
  });

  // Strip internal _rowIndex
  return leads.map(({ _rowIndex, ...rest }) => rest);
}

// ── Get single lead by id ─────────────────────────────────────────────────────
export async function getLeadById(
  id: string
): Promise<Lead | null> {
  const sheets = getSheets();
  const spreadsheetId = SHEET_ID();
  const tab = CALLBACKS_TAB();
  const useQueue = IS_QUEUE_LAYOUT();

  const range = useQueue ? `${tab}!A2:I` : `${tab}!A2:J`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });

  const rows = res.data.values || [];

  // For queue layout, IDs like "row-N" are synthetic (column G was empty).
  // We match by row index directly in that case.
  const isRowId = useQueue && id.startsWith("row-");
  const targetRowIndex = isRowId ? parseInt(id.replace("row-", ""), 10) : -1;

  for (let i = 0; i < rows.length; i++) {
    const sheetRow = i + 2; // header is row 1, data starts at row 2
    if (isRowId) {
      if (sheetRow === targetRowIndex) {
        return queueRowToLead(rows[i], sheetRow);
      }
    } else {
      const idCol = useQueue ? 6 : 0;
      if ((rows[i][idCol] || "").trim() === id) {
        return useQueue ? queueRowToLead(rows[i], sheetRow) : rowToLead(rows[i], sheetRow);
      }
    }
  }
  return null;
}

// ── Update a lead ─────────────────────────────────────────────────────────────
export async function updateLead(
  id: string,
  patch: Partial<Pick<Lead, "status" | "notes" | "calledAt" | "calledBy">>
): Promise<Lead | null> {
  const lead = await getLeadById(id);
  if (!lead || !lead._rowIndex) return null;

  // Apply patch to the in-memory lead object
  if (patch.status !== undefined) lead.status = patch.status;
  if (patch.notes !== undefined) lead.notes = patch.notes;
  if (patch.calledAt !== undefined) lead.calledAt = patch.calledAt;
  if (patch.calledBy !== undefined) lead.calledBy = patch.calledBy;
  lead.lastUpdatedAt = new Date().toISOString();

  const sheets = getSheets();
  const spreadsheetId = SHEET_ID();
  const tab = CALLBACKS_TAB();
  const rowNum = lead._rowIndex;
  const useQueue = IS_QUEUE_LAYOUT();

  if (useQueue) {
    // Queue layout: only update specific cells to avoid destroying existing data
    // Column mapping: A=created_at, B=caller, C=tag, D=status, E=assigned_to, F=notes
    const cellUpdates: { range: string; values: string[][] }[] = [];

    if (patch.status !== undefined) {
      const sheetStatus = lead.status === "pending" ? "NEW" : lead.status;
      cellUpdates.push({
        range: `${tab}!D${rowNum}`,
        values: [[sheetStatus]],
      });
    }
    if (patch.notes !== undefined) {
      cellUpdates.push({
        range: `${tab}!F${rowNum}`,
        values: [[lead.notes]],
      });
    }
    if (patch.calledBy !== undefined) {
      cellUpdates.push({
        range: `${tab}!E${rowNum}`,
        values: [[lead.calledBy]],
      });
    }

    if (cellUpdates.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: "RAW",
          data: cellUpdates.map((u) => ({
            range: u.range,
            values: u.values,
          })),
        },
      });
    }
  } else {
    // Standard layout: write the full row
    const range = `${tab}!A${rowNum}:J${rowNum}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: "RAW",
      requestBody: { values: [leadToRow(lead)] },
    });
  }

  console.log(`[sheets] Updated row ${rowNum} for lead ${id}: status=${lead.status}`);
  return lead;
}

// ── Live Calls ────────────────────────────────────────────────────────────────

export interface LiveCall {
  agentNumber: string;
  conferenceName: string;
  callerNumber: string;
  startTime: string;
  status: string;      // "LIVE" or "ENDED"
  callDuration: string;
  endTime: string;
}

const LIVE_CALLS_HEADERS = [
  "Agent Number",
  "Conference Name",
  "Caller Number",
  "Start Time",
  "Status",
  "Call Duration",
  "End Time",
];

async function ensureLiveCallsSheet() {
  const sheets = getSheets();
  const spreadsheetId = SHEET_ID();
  const tab = LIVE_CALLS_TAB();

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existingTabs = (meta.data.sheets || []).map(
    (s) => s.properties?.title
  );

  if (!existingTabs.includes(tab)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: tab } } }],
      },
    });
    await ensureHeaders(sheets, spreadsheetId, tab, LIVE_CALLS_HEADERS);
  }
}

const STALE_CALL_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours
let _lastStaleCleanup = 0;
const STALE_CLEANUP_INTERVAL_MS = 60 * 1000; // rate-limit cleanup to once per minute

export async function getLiveCalls(opts?: {
  status?: "LIVE" | "ENDED" | "all";
}): Promise<LiveCall[]> {
  const sheets = getSheets();
  const spreadsheetId = SHEET_ID();
  const tab = LIVE_CALLS_TAB();

  await ensureLiveCallsSheet();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tab}!A2:G`,
  });

  const rows = res.data.values || [];

  // Auto-expire stale LIVE calls (rate-limited)
  const now = Date.now();
  if (now - _lastStaleCleanup > STALE_CLEANUP_INTERVAL_MS) {
    _lastStaleCleanup = now;
    const staleUpdates: { range: string; values: string[][] }[] = [];

    for (let i = 0; i < rows.length; i++) {
      const status = (rows[i][4] || "").trim();
      if (status !== "LIVE") continue;

      const startTime = rows[i][3] || "";
      const start = new Date(startTime).getTime();
      if (isNaN(start)) continue;

      if (now - start > STALE_CALL_THRESHOLD_MS) {
        const rowNum = i + 2;
        staleUpdates.push(
          { range: `${tab}!E${rowNum}`, values: [["ENDED"]] },
          { range: `${tab}!F${rowNum}`, values: [["auto-expired"]] },
          { range: `${tab}!G${rowNum}`, values: [[new Date().toISOString()]] }
        );
        rows[i][4] = "ENDED";
        rows[i][5] = "auto-expired";
        rows[i][6] = new Date().toISOString();
      }
    }

    if (staleUpdates.length > 0) {
      try {
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId,
          requestBody: {
            valueInputOption: "RAW",
            data: staleUpdates,
          },
        });
        console.log(
          `[sheets] Auto-expired ${staleUpdates.length / 3} stale LIVE calls (threshold: ${STALE_CALL_THRESHOLD_MS / 3600000}h)`
        );
      } catch (cleanupErr) {
        console.error("[sheets] Stale cleanup write failed:", cleanupErr);
      }
    }
  }

  let calls: LiveCall[] = rows.map((row) => ({
    agentNumber: row[0] || "",
    conferenceName: row[1] || "",
    callerNumber: row[2] || "",
    startTime: row[3] || "",
    status: row[4] || "",
    callDuration: row[5] || "",
    endTime: row[6] || "",
  }));

  const filter = opts?.status || "all";
  if (filter !== "all") {
    calls = calls.filter((c) => c.status === filter);
  }

  return calls;
}

/**
 * Mark a specific live call as ENDED. Idempotent — safe to call multiple times.
 * Used by the /api/live-calls/end endpoint as a redundant backup to GAS.
 */
export async function endLiveCall(opts: {
  agent: string;
  conferenceName: string;
  callDuration?: string;
  timestamp?: string;
}): Promise<boolean> {
  const sheets = getSheets();
  const spreadsheetId = SHEET_ID();
  const tab = LIVE_CALLS_TAB();

  await ensureLiveCallsSheet();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tab}!A2:G`,
  });

  const rows = res.data.values || [];
  const normalize = (n: string) => n.trim().replace(/^\+/, "");
  const incomingAgent = normalize(opts.agent);

  for (let i = rows.length - 1; i >= 0; i--) {
    const rowAgent = normalize(rows[i][0] || "");
    const rowConference = (rows[i][1] || "").trim();
    const rowStatus = (rows[i][4] || "").trim();

    if (
      rowAgent === incomingAgent &&
      rowConference === opts.conferenceName &&
      rowStatus === "LIVE"
    ) {
      const rowNum = i + 2;
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: "RAW",
          data: [
            { range: `${tab}!E${rowNum}`, values: [["ENDED"]] },
            {
              range: `${tab}!F${rowNum}`,
              values: [[opts.callDuration || ""]],
            },
            {
              range: `${tab}!G${rowNum}`,
              values: [[opts.timestamp || new Date().toISOString()]],
            },
          ],
        },
      });
      console.log(
        `[sheets] Marked row ${rowNum} as ENDED for agent ${opts.agent} on ${opts.conferenceName}`
      );
      return true;
    }
  }

  console.log(
    `[sheets] No LIVE row found for agent ${opts.agent} on ${opts.conferenceName} (already ended or no-op)`
  );
  return false;
}

// ── Push Subscriptions ────────────────────────────────────────────────────────

export interface PushSub {
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAt: string;
}

const PUSH_SUBS_HEADERS = ["endpoint", "p256dh", "auth", "createdAt"];

async function ensurePushSubsSheet() {
  const sheets = getSheets();
  const spreadsheetId = SHEET_ID();
  const tab = PUSH_SUBS_TAB();

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existingTabs = (meta.data.sheets || []).map(
    (s) => s.properties?.title
  );

  if (!existingTabs.includes(tab)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: tab } } }],
      },
    });
    await ensureHeaders(sheets, spreadsheetId, tab, PUSH_SUBS_HEADERS);
  }
}

export async function savePushSubscription(sub: {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}): Promise<void> {
  const sheets = getSheets();
  const spreadsheetId = SHEET_ID();
  const tab = PUSH_SUBS_TAB();

  await ensurePushSubsSheet();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tab}!A2:A`,
  });
  const rows = res.data.values || [];

  // Deduplicate by endpoint
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === sub.endpoint) return;
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tab}!A:D`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[sub.endpoint, sub.keys.p256dh, sub.keys.auth, new Date().toISOString()]],
    },
  });
}

export async function removePushSubscription(endpoint: string): Promise<void> {
  const sheets = getSheets();
  const spreadsheetId = SHEET_ID();
  const tab = PUSH_SUBS_TAB();

  await ensurePushSubsSheet();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tab}!A2:D`,
  });
  const rows = res.data.values || [];

  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i][0] === endpoint) {
      // Rows are 1-indexed, header is row 1, data starts at row 2
      const meta = await sheets.spreadsheets.get({ spreadsheetId });
      const sheetObj = (meta.data.sheets || []).find(
        (s) => s.properties?.title === tab
      );
      if (sheetObj?.properties?.sheetId !== undefined) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [
              {
                deleteDimension: {
                  range: {
                    sheetId: sheetObj.properties.sheetId,
                    dimension: "ROWS",
                    startIndex: i + 1, // 0-indexed, +1 for header
                    endIndex: i + 2,
                  },
                },
              },
            ],
          },
        });
      }
      return;
    }
  }
}

export async function getAllPushSubscriptions(): Promise<PushSub[]> {
  const sheets = getSheets();
  const spreadsheetId = SHEET_ID();
  const tab = PUSH_SUBS_TAB();

  await ensurePushSubsSheet();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tab}!A2:D`,
  });

  return (res.data.values || []).map((row) => ({
    endpoint: row[0] || "",
    p256dh: row[1] || "",
    auth: row[2] || "",
    createdAt: row[3] || "",
  }));
}

// ── Push Notified (track which live calls we already sent push for) ───────────

const PUSH_NOTIFIED_HEADERS = ["agent_number", "conference_name", "notified_at"];
const NOTIFIED_WINDOW_MS = 2 * 60 * 1000; // 2 minutes

async function ensurePushNotifiedSheet() {
  const sheets = getSheets();
  const spreadsheetId = SHEET_ID();
  const tab = PUSH_NOTIFIED_TAB();

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existingTabs = (meta.data.sheets || []).map(
    (s) => s.properties?.title
  );

  if (!existingTabs.includes(tab)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: tab } } }],
      },
    });
    await ensureHeaders(sheets, spreadsheetId, tab, PUSH_NOTIFIED_HEADERS);
  }
}

/** Returns set of "agentNumber::conferenceName" that were notified in the last NOTIFIED_WINDOW_MS */
export async function getAlreadyNotifiedRecent(): Promise<Set<string>> {
  const sheets = getSheets();
  const spreadsheetId = SHEET_ID();
  const tab = PUSH_NOTIFIED_TAB();

  await ensurePushNotifiedSheet();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tab}!A2:C`,
  });

  const rows = res.data.values || [];
  const since = Date.now() - NOTIFIED_WINDOW_MS;
  const set = new Set<string>();

  for (const row of rows) {
    const notifiedAt = row[2] ? new Date(row[2]).getTime() : 0;
    if (notifiedAt >= since) {
      set.add(`${(row[0] || "").trim()}::${(row[1] || "").trim()}`);
    }
  }
  return set;
}

export async function recordPushNotified(
  agentNumber: string,
  conferenceName: string
): Promise<void> {
  const sheets = getSheets();
  const spreadsheetId = SHEET_ID();
  const tab = PUSH_NOTIFIED_TAB();

  await ensurePushNotifiedSheet();

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tab}!A:C`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[agentNumber, conferenceName, new Date().toISOString()]],
    },
  });
}

// ── Agent Availability ────────────────────────────────────────────────────────

const AVAILABILITY_HEADERS = ["agent_number", "available", "updated_at"];

async function ensureAvailabilitySheet() {
  const sheets = getSheets();
  const spreadsheetId = SHEET_ID();
  const tab = AVAILABILITY_TAB();

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existingTabs = (meta.data.sheets || []).map(
    (s) => s.properties?.title
  );

  if (!existingTabs.includes(tab)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: tab } } }],
      },
    });
    await ensureHeaders(sheets, spreadsheetId, tab, AVAILABILITY_HEADERS);
  }
}

export async function getAgentAvailability(
  agentNumber: string
): Promise<boolean> {
  const sheets = getSheets();
  const spreadsheetId = SHEET_ID();
  const tab = AVAILABILITY_TAB();

  await ensureAvailabilitySheet();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tab}!A2:B`,
  });
  const rows = res.data.values || [];
  const normalize = (n: string) => n.replace(/[^0-9]/g, "");
  const target = normalize(agentNumber);

  for (const row of rows) {
    if (normalize(row[0] || "") === target) {
      return (row[1] || "").toUpperCase() !== "FALSE";
    }
  }
  return true; // default: available
}

export async function setAgentAvailability(
  agentNumber: string,
  available: boolean
): Promise<void> {
  const sheets = getSheets();
  const spreadsheetId = SHEET_ID();
  const tab = AVAILABILITY_TAB();

  await ensureAvailabilitySheet();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tab}!A2:C`,
  });
  const rows = res.data.values || [];
  const normalize = (n: string) => n.replace(/[^0-9]/g, "");
  const target = normalize(agentNumber);

  for (let i = 0; i < rows.length; i++) {
    if (normalize(rows[i][0] || "") === target) {
      const rowNum = i + 2;
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${tab}!B${rowNum}:C${rowNum}`,
        valueInputOption: "RAW",
        requestBody: {
          values: [[String(available).toUpperCase(), new Date().toISOString()]],
        },
      });
      return;
    }
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tab}!A:C`,
    valueInputOption: "RAW",
    requestBody: {
      values: [
        [agentNumber, String(available).toUpperCase(), new Date().toISOString()],
      ],
    },
  });
}

/**
 * Returns the set of agent numbers explicitly marked unavailable.
 * Agents NOT in this set are considered available (default-available design).
 */
export async function getUnavailableAgents(): Promise<Set<string>> {
  const sheets = getSheets();
  const spreadsheetId = SHEET_ID();
  const tab = AVAILABILITY_TAB();

  await ensureAvailabilitySheet();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tab}!A2:B`,
  });
  const rows = res.data.values || [];
  const unavailable = new Set<string>();

  for (const row of rows) {
    if ((row[1] || "").toUpperCase() === "FALSE") {
      unavailable.add((row[0] || "").replace(/[^0-9]/g, ""));
    }
  }

  return unavailable;
}

// ── Contacts ──────────────────────────────────────────────────────────────────

const CONTACTS_HEADERS = ["phone", "name", "updated_at"];

async function ensureContactsSheet() {
  const sheets = getSheets();
  const spreadsheetId = SHEET_ID();
  const tab = CONTACTS_TAB();

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existingTabs = (meta.data.sheets || []).map(
    (s) => s.properties?.title
  );

  if (!existingTabs.includes(tab)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: tab } } }],
      },
    });
    await ensureHeaders(sheets, spreadsheetId, tab, CONTACTS_HEADERS);
  }
}

export interface Contact {
  phone: string;
  name: string;
  updatedAt: string;
}

export async function getAllContacts(): Promise<Contact[]> {
  const sheets = getSheets();
  const spreadsheetId = SHEET_ID();
  const tab = CONTACTS_TAB();

  await ensureContactsSheet();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tab}!A2:C`,
  });

  return (res.data.values || []).map((row) => ({
    phone: row[0] || "",
    name: row[1] || "",
    updatedAt: row[2] || "",
  }));
}

export async function upsertContact(
  phone: string,
  name: string
): Promise<void> {
  const sheets = getSheets();
  const spreadsheetId = SHEET_ID();
  const tab = CONTACTS_TAB();

  await ensureContactsSheet();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tab}!A2:C`,
  });
  const rows = res.data.values || [];
  const normalize = (n: string) => n.replace(/[^0-9]/g, "");
  const target = normalize(phone);

  for (let i = 0; i < rows.length; i++) {
    if (normalize(rows[i][0] || "") === target) {
      const rowNum = i + 2;
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${tab}!B${rowNum}:C${rowNum}`,
        valueInputOption: "RAW",
        requestBody: {
          values: [[name, new Date().toISOString()]],
        },
      });
      return;
    }
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tab}!A:C`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[phone, name, new Date().toISOString()]],
    },
  });
}

// ── Call History (unified view) ───────────────────────────────────────────────

export interface CallHistoryEntry {
  timestamp: string;
  direction: "inbound" | "outbound";
  agentNumber: string;
  callerNumber: string;
  status: string;
  duration: string;
  conferenceName: string;
  details: string;
}

export async function getCallHistory(opts?: {
  direction?: "inbound" | "outbound" | "all";
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<{ entries: CallHistoryEntry[]; total: number }> {
  const sheets = getSheets();
  const spreadsheetId = SHEET_ID();
  const entries: CallHistoryEntry[] = [];

  // Inbound calls from Live Calls tab
  if (opts?.direction !== "outbound") {
    try {
      await ensureLiveCallsSheet();
      const lcRes = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${LIVE_CALLS_TAB()}!A2:G`,
      });
      for (const row of lcRes.data.values || []) {
        const rawStatus = (row[4] || "").toUpperCase();
        entries.push({
          timestamp: row[3] || row[6] || "",
          direction: "inbound",
          agentNumber: row[0] || "",
          callerNumber: row[2] || "",
          status: rawStatus === "LIVE" ? "active" : "completed",
          duration: row[5] || "",
          conferenceName: row[1] || "",
          details: "",
        });
      }
    } catch {
      // Live Calls tab may not exist yet
    }
  }

  // Outbound calls from CallLogs tab
  if (opts?.direction !== "inbound") {
    try {
      const logRes = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${LOGS_TAB()}!A2:G`,
      });
      for (const row of logRes.data.values || []) {
        const action = (row[3] || "").toLowerCase();
        if (!action.includes("call") && !action.includes("dial")) continue;

        let detailsStr = row[5] || "";
        let leadPhone = "";
        try {
          const parsed = JSON.parse(detailsStr);
          leadPhone = parsed.leadPhone || "";
        } catch {
          // details might not be JSON
        }

        entries.push({
          timestamp: row[1] || "",
          direction: "outbound",
          agentNumber: row[4] || "",
          callerNumber: leadPhone,
          status: action.includes("error") || action.includes("fail") ? "failed" : "completed",
          duration: "",
          conferenceName: "",
          details: detailsStr,
        });
      }
    } catch {
      // CallLogs tab may not exist yet
    }
  }

  // Filter by status
  let filtered = entries;
  if (opts?.status && opts.status !== "all") {
    filtered = filtered.filter((e) => e.status === opts.status);
  }

  // Sort by timestamp descending
  filtered.sort((a, b) => {
    const ta = new Date(a.timestamp).getTime() || 0;
    const tb = new Date(b.timestamp).getTime() || 0;
    return tb - ta;
  });

  const total = filtered.length;
  const offset = opts?.offset || 0;
  const limit = opts?.limit || 50;
  return { entries: filtered.slice(offset, offset + limit), total };
}

// ── Append to CallLogs ────────────────────────────────────────────────────────
export async function appendLog(entry: {
  logId: string;
  action: string;
  leadId: string;
  affiliatePhone: string;
  details: string;
  twilioCallSid?: string;
}) {
  const sheets = getSheets();
  const spreadsheetId = SHEET_ID();
  const tab = LOGS_TAB();

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tab}!A:G`,
    valueInputOption: "RAW",
    requestBody: {
      values: [
        [
          entry.logId,
          new Date().toISOString(),
          entry.leadId,
          entry.action,
          entry.affiliatePhone,
          entry.details,
          entry.twilioCallSid || "",
        ],
      ],
    },
  });
}
