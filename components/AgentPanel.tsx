"use client";

import { useEffect, useRef, useState } from "react";
import {
  DispatchAssignment,
  DispatchSummary,
  PostOffice,
  Report,
  packageServices,
  primaryService,
  sdmaBriefLines,
  summarize,
} from "@/lib/dispatch";

type Phase = "idle" | "running" | "done";
type StepStatus = "pending" | "running" | "done";

type Step = {
  key: "demand" | "capacity" | "package" | "brief";
  title: string;
  hint: string;
};

const STEPS: Step[] = [
  { key: "demand", title: "1. Demand Sensing", hint: "Ranking 15 postman reports by urgency" },
  { key: "capacity", title: "2. Capacity Mapping", hint: "Matching demand to operational post offices" },
  { key: "package", title: "3. Service Packaging", hint: "Building dispatch plan per household" },
  { key: "brief", title: "4. SDMA Brief", hint: "Composing 5-line situation report" },
];

type Props = {
  open: boolean;
  runKey: number;
  reports: Report[];
  postOffices: PostOffice[];
  onClose: () => void;
  onRerun: () => void;
  onDispatchReady: (assignments: DispatchAssignment[]) => void;
};

export default function AgentPanel({
  open,
  runKey,
  reports,
  postOffices,
  onClose,
  onRerun,
  onDispatchReady,
}: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [stepStatus, setStepStatus] = useState<Record<string, StepStatus>>({
    demand: "pending",
    capacity: "pending",
    package: "pending",
    brief: "pending",
  });
  const [assignments, setAssignments] = useState<DispatchAssignment[]>([]);
  const [summary, setSummary] = useState<DispatchSummary | null>(null);
  const [briefLines, setBriefLines] = useState<string[]>([]);
  // Guard against in-flight simulations: if the user mashes re-run while a
  // run is mid-flight, the new run wins and the stale one's setState calls
  // are no-ops because they check this token.
  const runTokenRef = useRef(0);

  useEffect(() => {
    // runKey === 0 is the initial mount before the user has clicked anything.
    if (runKey === 0 || reports.length === 0) return;
    runSimulation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKey]);

  const reset = () => {
    // Round-trip through the parent so dashboard state (agentRunning,
    // agentDone, assignments on the map) stays in sync with the panel.
    onRerun();
  };

  async function runSimulation() {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    runTokenRef.current += 1;
    const myToken = runTokenRef.current;
    const isCurrent = () => runTokenRef.current === myToken;

    setPhase("running");
    setStepStatus({ demand: "pending", capacity: "pending", package: "pending", brief: "pending" });
    setAssignments([]);
    setSummary(null);
    setBriefLines([]);

    setStepStatus((s) => ({ ...s, demand: "running" }));
    await wait(900);
    if (!isCurrent()) return;
    setStepStatus((s) => ({ ...s, demand: "done" }));

    setStepStatus((s) => ({ ...s, capacity: "running" }));
    await wait(900);
    if (!isCurrent()) return;
    setStepStatus((s) => ({ ...s, capacity: "done" }));

    setStepStatus((s) => ({ ...s, package: "running" }));
    await wait(1100);
    if (!isCurrent()) return;
    const packaged = packageServices(reports, postOffices);
    setAssignments(packaged);
    onDispatchReady(packaged);
    setStepStatus((s) => ({ ...s, package: "done" }));

    setStepStatus((s) => ({ ...s, brief: "running" }));
    await wait(700);
    if (!isCurrent()) return;
    const sum = summarize(packaged);
    setSummary(sum);
    setBriefLines(sdmaBriefLines(sum));
    setStepStatus((s) => ({ ...s, brief: "done" }));

    setPhase("done");
  }

  const demandRanked = [...reports]
    .map((r) => ({ ...r, service: primaryService(r.needs) }))
    .sort((a, b) => {
      const order = { evacuation: 0, medicine: 1, cash: 2, food: 3, other: 4 };
      const ra = order[a.service as keyof typeof order] ?? 5;
      const rb = order[b.service as keyof typeof order] ?? 5;
      if (ra !== rb) return ra - rb;
      const sevOrder = { critical: 0, medium: 1, low: 2 };
      return (
        (sevOrder[a.severity as keyof typeof sevOrder] ?? 3) -
        (sevOrder[b.severity as keyof typeof sevOrder] ?? 3)
      );
    });

  return (
    <div
      className={`fixed inset-y-0 right-0 z-[1000] flex w-full max-w-md flex-col border-l border-slate-200 bg-white shadow-2xl transition-transform duration-300 sm:max-w-lg ${
        open ? "translate-x-0" : "translate-x-full"
      }`}
      aria-hidden={!open}
    >
      <header className="flex items-center justify-between border-b border-slate-200 bg-slate-900 px-4 py-3 text-white">
        <div>
          <div className="text-xs uppercase tracking-wider text-slate-400">
            PostResilience Agent · AWS Bedrock
          </div>
          <div className="text-base font-bold">
            {phase === "running" && "Running 4 tool calls…"}
            {phase === "done" && "Dispatch plan ready"}
            {phase === "idle" && "Standing by"}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {phase === "done" && (
            <button
              type="button"
              onClick={reset}
              className="rounded-md bg-slate-700 px-2.5 py-1 text-xs font-medium hover:bg-slate-600"
            >
              Reset
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-slate-700 px-2.5 py-1 text-xs font-medium hover:bg-slate-600"
          >
            Close
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        <ol className="space-y-3">
          {STEPS.map((step) => {
            const status = stepStatus[step.key];
            return (
              <li
                key={step.key}
                className={`rounded-lg border p-3 transition ${
                  status === "running"
                    ? "border-red-300 bg-red-50"
                    : status === "done"
                    ? "border-green-300 bg-green-50"
                    : "border-slate-200 bg-slate-50"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-semibold text-slate-900">{step.title}</div>
                    <div className="text-xs text-slate-600">{step.hint}</div>
                  </div>
                  <StatusPill status={status} />
                </div>

                {step.key === "demand" && status === "done" && (
                  <div className="mt-2 max-h-40 overflow-y-auto rounded bg-white p-2 font-mono text-[11px] leading-relaxed text-slate-700">
                    {demandRanked.slice(0, 6).map((r) => (
                      <div key={r.id}>
                        {String(r.id).padStart(2, "0")} · {r.digipin} · {r.service.toUpperCase()} ·{" "}
                        {r.severity}
                      </div>
                    ))}
                    <div className="text-slate-400">…+{Math.max(0, demandRanked.length - 6)} more</div>
                  </div>
                )}

                {step.key === "capacity" && status === "done" && (
                  <div className="mt-2 space-y-1 rounded bg-white p-2 text-[11px] text-slate-700">
                    {postOffices.map((p) => (
                      <div key={p.id} className="flex items-center justify-between">
                        <span className="font-medium">{p.name}</span>
                        <span
                          className={
                            p.status === "operational"
                              ? "text-green-700 font-semibold"
                              : "text-red-700 font-semibold"
                          }
                        >
                          {p.status}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {step.key === "package" && status === "done" && (
                  <div className="mt-2 max-h-48 overflow-y-auto rounded bg-white p-2 text-[11px] text-slate-700">
                    {assignments.slice(0, 6).map((a) => (
                      <div key={a.reportId} className="border-b border-slate-100 py-1 last:border-0">
                        <div className="font-mono">{a.digipin}</div>
                        <div className="text-slate-600">
                          {a.action}
                          {a.poName ? ` · ${a.poName}` : ""}
                          {a.distanceKm !== null ? ` (${a.distanceKm} km)` : ""}
                        </div>
                      </div>
                    ))}
                    <div className="pt-1 text-slate-400">
                      …+{Math.max(0, assignments.length - 6)} more
                    </div>
                  </div>
                )}

                {step.key === "brief" && status === "done" && summary && (
                  <div className="mt-2 rounded border border-slate-300 bg-white p-3 text-xs leading-relaxed text-slate-800">
                    <div className="mb-1 font-semibold text-slate-900">SDMA Situation Report</div>
                    <ul className="space-y-0.5">
                      {briefLines.map((line, i) => (
                        <li key={i}>· {line}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </li>
            );
          })}
        </ol>

        {phase === "done" && summary && (
          <ImpactDashboard summary={summary} assignments={assignments} />
        )}
      </div>
    </div>
  );
}

function ImpactDashboard({
  summary,
  assignments,
}: {
  summary: DispatchSummary;
  assignments: DispatchAssignment[];
}) {
  const reachable = assignments.filter((a) => a.poId !== null).length;
  const coveragePct =
    summary.total > 0 ? Math.round((reachable / summary.total) * 100) : 0;
  const cashDisbursedINR = summary.cash * 2000;

  return (
    <div className="mt-5 space-y-3">
      <div className="rounded-xl bg-emerald-600 p-5 text-white shadow-lg">
        <div className="text-[10px] font-semibold uppercase tracking-[0.15em] text-emerald-100">
          Time saved vs. official PDNA
        </div>
        <div className="mt-2 flex items-baseline gap-2 sm:gap-3">
          <div className="text-3xl font-black leading-none sm:text-4xl">20 days</div>
          <div className="text-2xl font-light text-emerald-200 sm:text-3xl">→</div>
          <div className="text-3xl font-black leading-none sm:text-4xl">6 hours</div>
        </div>
        <div className="mt-2 text-xs font-medium text-emerald-100">
          80× faster · 76 expert-visits avoided
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <ImpactTile value={summary.total.toString()} label="Households" />
        <ImpactTile
          value={summary.evacuation.toString()}
          label="Evacuations"
          accent="text-red-600"
        />
        <ImpactTile
          value={`₹${(cashDisbursedINR / 1000).toFixed(0)}k`}
          label="Cash"
          accent="text-emerald-700"
        />
      </div>

      <p className="text-center text-[11px] leading-relaxed text-slate-500">
        Coverage{" "}
        <span className="font-semibold text-slate-700">
          {coveragePct}% ({reachable}/{summary.total})
        </span>{" "}
        via operational POs · Medicine {summary.medicine} · Food {summary.food}
      </p>
    </div>
  );
}

function ImpactTile({
  value,
  label,
  accent,
}: {
  value: string;
  label: string;
  accent?: string;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 text-center">
      <div className={`text-2xl font-black leading-none tracking-tight ${accent ?? "text-slate-900"}`}>
        {value}
      </div>
      <div className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        {label}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: StepStatus }) {
  if (status === "running") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-semibold uppercase text-white">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
        Running
      </span>
    );
  }
  if (status === "done") {
    return (
      <span className="rounded-full bg-green-600 px-2 py-0.5 text-[10px] font-semibold uppercase text-white">
        Done
      </span>
    );
  }
  return (
    <span className="rounded-full bg-slate-300 px-2 py-0.5 text-[10px] font-semibold uppercase text-slate-700">
      Pending
    </span>
  );
}

