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
