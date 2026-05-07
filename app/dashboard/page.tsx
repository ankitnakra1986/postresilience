"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { DispatchAssignment, PostOffice, Report } from "@/lib/dispatch";
import postOfficesData from "@/data/post-offices.json";

const DisasterMap = dynamic(() => import("@/components/DisasterMap"), {
  ssr: false,
  loading: () => (
    <div className="flex h-screen w-full items-center justify-center bg-slate-100 text-sm text-slate-600">
      Loading map…
    </div>
  ),
});

const AgentPanel = dynamic(() => import("@/components/AgentPanel"), {
  ssr: false,
});

// Formats seconds as "Xh YYm" or "YYm ZZs" or "ZZs"
function formatElapsed(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

const TOTAL_PANCHAYATS = 85;

export default function DashboardPage() {
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentDone, setAgentDone] = useState(false);
  const [assignments, setAssignments] = useState<DispatchAssignment[]>([]);
  const [runKey, setRunKey] = useState(0);

  // Live response clock — counts up every second from page load
  const [elapsed, setElapsed] = useState(0);

  const postOffices = postOfficesData as PostOffice[];

  // Initial load
  useEffect(() => {
    let cancelled = false;
    fetch("/api/reports")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (cancelled) return;
        setReports(Array.isArray(data) ? data : []);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load reports");
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  // Poll every 5 s — silently updates dots on the map when a new postman
  // report comes in. Only replaces state when count actually changes so
  // the map doesn't flicker on every tick.
  useEffect(() => {
    const poll = setInterval(() => {
      fetch("/api/reports")
        .then((r) => r.ok ? r.json() : null)
        .then((data: Report[] | null) => {
          if (!Array.isArray(data)) return;
          setReports((prev) =>
            data.length !== prev.length ? data : prev
          );
        })
        .catch(() => {/* silent — don't show error on background poll */});
    }, 5000);
    return () => clearInterval(poll);
  }, []);

  useEffect(() => {
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const triggerRun = () => {
    setAssignments([]);
    setAgentDone(false);
    setAgentRunning(true);
    setRunKey((k) => k + 1);
  };

  const handleRunAgent = () => {
    setPanelOpen(true);
    triggerRun();
  };

  const handleClose = () => setPanelOpen(false);

  const handleDispatchReady = (a: DispatchAssignment[]) => {
    setAssignments(a);
    setAgentRunning(false);
    setAgentDone(true);
  };

  const coveragePct =
    reports.length > 0
      ? Math.min(Math.round((reports.length / TOTAL_PANCHAYATS) * 100), 100)
      : 0;

  return (
    <div className="relative h-screen w-full">
      <DisasterMap
        reports={reports}
        postOffices={postOffices}
        assignments={assignments}
        loading={loading}
        error={error}
        onRunAgent={handleRunAgent}
        agentRunning={agentRunning}
        agentDone={agentDone}
      />

      <AgentPanel
        open={panelOpen}
        runKey={runKey}
        reports={reports}
        postOffices={postOffices}
        onClose={handleClose}
        onRerun={triggerRun}
        onDispatchReady={handleDispatchReady}
      />

      {/* ── Response clock (bottom-left) ─────────────────────────────── */}
      <div className="absolute bottom-4 left-4 z-[600] flex items-center gap-1.5 rounded-full border border-slate-200 bg-white/95 px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-md backdrop-blur-sm">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-red-500" />
        T+ {formatElapsed(elapsed)} since activation
      </div>

      {/* ── Coverage completeness bar (bottom-center) ─────────────────── */}
      {!loading && reports.length > 0 && (
        <div className="absolute bottom-[52px] left-1/2 z-[600] w-[min(360px,calc(100vw-9rem))] -translate-x-1/2 rounded-xl border border-slate-200 bg-white/95 px-3 py-2.5 shadow-md backdrop-blur-sm">
          <div className="flex items-center justify-between text-[11px] font-semibold">
            <span className="text-slate-600">District coverage</span>
            <span className={coveragePct < 30 ? "text-red-600" : "text-emerald-700"}>
              {coveragePct}% reached
            </span>
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
            <div
              className="h-full rounded-full bg-red-500 transition-all duration-700"
              style={{ width: `${coveragePct}%` }}
            />
          </div>
          <div className="mt-1 text-[10px] text-slate-500">
            {reports.length} postman reports / ~{TOTAL_PANCHAYATS} panchayats · first 2h
          </div>
        </div>
      )}

      {/* ── Post-agent "20 days → 6 hours" impact flash (top-center) ──── */}
      <div
        className={`pointer-events-none absolute left-1/2 z-[650] -translate-x-1/2 transition-all duration-700 ease-out ${
          agentDone
            ? "top-1/3 opacity-100"
            : "top-[28%] opacity-0"
        }`}
      >
        <div className="rounded-2xl bg-emerald-600 px-5 py-4 shadow-2xl">
          <div className="flex items-baseline gap-2 text-center text-white">
            <span className="text-2xl font-black sm:text-3xl">20 days</span>
            <span className="text-xl font-light text-emerald-200 sm:text-2xl">→</span>
            <span className="text-2xl font-black sm:text-3xl">6 hours</span>
          </div>
          <div className="mt-1 text-center text-[11px] font-medium text-emerald-100">
            80× faster · {reports.length} households mapped · dispatch plan ready
          </div>
        </div>
      </div>

      {/* ── Back to postman form ──────────────────────────────────────── */}
      <Link
        href="/"
        className="absolute bottom-4 right-4 z-[600] rounded-full bg-white px-4 py-2 text-xs font-medium text-slate-700 shadow-lg ring-1 ring-slate-200 hover:bg-slate-50"
      >
        ← Submit field report
      </Link>
    </div>
  );
}
