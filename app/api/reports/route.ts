import { NextRequest, NextResponse } from "next/server";
import { decodeDigiPin, inferKeralaDistrict, isValidDigiPin } from "@/lib/digipin";
import type { Report } from "@/lib/dispatch";
import seedReports from "@/data/reports.json";

export const runtime = "nodejs";
// Force dynamic so GET reflects in-memory state, not a build-time snapshot.
export const dynamic = "force-dynamic";

// In-memory store, seeded from the bundled JSON on cold start.
// Trade-off: when the Vercel lambda goes cold (~5 min idle), submissions reset
// to the canonical seed. For a hackathon demo this is desirable — every demo
// run starts from a known state.
const reports: Report[] = [...(seedReports as Report[])];

// "blocked" is a meta-need raised by the postman when the route itself is
// impassable — surfaces as a coverage gap (yellow diamond) on the SDMA map.
const VALID_NEEDS = new Set(["food", "medicine", "cash", "evacuation", "blocked", "other"]);
const VALID_SEVERITY = new Set(["low", "medium", "critical"]);

const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "true";

// Auto-infer severity when the postman doesn't supply one. The field stays in
// the data model (used by seed data + downstream agent reasoning) but is no
// longer in the postman UI — postmen don't have time to triage at the door.
function inferSeverity(needs: string[]): "low" | "medium" | "critical" {
  if (
    needs.includes("evacuation") ||
    needs.includes("medicine") ||
    needs.includes("blocked")
  )
    return "critical";
  if (needs.includes("cash")) return "medium";
  return "low";
}

export async function GET() {
  return NextResponse.json(reports);
}

type IncomingReport = {
  digipin?: unknown;
  needs?: unknown;
  severity?: unknown;
  photoFlag?: unknown;
  postman?: unknown;
};

export async function POST(req: NextRequest) {
  let body: IncomingReport;
  try {
    body = (await req.json()) as IncomingReport;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const digipinRaw = typeof body.digipin === "string" ? body.digipin.trim() : "";
  if (!digipinRaw) {
    return NextResponse.json({ error: "DigiPin is required" }, { status: 400 });
  }
  if (!isValidDigiPin(digipinRaw)) {
    return NextResponse.json(
      { error: "DigiPin format invalid. Expected 10 chars (e.g. M3F-K9C-72L8)." },
      { status: 400 }
    );
  }

  const needsArr = Array.isArray(body.needs) ? body.needs : [];
  const needs = needsArr.filter(
    (n): n is string => typeof n === "string" && VALID_NEEDS.has(n)
  );
  if (needs.length === 0) {
    return NextResponse.json({ error: "Select at least one need" }, { status: 400 });
  }

  const severityRaw = typeof body.severity === "string" ? body.severity : "";
  const severity = VALID_SEVERITY.has(severityRaw) ? severityRaw : inferSeverity(needs);

  let lat: number;
  let lng: number;
  try {
    const decoded = decodeDigiPin(digipinRaw);
    lat = decoded.latitude;
    lng = decoded.longitude;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "DigiPin decode failed" },
      { status: 400 }
    );
  }

  const district = inferKeralaDistrict(lat, lng);
  const photoFlag = body.photoFlag === true;
  const postman =
    typeof body.postman === "string" && body.postman.trim().length > 0
      ? body.postman.trim()
      : "Field Submission";

  const nextId = reports.reduce((m, r) => Math.max(m, r.id ?? 0), 0) + 1;
  const newReport: Report = {
    id: nextId,
    postman,
    digipin: digipinRaw.toUpperCase(),
    lat: Math.round(lat * 1e6) / 1e6,
    lng: Math.round(lng * 1e6) / 1e6,
    needs,
    severity,
    district,
    photoFlag,
  };

  // Demo mode: validate + echo the report back, but don't mutate the live feed.
  // Lets us run the postman form on a projector without polluting the SDMA map
  // with throwaway demo submissions.
  if (DEMO_MODE) {
    return NextResponse.json({ ...newReport, demo: true }, { status: 200 });
  }

  reports.push(newReport);
  return NextResponse.json(newReport, { status: 201 });
}
