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

export default function DashboardPage() {
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentDone, setAgentDone] = useState(false);
  const [assignments, setAssignments] = useState<DispatchAssignment[]>([]);
  // runKey is the single source of truth for "start a fresh agent run".
  // Bumping it (from any path: header button or panel reset) fires the
  // simulation in AgentPanel via useEffect dep. Without this, neither
  // path re-triggers because `panelOpen` is already true the second time.
  const [runKey, setRunKey] = useState(0);

  const postOffices = postOfficesData as PostOffice[];

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
    return () => {
      cancelled = true;
    };
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

      <Link
        href="/"
        className="absolute bottom-4 right-4 z-[600] rounded-full bg-white px-4 py-2 text-xs font-medium text-slate-700 shadow-lg ring-1 ring-slate-200 hover:bg-slate-50"
      >
        ← Submit field report
      </Link>
    </div>
  );
}
