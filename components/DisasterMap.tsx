"use client";

import { useEffect, useMemo, useState } from "react";
import {
  MapContainer,
  TileLayer,
  CircleMarker,
  Popup,
  Tooltip,
  Marker,
  Polygon,
  Polyline,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { DispatchAssignment, PostOffice, Report } from "@/lib/dispatch";

type Bucket = "red" | "orange" | "green";

const BUCKET_STYLE: Record<Bucket, { fill: string; stroke: string; label: string }> = {
  red: { fill: "#dc2626", stroke: "#7f1d1d", label: "Evacuation" },
  orange: { fill: "#f97316", stroke: "#9a3412", label: "Medicine / Cash" },
  green: { fill: "#16a34a", stroke: "#166534", label: "Food only" },
};

function bucketize(needs: string[]): Bucket {
  if (needs.includes("evacuation")) return "red";
  if (needs.includes("medicine") || needs.includes("cash")) return "orange";
  return "green";
}

function radiusForSeverity(sev: Report["severity"]): number {
  if (sev === "critical") return 12;
  if (sev === "medium") return 9;
  return 7;
}

const KERALA_CENTER: [number, number] = [10.25, 76.26];

const SERVICE_LINE_COLOR: Record<string, string> = {
  evacuation: "#dc2626",
  medicine: "#f97316",
  cash: "#eab308",
  food: "#16a34a",
  other: "#64748b",
};

function poIcon(status: string): L.DivIcon {
  const isOp = status === "operational";
  const bg = isOp ? "#0f172a" : "#9ca3af";
  const ring = isOp ? "#22c55e" : "#ef4444";
  const label = isOp ? "PO" : "✕";
  return L.divIcon({
    className: "po-icon",
    html: `<div style="
      background:${bg};
      color:white;
      width:28px;height:28px;
      border-radius:6px;
      border:3px solid ${ring};
      display:flex;align-items:center;justify-content:center;
      font-size:11px;font-weight:700;
      box-shadow:0 2px 6px rgba(0,0,0,0.3);
    ">${label}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

// Yellow diamond marker for postman-blocked locations (route unsafe).
// Distinct from RED/ORANGE/GREEN CircleMarkers — signals coverage gap, not demand.
const BLOCKED_ICON: L.DivIcon = L.divIcon({
  className: "blocked-icon",
  html: `<div style="
    width:22px;height:22px;
    background:#facc15;
    border:2px solid #92400e;
    transform:rotate(45deg);
    display:flex;align-items:center;justify-content:center;
    box-shadow:0 2px 6px rgba(0,0,0,0.3);
  "><span style="
    transform:rotate(-45deg);
    color:#7c2d12;
    font-size:12px;
    font-weight:900;
    line-height:1;
  ">⚠</span></div>`,
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});

// Approximate unreached-zone bounding boxes — north/east of Thrissur and
// south/west of Ernakulam where no postman dots have landed in the first 2hr.
// Visual coverage-gap indicator only; no claim of real panchayat boundaries.
const UNREACHED_ZONES: { id: string; label: string; bounds: [number, number][] }[] = [
  {
    id: "thrissur-north",
    label: "North Thrissur (unreached)",
    bounds: [
      [10.6, 76.12],
      [10.6, 76.32],
      [10.72, 76.32],
      [10.72, 76.12],
    ],
  },
  {
    id: "thrissur-east",
    label: "East Thrissur (unreached)",
    bounds: [
      [10.42, 76.28],
      [10.42, 76.45],
      [10.58, 76.45],
      [10.58, 76.28],
    ],
  },
  {
    id: "ernakulam-south",
    label: "South Ernakulam (unreached)",
    bounds: [
      [9.82, 76.22],
      [9.82, 76.42],
      [9.96, 76.42],
      [9.96, 76.22],
    ],
  },
  {
    id: "ernakulam-west",
    label: "West Ernakulam (unreached)",
    bounds: [
      [9.95, 76.08],
      [9.95, 76.26],
      [10.1, 76.26],
      [10.1, 76.08],
    ],
  },
];

type Props = {
  reports: Report[];
  postOffices: PostOffice[];
  assignments: DispatchAssignment[];
  loading: boolean;
  error: string;
  onRunAgent?: () => void;
  agentRunning?: boolean;
  agentDone?: boolean;
};

export default function DisasterMap({
  reports,
  postOffices,
  assignments,
  loading,
  error,
  onRunAgent,
  agentRunning = false,
  agentDone = false,
}: Props) {
  const [mounted, setMounted] = useState(false);
  const [showUnreached, setShowUnreached] = useState(false);
  useEffect(() => setMounted(true), []);

  const blockedReports = useMemo(
    () => reports.filter((r) => r.needs.includes("blocked")),
    [reports]
  );
  const demandReports = useMemo(
    () => reports.filter((r) => !r.needs.includes("blocked")),
    [reports]
  );

  const counts = useMemo(() => {
    const c = {
      red: 0,
      orange: 0,
      green: 0,
      blocked: blockedReports.length,
      total: reports.length,
    };
    demandReports.forEach((r) => {
      c[bucketize(r.needs)]++;
    });
    return c;
  }, [reports, demandReports, blockedReports]);

  const uniquePostmen = useMemo(() => {
    const set = new Set<string>();
    reports.forEach((r) => {
      if (r.postman && r.postman.trim()) set.add(r.postman.trim());
    });
    return set.size;
  }, [reports]);

  const poById = useMemo(() => {
    const m = new Map<string, PostOffice>();
    postOffices.forEach((p) => m.set(p.id, p));
    return m;
  }, [postOffices]);

  const dispatchLines = useMemo(() => {
    return assignments
      .filter((a) => a.poId)
      .map((a) => {
        const report = reports.find((r) => r.id === a.reportId);
        const po = a.poId ? poById.get(a.poId) : null;
        if (!report || !po) return null;
        return {
          key: a.reportId,
          positions: [
            [po.lat, po.lng],
            [report.lat, report.lng],
          ] as [number, number][],
          color: SERVICE_LINE_COLOR[a.service] ?? "#64748b",
        };
      })
      .filter(Boolean) as { key: number; positions: [number, number][]; color: string }[];
  }, [assignments, poById, reports]);

  return (
    <div className="flex h-screen w-full flex-col bg-slate-100">
      {/* Scenario alert strip */}
      <div className="flex items-center justify-between bg-red-600 px-4 py-1.5 text-white sm:px-6">
        <div className="flex items-center gap-2 text-xs font-semibold sm:text-sm">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-white" />
          FLOOD ALERT ACTIVE — Thrissur + Ernakulam, Kerala · May 2026
        </div>
        <div className="text-[10px] font-medium text-red-200 sm:text-xs">
          PostResilience · India Post
        </div>
      </div>

      <header className="flex flex-col gap-3 border-b border-slate-200 bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-600 text-sm font-bold text-white">
            IP
          </div>
          <div>
            <h1 className="text-base font-bold text-slate-900 sm:text-lg">SDMA Live Dashboard</h1>
            <p className="text-xs text-slate-500">
              Thrissur + Ernakulam · Flood Response · Live Postman Feed
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs sm:text-sm">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 font-medium text-slate-700">
            <span className="h-2 w-2 rounded-full bg-slate-400" />
            {counts.total} reports · {uniquePostmen} postmen
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-red-50 px-2.5 py-1 font-medium text-red-700">
            <span className="h-2 w-2 rounded-full bg-red-600" />
            {counts.red} evac
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-orange-50 px-2.5 py-1 font-medium text-orange-700">
            <span className="h-2 w-2 rounded-full bg-orange-500" />
            {counts.orange} med/cash
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-green-50 px-2.5 py-1 font-medium text-green-700">
            <span className="h-2 w-2 rounded-full bg-green-600" />
            {counts.green} food
          </span>
          {counts.blocked > 0 && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 font-medium text-amber-800">
              <span className="inline-block h-2 w-2 rotate-45 bg-amber-400" />
              {counts.blocked} blocked
            </span>
          )}
          <button
            type="button"
            onClick={onRunAgent}
            disabled={agentRunning || counts.total === 0}
            className="ml-1 inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60 sm:text-sm"
          >
            {agentRunning ? "Running…" : agentDone ? "▶ Re-run Agent" : "▶ Run PostResilience Agent"}
          </button>
        </div>
      </header>

      <div className="relative flex-1">
        {loading && (
          <div className="absolute inset-0 z-[400] flex items-center justify-center bg-white/70 text-sm text-slate-600">
            Loading reports…
          </div>
        )}
        {error && (
          <div className="absolute left-4 top-4 z-[500] rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 shadow">
            ⚠ {error}
          </div>
        )}

        {/* Floating layers control — kept off the header to keep that row clean. */}
        <div className="absolute right-3 top-3 z-[500] rounded-lg border border-slate-200 bg-white/95 p-2 shadow-md backdrop-blur">
          <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            Map layers
          </div>
          <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100">
            <input
              type="checkbox"
              checked={showUnreached}
              onChange={(e) => setShowUnreached(e.target.checked)}
              className="h-3.5 w-3.5 cursor-pointer accent-slate-700"
            />
            <span
              className="inline-block h-3 w-3 border border-slate-500"
              style={{
                background:
                  "repeating-linear-gradient(45deg, #94a3b8 0 3px, #cbd5e1 3px 6px)",
              }}
              aria-hidden="true"
            />
            Unreached zones
          </label>
        </div>

        {mounted && (
          <MapContainer
            center={KERALA_CENTER}
            zoom={9}
            scrollWheelZoom
            className="h-full w-full"
            style={{ height: "100%", width: "100%" }}
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />

            {showUnreached &&
              UNREACHED_ZONES.map((zone) => (
                <Polygon
                  key={zone.id}
                  positions={zone.bounds}
                  pathOptions={{
                    color: "#334155",
                    weight: 2,
                    dashArray: "6 4",
                    fillColor: "#94a3b8",
                    fillOpacity: 0.45,
                  }}
                >
                  <Tooltip
                    permanent
                    direction="center"
                    opacity={0.92}
                    className="unreached-label"
                  >
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-700">
                      {zone.label}
                    </span>
                  </Tooltip>
                </Polygon>
              ))}

            {dispatchLines.map((line) => (
              <Polyline
                key={`line-${line.key}`}
                positions={line.positions}
                pathOptions={{ color: line.color, weight: 2.5, opacity: 0.7, dashArray: "6 6" }}
              />
            ))}

            {postOffices.map((p) => (
              <Marker key={p.id} position={[p.lat, p.lng]} icon={poIcon(p.status)}>
                <Tooltip direction="top" offset={[0, -10]} opacity={1}>
                  <span className="font-semibold">{p.name}</span> · {p.status}
                </Tooltip>
                <Popup>
                  <div className="text-sm">
                    <div className="font-bold text-slate-900">{p.name}</div>
                    <div className="text-xs text-slate-600">{p.district}</div>
                    <div className="mt-1">
                      Status:{" "}
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
                  </div>
                </Popup>
              </Marker>
            ))}

            {blockedReports.map((r) => (
              <Marker
                key={`blocked-${r.id}`}
                position={[r.lat, r.lng]}
                icon={BLOCKED_ICON}
              >
                <Tooltip direction="top" offset={[0, -10]} opacity={1}>
                  <span className="font-semibold">{r.digipin}</span> · Route blocked
                </Tooltip>
                <Popup>
                  <div className="space-y-1 text-sm">
                    <div className="font-bold text-slate-900">{r.postman}</div>
                    <div className="font-mono text-xs text-slate-600">{r.digipin}</div>
                    <div className="text-xs text-slate-600">{r.district}</div>
                    <div className="pt-1 text-xs">
                      <span className="font-semibold text-amber-800">⚠ Postman cannot proceed</span>
                      <div className="text-slate-600">
                        Route unsafe — coverage gap flagged. SDMA to reroute or escalate.
                      </div>
                    </div>
                  </div>
                </Popup>
              </Marker>
            ))}

            {demandReports.map((r) => {
              const bucket = bucketize(r.needs);
              const style = BUCKET_STYLE[bucket];
              const assignment = assignments.find((a) => a.reportId === r.id);
              return (
                <CircleMarker
                  key={r.id}
                  center={[r.lat, r.lng]}
                  radius={radiusForSeverity(r.severity)}
                  pathOptions={{
                    color: style.stroke,
                    fillColor: style.fill,
                    fillOpacity: 0.85,
                    weight: 2,
                  }}
                >
                  <Tooltip direction="top" offset={[0, -6]} opacity={1}>
                    <span className="font-semibold">{r.digipin}</span> · {style.label}
                  </Tooltip>
                  <Popup>
                    <div className="space-y-1 text-sm">
                      <div className="font-bold text-slate-900">{r.postman}</div>
                      <div className="font-mono text-xs text-slate-600">{r.digipin}</div>
                      <div className="text-xs text-slate-600">{r.district}</div>
                      <div className="pt-1">
                        <span className="font-semibold">Needs: </span>
                        {r.needs.join(", ")}
                      </div>
                      <div>
                        <span className="font-semibold">Severity: </span>
                        <span
                          className={
                            r.severity === "critical"
                              ? "text-red-700 font-semibold"
                              : r.severity === "medium"
                              ? "text-orange-700"
                              : "text-green-700"
                          }
                        >
                          {r.severity}
                        </span>
                      </div>
                      {assignment && (
                        <div className="mt-2 rounded border border-slate-200 bg-slate-50 p-2 text-xs">
                          <div className="font-semibold text-slate-900">Dispatch</div>
                          <div>{assignment.action}</div>
                          {assignment.poName && (
                            <div className="mt-0.5 text-slate-600">
                              From {assignment.poName}
                              {assignment.distanceKm !== null
                                ? ` · ${assignment.distanceKm} km`
                                : ""}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </Popup>
                </CircleMarker>
              );
            })}
          </MapContainer>
        )}
      </div>
    </div>
  );
}
