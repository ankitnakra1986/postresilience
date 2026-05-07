export type Report = {
  id: number;
  postman: string;
  digipin: string;
  lat: number;
  lng: number;
  needs: string[];
  severity: string;
  district: string;
  photoFlag?: boolean;
};

export type PostOffice = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  district: string;
  status: "operational" | "flooded" | string;
};

export type Service = "evacuation" | "medicine" | "cash" | "food" | "other";

export type DispatchAssignment = {
  reportId: number;
  digipin: string;
  postman: string;
  district: string;
  service: Service;
  poId: string | null;
  poName: string | null;
  distanceKm: number | null;
  action: string;
};

export type DispatchSummary = {
  total: number;
  evacuation: number;
  medicine: number;
  cash: number;
  food: number;
  other: number;
};

// Service packaging priority: highest urgency wins per household.
export function primaryService(needs: string[]): Service {
  if (needs.includes("evacuation")) return "evacuation";
  if (needs.includes("medicine")) return "medicine";
  if (needs.includes("cash")) return "cash";
  if (needs.includes("food")) return "food";
  return "other";
}

// Haversine distance in km — accurate enough for a demo at this scale.
export function haversineKm(a: [number, number], b: [number, number]): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function nearestOperationalPO(
  report: Report,
  pos: PostOffice[]
): { po: PostOffice | null; distanceKm: number | null } {
  const operational = pos.filter((p) => p.status === "operational");
  if (operational.length === 0) return { po: null, distanceKm: null };
  let best: PostOffice = operational[0];
  let bestDist = haversineKm([report.lat, report.lng], [best.lat, best.lng]);
  for (const p of operational.slice(1)) {
    const d = haversineKm([report.lat, report.lng], [p.lat, p.lng]);
    if (d < bestDist) {
      best = p;
      bestDist = d;
    }
  }
  return { po: best, distanceKm: bestDist };
}

export function packageServices(
  reports: Report[],
  pos: PostOffice[]
): DispatchAssignment[] {
  return reports.map((r) => {
    const service = primaryService(r.needs);
    const { po, distanceKm } = nearestOperationalPO(r, pos);
    let action = "";
    switch (service) {
      case "evacuation":
        action = "Raise evacuation flag · notify NDRF";
        break;
      case "medicine":
        action = `Dispatch medicine package from ${po?.name ?? "nearest PO"}`;
        break;
      case "cash":
        action = "Trigger IPPB emergency cash transfer (₹2,000)";
        break;
      case "food":
        action = "Schedule food parcel · next 24hr run";
        break;
      default:
        action = "Field officer follow-up required";
    }
    return {
      reportId: r.id,
      digipin: r.digipin,
      postman: r.postman,
      district: r.district,
      service,
      poId: po?.id ?? null,
      poName: po?.name ?? null,
      distanceKm: distanceKm !== null ? Math.round(distanceKm * 10) / 10 : null,
      action,
    };
  });
}

export function summarize(assignments: DispatchAssignment[]): DispatchSummary {
  const s: DispatchSummary = {
    total: assignments.length,
    evacuation: 0,
    medicine: 0,
    cash: 0,
    food: 0,
    other: 0,
  };
  for (const a of assignments) s[a.service]++;
  return s;
}

export function sdmaBriefLines(s: DispatchSummary): string[] {
  return [
    `Total households flagged: ${s.total}`,
    `Evacuation alerts raised: ${s.evacuation} (NDRF notified)`,
    `Medicine dispatches: ${s.medicine} (via India Post fleet)`,
    `IPPB cash transfers: ${s.cash} (₹2,000 each, processed)`,
    `Food parcels scheduled: ${s.food} (next 24hr)`,
  ];
}
