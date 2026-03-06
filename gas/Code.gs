/**
 * Google Apps Script — Traders Utopia Inbound Call Events
 *
 * Receives POST events from Twilio Functions:
 *   1. callback_requested  → appends row to "Callback Queue"
 *   2. agent_on_call       → appends LIVE row to "Live Calls"
 *   3. agent_call_ended    → updates matching LIVE row to ENDED
 *
 * Deploy as Web App → Execute as: Me, Who has access: Anyone.
 * The published URL goes into CALLBACK_SCRIPT_URL env var on Twilio.
 */

const SPREADSHEET_ID = "1LI71rRtGbdPQ8wgSD-QIobDvOc5Yro0lTYgW3_eMDKs";
const SHEET_NAME = "Callback Queue";
const LIVE_CALLS_TAB = "Live Calls";

const LIVE_CALLS_HEADERS = [
  "Agent Number",
  "Conference Name",
  "Caller Number",
  "Start Time",
  "Status",
  "Call Duration",
  "End Time"
];

function doPost(e) {
  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);

    // Safe parse (handles JSON and fallback) — preserved from original
    const raw = (e && e.postData && e.postData.contents) ? e.postData.contents : "{}";
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      data = e.parameter || {};
    }

    const event = data.event || data.tag || "callback_requested";

    switch (event) {
      case "agent_on_call":
        handleAgentOnCall(ss, data);
        break;
      case "agent_call_ended":
        handleAgentCallEnded(ss, data);
        break;
      default:
        // Original callback_requested behavior (also catches any unknown event)
        handleCallbackRequested(ss, data, event);
        break;
    }

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  return ContentService
    .createTextOutput("OK - Callback webhook is live. Send a POST to write to the sheet.")
    .setMimeType(ContentService.MimeType.TEXT);
}

// ── Event Handlers ───────────────────────────────────────────────────────────

/**
 * Original callback_requested handler — preserved exactly as-is.
 * Appends a row to the "Callback Queue" sheet.
 */
function handleCallbackRequested(ss, data, tag) {
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error("Sheet tab not found: " + SHEET_NAME);

  const createdAt = new Date();
  const caller = data.caller || data.From || "";
  const calledNumber = data.called_number || data.To || "";
  const callSid = data.call_sid || data.CallSid || "";
  const digits = data.digits || data.Digits || "";

  sheet.appendRow([createdAt, caller, tag, "NEW", "", "", callSid, calledNumber, digits]);
}

/**
 * agent_on_call — agent pressed 1 on whisper and joined the conference.
 * Adds a LIVE row to the "Live Calls" sheet.
 */
function handleAgentOnCall(ss, data) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getOrCreateSheet_(ss, LIVE_CALLS_TAB, LIVE_CALLS_HEADERS);

    sheet.appendRow([
      data.agent,
      data.conference_name,
      data.caller_number,
      data.timestamp || new Date().toISOString(),
      "LIVE",
      "",
      ""
    ]);

    Logger.log("Agent " + data.agent + " is LIVE on " + data.conference_name);
  } finally {
    lock.releaseLock();
  }
}

/**
 * agent_call_ended — agent's call leg reached a terminal state.
 *
 * Only "completed" calls get their LIVE row updated to ENDED.
 * Non-completed statuses (no-answer, busy, failed, canceled) mean the agent
 * never actually joined the conference — no LIVE row exists to update.
 *
 * If no matching LIVE row is found for a "completed" call, the agent answered
 * the whisper but didn't press 1 (short call, no agent_on_call was sent).
 * This is a safe no-op.
 */
function handleAgentCallEnded(ss, data) {
  if (data.call_status !== "completed") {
    Logger.log("Ignoring agent_call_ended with status: " + data.call_status +
               " for agent " + data.agent);
    return;
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = ss.getSheetByName(LIVE_CALLS_TAB);

    if (!sheet) {
      Logger.log("No \"" + LIVE_CALLS_TAB + "\" sheet found. Nothing to update.");
      return;
    }

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      Logger.log("Live Calls sheet is empty. Nothing to update.");
      return;
    }

    const dataRange = sheet.getRange(2, 1, lastRow - 1, LIVE_CALLS_HEADERS.length);
    const values = dataRange.getValues();

    // Search from bottom (most recent) to top.
    // Match on: Agent Number (col 0) + Conference Name (col 1) + Status "LIVE" (col 4)
    for (let i = values.length - 1; i >= 0; i--) {
      const rowAgent = String(values[i][0]).trim();
      const rowConference = String(values[i][1]).trim();
      const rowStatus = String(values[i][4]).trim();

      if (rowAgent === data.agent &&
          rowConference === data.conference_name &&
          rowStatus === "LIVE") {

        const sheetRow = i + 2;
        sheet.getRange(sheetRow, 5).setValue("ENDED");
        sheet.getRange(sheetRow, 6).setValue(data.call_duration || "");
        sheet.getRange(sheetRow, 7).setValue(data.timestamp || new Date().toISOString());

        Logger.log("Row " + sheetRow + " → ENDED for agent " + data.agent +
                   " on " + data.conference_name +
                   " (duration: " + data.call_duration + "s)");
        return;
      }
    }

    Logger.log("No LIVE row found for agent " + data.agent +
               " on " + data.conference_name + ". No-op.");
  } finally {
    lock.releaseLock();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns the named sheet, creating it with a bold header row if missing.
 */
function getOrCreateSheet_(ss, tabName, headers) {
  let sheet = ss.getSheetByName(tabName);

  if (!sheet) {
    sheet = ss.insertSheet(tabName);
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold");
    Logger.log("Created sheet: " + tabName);
  }

  return sheet;
}
