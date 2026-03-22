"use client";

import { useState, useEffect, useCallback } from "react";
import DashboardShell from "@/app/components/DashboardShell";

interface CallHistoryEntry {
  timestamp: string;
  direction: "inbound" | "outbound";
  agentNumber: string;
  callerNumber: string;
  status: string;
  duration: string;
  conferenceName: string;
  details: string;
}

interface Contact {
  phone: string;
  name: string;
}

export default function HistoryPage() {
  return (
    <DashboardShell>
      {(ctx) => <HistoryContent accessCode={ctx.accessCode} />}
    </DashboardShell>
  );
}

function HistoryContent({ accessCode }: { accessCode: string }) {
  const [entries, setEntries] = useState<CallHistoryEntry[]>([]);
  const [contacts, setContacts] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const limit = 50;

  const [directionFilter, setDirectionFilter] = useState<"all" | "inbound" | "outbound">("all");
  const [statusFilter, setStatusFilter] = useState("all");

  void accessCode;

  const fetchContacts = useCallback(async () => {
    try {
      const res = await fetch("/api/contacts?t=" + Date.now(), { cache: "no-store" });
      const data = await res.json();
      if (data.ok) {
        const map = new Map<string, string>();
        for (const c of data.contacts as Contact[]) {
          const digits = c.phone.replace(/[^0-9]/g, "");
          map.set(digits, c.name);
        }
        setContacts(map);
      }
    } catch {
      // non-fatal
    }
  }, []);

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        direction: directionFilter,
        status: statusFilter,
        limit: String(limit),
        offset: String(offset),
      });
      const res = await fetch(`/api/call-history?${params}&t=${Date.now()}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (data.ok) {
        setEntries(data.entries);
        setTotal(data.total);
      }
    } catch (err) {
      console.error("Fetch history error:", err);
    }
    setLoading(false);
  }, [directionFilter, statusFilter, offset]);

  useEffect(() => {
    fetchContacts();
  }, [fetchContacts]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  // Reset offset when filters change
  useEffect(() => {
    setOffset(0);
  }, [directionFilter, statusFilter]);

  function lookupName(phone: string): string | null {
    if (!phone) return null;
    const digits = phone.replace(/[^0-9]/g, "");
    return contacts.get(digits) || null;
  }

  const totalPages = Math.ceil(total / limit);
  const currentPage = Math.floor(offset / limit) + 1;

  return (
    <div>
      {/* Filters */}
      <div className="px-4 py-3 flex flex-col sm:flex-row gap-3 border-b border-slate-800">
        <div className="flex gap-1">
          {(["all", "inbound", "outbound"] as const).map((d) => (
            <button
              key={d}
              onClick={() => setDirectionFilter(d)}
              className={`px-3 py-1.5 text-sm rounded-lg font-medium transition ${
                directionFilter === d
                  ? "bg-blue-600 text-white"
                  : "bg-slate-800 text-slate-400 hover:text-white"
              }`}
            >
              {d.charAt(0).toUpperCase() + d.slice(1)}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          {["all", "completed", "active", "failed"].map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 text-sm rounded-lg font-medium transition ${
                statusFilter === s
                  ? "bg-blue-600 text-white"
                  : "bg-slate-800 text-slate-400 hover:text-white"
              }`}
            >
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
        <button
          onClick={fetchHistory}
          className="px-3 py-1.5 text-sm bg-slate-700 hover:bg-slate-600 rounded-lg transition ml-auto"
        >
          Refresh
        </button>
      </div>

      {/* Table */}
      <main className="p-4">
        {loading && entries.length === 0 && (
          <p className="text-slate-500 text-center py-10">Loading...</p>
        )}

        {!loading && entries.length === 0 && (
          <p className="text-slate-500 text-center py-10">No call history found.</p>
        )}

        {/* Desktop table */}
        <div className="hidden md:block">
          {entries.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-slate-400 text-xs uppercase border-b border-slate-800">
                  <th className="text-left py-2 px-2">Time</th>
                  <th className="text-left py-2 px-2">Direction</th>
                  <th className="text-left py-2 px-2">Caller / Lead</th>
                  <th className="text-left py-2 px-2">Agent</th>
                  <th className="text-left py-2 px-2">Status</th>
                  <th className="text-left py-2 px-2">Duration</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry, i) => {
                  const name = lookupName(entry.callerNumber);
                  return (
                    <tr key={`${entry.timestamp}-${i}`} className="border-b border-slate-800/50 hover:bg-slate-900/50">
                      <td className="py-3 px-2 text-slate-300 text-xs">{formatDate(entry.timestamp)}</td>
                      <td className="py-3 px-2">
                        <DirectionBadge direction={entry.direction} />
                      </td>
                      <td className="py-3 px-2">
                        {name ? (
                          <span>
                            <span className="text-white">{name}</span>
                            <span className="text-slate-500 text-xs ml-1 font-mono">({entry.callerNumber})</span>
                          </span>
                        ) : (
                          <span className="text-slate-300 font-mono text-xs">{entry.callerNumber || "—"}</span>
                        )}
                      </td>
                      <td className="py-3 px-2 text-slate-300 font-mono text-xs">{entry.agentNumber || "—"}</td>
                      <td className="py-3 px-2">
                        <StatusBadge status={entry.status} />
                      </td>
                      <td className="py-3 px-2 text-slate-400 text-xs font-mono">
                        {entry.duration ? `${entry.duration}s` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Mobile cards */}
        <div className="md:hidden space-y-3">
          {entries.map((entry, i) => {
            const name = lookupName(entry.callerNumber);
            return (
              <div key={`${entry.timestamp}-${i}`} className="bg-slate-900 border border-slate-700 rounded-xl p-4">
                <div className="flex justify-between items-start mb-2">
                  <div className="flex gap-2 items-center">
                    <DirectionBadge direction={entry.direction} />
                    <StatusBadge status={entry.status} />
                  </div>
                  <span className="text-slate-500 text-xs">{formatDate(entry.timestamp)}</span>
                </div>
                <div className="mb-1">
                  {name ? (
                    <p className="text-white font-medium">
                      {name} <span className="text-slate-500 text-xs font-mono">({entry.callerNumber})</span>
                    </p>
                  ) : (
                    <p className="text-slate-300 font-mono text-sm">{entry.callerNumber || "—"}</p>
                  )}
                </div>
                <div className="flex gap-4 text-xs text-slate-500">
                  <span>Agent: {entry.agentNumber || "—"}</span>
                  {entry.duration && <span>Duration: {entry.duration}s</span>}
                </div>
              </div>
            );
          })}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-6 text-sm">
            <button
              onClick={() => setOffset(Math.max(0, offset - limit))}
              disabled={offset === 0}
              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Previous
            </button>
            <span className="text-slate-400">
              Page {currentPage} of {totalPages} ({total} total)
            </span>
            <button
              onClick={() => setOffset(offset + limit)}
              disabled={offset + limit >= total}
              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Next
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

function DirectionBadge({ direction }: { direction: string }) {
  const styles = direction === "inbound"
    ? "bg-cyan-900/50 text-cyan-300 border-cyan-700"
    : "bg-violet-900/50 text-violet-300 border-violet-700";
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${styles}`}>
      {direction}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles =
    status === "completed"
      ? "bg-green-900/50 text-green-300 border-green-700"
      : status === "active"
        ? "bg-blue-900/50 text-blue-300 border-blue-700"
        : status === "failed"
          ? "bg-red-900/50 text-red-300 border-red-700"
          : "bg-slate-800 text-slate-400 border-slate-600";
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${styles}`}>
      {status}
    </span>
  );
}

function formatDate(raw: string): string {
  if (!raw) return "—";
  try {
    let d: Date;
    const ddmmMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):?(\d{2})?/);
    if (ddmmMatch) {
      const [, day, month, year, hour, min, sec] = ddmmMatch;
      d = new Date(
        parseInt(year), parseInt(month) - 1, parseInt(day),
        parseInt(hour), parseInt(min), parseInt(sec || "0")
      );
    } else {
      d = new Date(raw);
    }
    if (isNaN(d.getTime())) return raw;
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return raw;
  }
}
