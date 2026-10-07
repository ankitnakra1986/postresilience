"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { Component, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { DispatchAssignment, PostOffice, Report } from "@/lib/dispatch";
import postOfficesData from "@/data/post-offices.json";

class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="flex h-screen w-full flex-col items-center justify-center gap-4 bg-slate-50 p-6 text-center">
          <div className="text-4xl">⚠️</div>
          <h2 className="text-lg font-bold text-slate-800">Dashboard failed to load</h2>
          <pre className="max-w-sm rounded-lg bg-slate-100 p-3 text-left text-xs text-slate-600 overflow-auto">
            {this.state.error.message}
          </pre>
          <Link
            href="/"
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white"
          >
            ← Back to field report
          </Link>
        </div>
      );
    }
    return this.props.children;
  }
}

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

  // Draggable "20 days → 6 hours" banner
  const [bannerPos, setBannerPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  const onBannerPointerDown = useCallback((e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: bannerPos?.x ?? rect.left + rect.width / 2,
      origY: bannerPos?.y ?? rect.top + rect.height / 2,
    };
  }, [bannerPos]);

  const onBannerPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    setBannerPos({
      x: dragRef.current.origX + dx,
      y: dragRef.current.origY + dy,
    });
  }, []);

  const onBannerPointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

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
    <ErrorBoundary>
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
      <div
        className="absolute left-4 z-[600] flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-md"
        style={{ bottom: "max(1rem, env(safe-area-inset-bottom))" }}
      >
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-red-500" />
        T+ {formatElapsed(elapsed)} since activation
      </div>

      {/* ── Coverage completeness bar (bottom-center) ─────────────────── */}
      {!loading && reports.length > 0 && (
        <div
          className="absolute left-1/2 z-[600] w-[min(320px,calc(100vw-8rem))] -translate-x-1/2 rounded-xl border border-slate-200 bg-white px-3 py-2.5 shadow-md"
          style={{ bottom: "max(3rem, calc(env(safe-area-inset-bottom) + 2rem))" }}
        >
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
            {reports.length} reports / ~{TOTAL_PANCHAYATS} panchayats · first 2h
          </div>
        </div>
      )}

      {/* ── Post-agent "20 days → 6 hours" impact flash — draggable ──── */}
      {agentDone && (
        <div
          className="absolute z-[650] cursor-grab active:cursor-grabbing select-none touch-none"
          style={
            bannerPos
              ? { left: bannerPos.x, top: bannerPos.y, transform: "translate(-50%, -50%)" }
              : { left: "50%", top: "33%", transform: "translate(-50%, -50%)" }
          }
          onPointerDown={onBannerPointerDown}
          onPointerMove={onBannerPointerMove}
          onPointerUp={onBannerPointerUp}
        >
          <div className="rounded-2xl bg-emerald-600 px-4 py-3 shadow-2xl sm:px-5 sm:py-4">
            <div className="text-center text-[10px] font-semibold uppercase tracking-wide text-emerald-100">
              Projected
            </div>
            <div className="mt-1 flex items-baseline gap-2 text-center text-white">
              <span className="text-xl font-black sm:text-3xl">20 days</span>
              <span className="text-lg font-light text-emerald-200 sm:text-2xl">→</span>
              <span className="text-xl font-black sm:text-3xl">6 hours</span>
            </div>
            <div className="mt-1 text-center text-[10px] font-medium text-emerald-100 sm:text-[11px]">
              80× faster · {reports.length} households mapped · dispatch ready
            </div>
          </div>
        </div>
      )}

      {/* ── Back to postman form ──────────────────────────────────────── */}
      <Link
        href="/"
        className="absolute right-4 z-[600] rounded-full bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-lg ring-1 ring-slate-200 active:bg-slate-50"
        style={{ bottom: "max(1rem, env(safe-area-inset-bottom))" }}
      >
        ← Field report
      </Link>
    </div>
    </ErrorBoundary>
  );
}
