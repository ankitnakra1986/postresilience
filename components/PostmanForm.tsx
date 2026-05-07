"use client";

import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import Link from "next/link";
import {
  encodeDigiPin,
  formatDigiPin,
  inferKeralaDistrict,
  isValidDigiPin,
} from "@/lib/digipin";
import { haversineKm } from "@/lib/dispatch";
import postOfficesData from "@/data/post-offices.json";

type Need = "food" | "medicine" | "cash" | "evacuation";
type Severity = "medium" | "critical";
type SubmitState = "idle" | "submitting" | "success" | "error";
type GeoState = "idle" | "locating" | "ok" | "error";
type VoiceState = "idle" | "listening" | "processing" | "error";

const NEED_OPTIONS: { value: Need; label: string; emoji: string }[] = [
  { value: "food", label: "FOOD", emoji: "🍚" },
  { value: "medicine", label: "MEDICINE", emoji: "💊" },
  { value: "cash", label: "CASH", emoji: "💵" },
  { value: "evacuation", label: "EVACUATION", emoji: "🚨" },
];

// Demo presets — used as a GPS fallback when the device is offline / on HTTP.
// Coords match seed data clusters in /data/reports.json so the SDMA map lights
// up in the right districts when a demo report is dropped.
const DEMO_PRESETS: {
  label: string;
  name: string;
  lat: number;
  lng: number;
}[] = [
  { label: "Irinjalakuda, Thrissur", name: "Rajan K", lat: 10.345, lng: 76.215 },
  { label: "Ernakulam Town",          name: "Pradeep M", lat: 9.9816, lng: 76.2998 },
  { label: "Chalakudy, Thrissur",     name: "Babu T",  lat: 10.302, lng: 76.336 },
];

const POSTMAN_KEY = "postresilience.postman.name";
const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "true";

// SpeechRecognition isn't standardised in lib.dom yet — minimal local types
// so we don't lean on `any` and TS strict mode stays happy.
type SpeechResultEvent = {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
};
type SpeechErrorEvent = { error?: string };
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onstart: ((e: Event) => void) | null;
  onend: ((e: Event) => void) | null;
  onresult: ((e: SpeechResultEvent) => void) | null;
  onerror: ((e: SpeechErrorEvent) => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

// Build a human label like "Irinjalakuda, Thrissur" from coordinates by
// finding the nearest known PO. Falls back to district-only / coords.
function describeLocation(lat: number, lng: number): string {
  const district = inferKeralaDistrict(lat, lng);

  let nearest: { name: string; km: number } | null = null;
  for (const po of postOfficesData as { name: string; lat: number; lng: number }[]) {
    const km = haversineKm([lat, lng], [po.lat, po.lng]);
    if (!nearest || km < nearest.km) nearest = { name: po.name, km };
  }

  // Strip generic suffixes so labels read like place names, not org names.
  const placeName = nearest
    ? nearest.name.replace(/\s+(Head PO|SO)$/i, "")
    : null;

  if (district === "Other") {
    if (placeName && nearest && nearest.km < 50) return placeName;
    return `${lat.toFixed(3)}°N, ${lng.toFixed(3)}°E`;
  }

  if (placeName && nearest && nearest.km < 25) return `${placeName}, ${district}`;
  return district;
}

export default function PostmanForm() {
  // Identity (compact, captured once)
  const [postman, setPostman] = useState("");
  const [postmanLocked, setPostmanLocked] = useState(false);

  // Location
  const [digipin, setDigipin] = useState("");
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [placeLabel, setPlaceLabel] = useState("");
  const [geoState, setGeoState] = useState<GeoState>("idle");
  const [geoMsg, setGeoMsg] = useState("");
  const [insecureContext, setInsecureContext] = useState(false);
  const [locationConfirmed, setLocationConfirmed] = useState(false);
  const autoLocateRanRef = useRef(false);

  // Needs + severity
  const [needs, setNeeds] = useState<Need[]>([]);
  const [severity, setSeverity] = useState<Severity | null>(null);

  // Optional / "Add more"
  const [addMoreOpen, setAddMoreOpen] = useState(false);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const [routeBlocked, setRouteBlocked] = useState(false);

  // Voice
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [voiceTranscript, setVoiceTranscript] = useState("");
  const [voiceError, setVoiceError] = useState("");
  const [voiceLocationHint, setVoiceLocationHint] = useState("");
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const gotResultRef = useRef(false);

  // Submit
  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const [errorMsg, setErrorMsg] = useState("");

  const digipinValid = digipin.length === 0 || isValidDigiPin(digipin);

  // ── Mount: hydrate stored postman, detect insecure context + voice support,
  //          fire silent geolocation.
  useEffect(() => {
    if (typeof window === "undefined") return;

    const stored = window.localStorage.getItem(POSTMAN_KEY);
    if (stored && stored.trim()) {
      setPostman(stored.trim());
      setPostmanLocked(true);
    }

    const isLocal =
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1";
    const secure = window.isSecureContext || isLocal;
    setInsecureContext(!secure);

    setVoiceSupported(getSpeechRecognitionCtor() !== null);

    // Fire GPS once on mount, but only if context allows it and not in demo mode.
    // In demo mode, skip auto-GPS so device location (e.g. Ghaziabad) doesn't
    // appear instead of the Kerala scenario presets.
    if (!autoLocateRanRef.current && secure && "geolocation" in navigator && !DEMO_MODE) {
      autoLocateRanRef.current = true;
      runGeolocation();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Photo preview lifecycle.
  useEffect(() => {
    if (!photoFile) {
      setPhotoPreview(null);
      return;
    }
    const url = URL.createObjectURL(photoFile);
    setPhotoPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photoFile]);

  // Cleanup any in-flight recognition on unmount.
  useEffect(() => {
    return () => {
      try {
        recognitionRef.current?.abort();
      } catch {
        /* no-op */
      }
    };
  }, []);

  // ── Postman name (captured once, locked to a header chip)
  const lockPostman = () => {
    const name = postman.trim();
    if (!name) return;
    setPostman(name);
    window.localStorage.setItem(POSTMAN_KEY, name);
    setPostmanLocked(true);
  };
  const unlockPostman = () => setPostmanLocked(false);

  // ── Location helpers
  function runGeolocation() {
    setGeoState("locating");
    setGeoMsg("");
    setLocationConfirmed(false);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        try {
          const pin = encodeDigiPin(latitude, longitude);
          setDigipin(pin);
          setCoords({ lat: latitude, lng: longitude });
          setPlaceLabel(describeLocation(latitude, longitude));
          setGeoState("ok");
          setGeoMsg("");
        } catch (err) {
          setGeoState("error");
          setGeoMsg(
            err instanceof Error
              ? err.message
              : "Location is outside DigiPin coverage"
          );
        }
      },
      (err) => {
        setGeoState("error");
        if (err.code === err.PERMISSION_DENIED) {
          setGeoMsg("Location permission denied");
        } else if (err.code === err.POSITION_UNAVAILABLE) {
          setGeoMsg("Could not determine position");
        } else if (err.code === err.TIMEOUT) {
          setGeoMsg("GPS timed out");
        } else {
          setGeoMsg(err.message || "Location lookup failed");
        }
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
    );
  }

  const pickDemoLocation = (preset: (typeof DEMO_PRESETS)[number]) => {
    try {
      const pin = encodeDigiPin(preset.lat, preset.lng);
      setDigipin(pin);
      setCoords({ lat: preset.lat, lng: preset.lng });
      setPlaceLabel(preset.label);
      setGeoState("ok");
      setGeoMsg("");
      setLocationConfirmed(false);
      if (!postman.trim()) {
        setPostman(preset.name);
        window.localStorage.setItem(POSTMAN_KEY, preset.name);
        setPostmanLocked(true);
      }
    } catch (err) {
      setGeoState("error");
      setGeoMsg(err instanceof Error ? err.message : "Could not encode location");
    }
  };

  const handleManualDigipin = (e: ChangeEvent<HTMLInputElement>) => {
    const formatted = formatDigiPin(e.target.value);
    setDigipin(formatted);
    setCoords(null);
    setPlaceLabel("");
    setLocationConfirmed(false);
    if (formatted.length === 0) {
      setGeoState("error");
    } else if (isValidDigiPin(formatted)) {
      setGeoState("ok");
      setLocationConfirmed(true); // typed pins are an explicit act — auto-confirm
    }
  };

  const confirmLocation = () => setLocationConfirmed(true);
  const editLocation = () => setLocationConfirmed(false);

  // ── Needs + severity
  const toggleNeed = (n: Need) => {
    setNeeds((prev) =>
      prev.includes(n) ? prev.filter((x) => x !== n) : [...prev, n]
    );
  };

  // ── Optional section actions
  const openCamera = () => photoInputRef.current?.click();

  const handlePhotoChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    setPhotoFile(file);
  };

  const removePhoto = () => {
    setPhotoFile(null);
    if (photoInputRef.current) photoInputRef.current.value = "";
  };

  // ── Voice input
  const startVoice = async () => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;

    setVoiceError("");
    setVoiceTranscript("");
    gotResultRef.current = false;

    const rec = new Ctor();
    rec.lang = "hi-IN";
    rec.continuous = false;
    rec.interimResults = false;

    rec.onstart = () => setVoiceState("listening");

    rec.onresult = async (e: SpeechResultEvent) => {
      gotResultRef.current = true;
      const transcript = e.results?.[0]?.[0]?.transcript ?? "";
      setVoiceTranscript(transcript);
      setVoiceState("processing");

      try {
        const res = await fetch("/api/voice-extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transcript }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          needs?: unknown;
          severity?: unknown;
          location_hint?: unknown;
        };

        if (Array.isArray(data.needs)) {
          const valid = data.needs
            .map((n) => String(n).toLowerCase())
            .filter((n): n is Need =>
              ["food", "medicine", "cash", "evacuation"].includes(n)
            );
          if (valid.length > 0) setNeeds(valid);
        }

        if (data.severity === "critical" || data.severity === "medium") {
          setSeverity(data.severity);
        }

        if (
          typeof data.location_hint === "string" &&
          data.location_hint.trim()
        ) {
          setVoiceLocationHint(data.location_hint.trim());
        }

        setVoiceState("idle");
      } catch (err) {
        console.warn("Voice extract failed:", err);
        setVoiceState("error");
        setVoiceError("Could not understand. Tap to try again.");
      }
    };

    rec.onerror = (e: SpeechErrorEvent) => {
      setVoiceState("error");
      const code = e.error;
      if (code === "no-speech") setVoiceError("Didn't hear anything. Try again.");
      else if (code === "not-allowed") setVoiceError("Mic permission denied.");
      else setVoiceError("Voice error. Tap to retry.");
    };

    rec.onend = () => {
      if (!gotResultRef.current && voiceState === "listening") {
        setVoiceState("idle");
      }
    };

    recognitionRef.current = rec;
    try {
      rec.start();
    } catch (err) {
      console.warn("Could not start recognition:", err);
      setVoiceState("error");
      setVoiceError("Mic unavailable.");
    }
  };

  const stopVoice = () => {
    try {
      recognitionRef.current?.stop();
    } catch {
      /* no-op */
    }
    setVoiceState("idle");
  };

  // ── Submit
  const resetForm = () => {
    setNeeds([]);
    setSeverity(null);
    setRouteBlocked(false);
    setPhotoFile(null);
    if (photoInputRef.current) photoInputRef.current.value = "";
    setVoiceTranscript("");
    setVoiceLocationHint("");
    setVoiceError("");
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErrorMsg("");

    const name = postman.trim();
    if (!name) {
      setErrorMsg("Set your name first");
      return;
    }
    if (!postmanLocked) {
      setPostmanLocked(true);
      window.localStorage.setItem(POSTMAN_KEY, name);
    }

    const trimmedPin = digipin.trim().toUpperCase();
    if (!trimmedPin || !isValidDigiPin(trimmedPin)) {
      setErrorMsg("Location not set — tap Get my location or pick a demo");
      return;
    }

    if (!routeBlocked && needs.length === 0) {
      setErrorMsg("Tap at least one need");
      return;
    }
    if (!routeBlocked && !severity) {
      setErrorMsg("Tap how bad it is");
      return;
    }

    setSubmitState("submitting");

    // Route-blocked is a coverage gap, not a needs request — collapse to the
    // existing "blocked" pattern downstream consumers (api/reports + dispatch)
    // already understand. Severity is forced critical so SDMA notices.
    const submittedNeeds: string[] = routeBlocked ? ["blocked"] : needs;
    const submittedSeverity: Severity = routeBlocked
      ? "critical"
      : (severity as Severity);

    try {
      const res = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          postman: name,
          digipin: trimmedPin,
          // Extras below are accepted-but-ignored by the existing API; sent
          // so the request body matches the brief's schema for any downstream
          // consumer that might want them later.
          lat: coords?.lat,
          lng: coords?.lng,
          needs: submittedNeeds,
          severity: submittedSeverity,
          blocked: routeBlocked,
          timestamp: new Date().toISOString(),
          photoFlag: photoFile !== null,
          photoFilename: photoFile?.name ?? null,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || `Submit failed (${res.status})`);
      }

      console.log("Report saved:", data);
      setSubmitState("success");
      resetForm();
      setTimeout(() => setSubmitState("idle"), 3500);
    } catch (err) {
      console.error("PostmanForm submit error:", err);
      setSubmitState("error");
      setErrorMsg(err instanceof Error ? err.message : "Something went wrong");
    }
  };

  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-4">
      <div className="mx-auto max-w-md">
        {/* Header */}
        <header className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-red-600 text-sm font-bold text-white">
              IP
            </div>
            <span className="text-base font-bold text-slate-900">
              PostResilience
            </span>
          </div>
          {postmanLocked ? (
            <div className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1">
              <div className="flex h-5 w-5 items-center justify-center rounded-full bg-red-600 text-[9px] font-bold text-white">
                {postman.charAt(0).toUpperCase()}
              </div>
              <span className="text-xs font-medium text-slate-800">
                {postman}
              </span>
              <button
                type="button"
                onClick={unlockPostman}
                className="ml-0.5 text-[10px] text-slate-400 underline hover:text-slate-700"
              >
                change
              </button>
            </div>
          ) : (
            <Link
              href="/dashboard"
              className="text-[11px] font-medium text-slate-500 hover:text-slate-800"
            >
              SDMA →
            </Link>
          )}
        </header>

        {/* Status banners */}
        {submitState === "success" && (
          <div className="mb-3 rounded-lg border border-green-300 bg-green-50 px-4 py-3 text-sm font-semibold text-green-800">
            ✓ Report submitted
            {DEMO_MODE ? " (demo mode — not saved)" : ""}
          </div>
        )}
        {errorMsg && (
          <div className="mb-3 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm font-medium text-red-800">
            ⚠ {errorMsg}
          </div>
        )}

        <form
          onSubmit={handleSubmit}
          className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
        >
          {/* One-time name capture */}
          {!postmanLocked && (
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Your name
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  inputMode="text"
                  autoComplete="name"
                  placeholder="e.g. Rajan K"
                  value={postman}
                  onChange={(e) => setPostman(e.target.value)}
                  onBlur={lockPostman}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      lockPostman();
                    }
                  }}
                  className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-base text-slate-900 placeholder:text-slate-400 focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-200"
                />
                <button
                  type="button"
                  onClick={lockPostman}
                  disabled={!postman.trim()}
                  className="shrink-0 rounded-lg bg-slate-900 px-3 py-2.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
                >
                  Save
                </button>
              </div>
            </div>
          )}

          {/* 1 — LOCATION */}
          <section className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              1. Where you are
            </p>

            {geoState === "locating" && (
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-red-500 align-middle" />{" "}
                Locating…
              </div>
            )}

            {geoState === "ok" && !locationConfirmed && (
              <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-4">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-emerald-700">
                  📍 You are at
                </div>
                <div className="mt-1 text-lg font-bold text-slate-900">
                  {placeLabel || "Location set"}
                </div>
                <div className="mt-0.5 font-mono text-[11px] text-slate-500">
                  {digipin}
                </div>
                {voiceLocationHint && (
                  <div className="mt-2 inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                    🎤 also heard: {voiceLocationHint}
                  </div>
                )}
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={confirmLocation}
                    className="flex-1 rounded-lg bg-emerald-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700"
                  >
                    ✓ Confirm
                  </button>
                  <button
                    type="button"
                    onClick={runGeolocation}
                    className="rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    🔄
                  </button>
                </div>
              </div>
            )}

            {geoState === "ok" && locationConfirmed && (
              <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-slate-900">
                    ✓ {placeLabel || "Location set"}
                  </div>
                  <div className="font-mono text-[11px] text-slate-500">
                    {digipin}
                  </div>
                  {voiceLocationHint && (
                    <div className="mt-1 inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800">
                      🎤 {voiceLocationHint}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={editLocation}
                  className="ml-3 shrink-0 text-[11px] font-medium text-slate-500 underline hover:text-slate-800"
                >
                  edit
                </button>
              </div>
            )}

            {(geoState === "error" || geoState === "idle") && (
              <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-3">
                <p className="text-xs text-slate-600">
                  {insecureContext
                    ? "GPS blocked on HTTP. Pick a demo location below or type a DigiPin."
                    : geoState === "error"
                    ? `GPS unavailable${geoMsg ? ` — ${geoMsg}` : ""}. Pick a demo location or type a DigiPin.`
                    : "Pick a demo location or type a DigiPin."}
                </p>
                <button
                  type="button"
                  onClick={runGeolocation}
                  disabled={insecureContext}
                  className="w-full rounded-lg bg-slate-900 px-3 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
                >
                  📍 Try GPS again
                </button>

                <div className="grid grid-cols-1 gap-1.5 pt-1">
                  {DEMO_PRESETS.map((p) => (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => pickDemoLocation(p)}
                      className="flex items-center justify-between rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-left text-xs font-medium text-slate-700 hover:border-red-400 hover:bg-red-50 hover:text-red-700"
                    >
                      <span>📌 {p.label}</span>
                      <span className="font-mono text-[10px] text-slate-400">
                        {p.name}
                      </span>
                    </button>
                  ))}
                </div>

                <input
                  type="text"
                  inputMode="text"
                  autoComplete="off"
                  placeholder="Or type DigiPin — M3F-K9C-72L8"
                  maxLength={12}
                  value={digipin}
                  onChange={handleManualDigipin}
                  className={`block w-full rounded-lg border px-3 py-2.5 text-sm font-mono uppercase tracking-wider text-slate-900 placeholder:text-slate-400 placeholder:font-sans placeholder:tracking-normal focus:outline-none focus:ring-2 ${
                    digipinValid
                      ? "border-slate-300 bg-white focus:border-red-500 focus:ring-red-200"
                      : "border-red-400 bg-red-50 focus:border-red-500 focus:ring-red-200"
                  }`}
                />
              </div>
            )}
          </section>

          {/* 2 — NEEDS */}
          <section>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
              2. What is needed
            </p>
            <div className="grid grid-cols-2 gap-2">
              {NEED_OPTIONS.map((opt) => {
                const active = needs.includes(opt.value);
                return (
                  <button
                    key={opt.value}
                    type="button"
                    disabled={routeBlocked}
                    onClick={() => toggleNeed(opt.value)}
                    aria-pressed={active}
                    className={`flex flex-col items-center justify-center gap-1 rounded-xl border-2 px-3 py-5 text-sm font-bold uppercase tracking-wide transition disabled:cursor-not-allowed disabled:opacity-40 ${
                      active
                        ? "border-red-600 bg-red-600 text-white shadow-md"
                        : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50"
                    }`}
                  >
                    <span className="text-2xl leading-none">{opt.emoji}</span>
                    <span>{opt.label}</span>
                  </button>
                );
              })}
            </div>
          </section>

          {/* 3 — SEVERITY */}
          <section>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
              3. How bad is it
            </p>
            <div className="space-y-2">
              <button
                type="button"
                disabled={routeBlocked}
                onClick={() => setSeverity("medium")}
                aria-pressed={severity === "medium"}
                className={`flex w-full items-center gap-3 rounded-xl border-2 px-4 py-4 text-left transition disabled:cursor-not-allowed disabled:opacity-40 ${
                  severity === "medium"
                    ? "border-amber-500 bg-amber-50"
                    : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50"
                }`}
              >
                <span className="text-2xl">⚠️</span>
                <span className="text-sm font-semibold text-slate-900">
                  People need help — not urgent
                </span>
              </button>
              <button
                type="button"
                disabled={routeBlocked}
                onClick={() => setSeverity("critical")}
                aria-pressed={severity === "critical"}
                className={`flex w-full items-center gap-3 rounded-xl border-2 px-4 py-4 text-left transition disabled:cursor-not-allowed disabled:opacity-40 ${
                  severity === "critical"
                    ? "border-red-600 bg-red-50"
                    : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50"
                }`}
              >
                <span className="text-2xl">🔴</span>
                <span className="text-sm font-semibold text-slate-900">
                  Lives at risk — act now
                </span>
              </button>
            </div>
          </section>

          {/* 4 — OPTIONAL */}
          <section>
            <button
              type="button"
              onClick={() => setAddMoreOpen((v) => !v)}
              className="flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-slate-800"
            >
              <span>{addMoreOpen ? "▾" : "▸"}</span>
              <span>{addMoreOpen ? "Hide extras" : "Add more +"}</span>
            </button>

            {addMoreOpen && (
              <div className="mt-2 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
                {/* Photo */}
                <input
                  ref={photoInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={handlePhotoChange}
                  style={{
                    position: "absolute",
                    left: -9999,
                    width: 1,
                    height: 1,
                    opacity: 0,
                  }}
                />
                {!photoFile ? (
                  <button
                    type="button"
                    onClick={openCamera}
                    className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
                  >
                    <span>📷</span>
                    <span>Add photo</span>
                  </button>
                ) : (
                  <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
                    {photoPreview && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={photoPreview}
                        alt="Field report preview"
                        className="h-32 w-full object-cover"
                      />
                    )}
                    <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                      <div className="min-w-0 truncate font-medium text-slate-700">
                        📷 {photoFile.name}
                      </div>
                      <button
                        type="button"
                        onClick={removePhoto}
                        className="shrink-0 rounded border border-red-300 bg-white px-2 py-1 font-medium text-red-700 hover:bg-red-50"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                )}

                {/* Route blocked toggle */}
                <button
                  type="button"
                  role="switch"
                  aria-checked={routeBlocked}
                  onClick={() => setRouteBlocked((v) => !v)}
                  className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-3 text-left transition ${
                    routeBlocked
                      ? "border-amber-500 bg-amber-50"
                      : "border-slate-300 bg-white hover:bg-slate-100"
                  }`}
                >
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                    <span>🚫</span>
                    <span>Cannot reach this area</span>
                  </div>
                  <span
                    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition ${
                      routeBlocked ? "bg-amber-500" : "bg-slate-300"
                    }`}
                    aria-hidden="true"
                  >
                    <span
                      className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
                        routeBlocked ? "translate-x-5" : "translate-x-0.5"
                      }`}
                    />
                  </span>
                </button>
                {routeBlocked && (
                  <p className="rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
                    Submitting as coverage gap — needs &amp; severity disabled.
                  </p>
                )}

                {/* Voice — silently hidden when unsupported */}
                {voiceSupported && (
                  <div className="space-y-1.5">
                    <button
                      type="button"
                      onClick={
                        voiceState === "listening" ? stopVoice : startVoice
                      }
                      disabled={voiceState === "processing"}
                      className={`flex w-full items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-semibold transition ${
                        voiceState === "listening"
                          ? "border-red-600 bg-red-600 text-white"
                          : voiceState === "processing"
                          ? "border-slate-300 bg-slate-100 text-slate-500"
                          : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
                      }`}
                    >
                      <span className="text-lg">🎤</span>
                      <span>
                        {voiceState === "listening" && "Listening… tap to stop"}
                        {voiceState === "processing" && "Understanding…"}
                        {voiceState === "idle" && "Speak instead (Hindi / English)"}
                        {voiceState === "error" && "Try again"}
                      </span>
                    </button>

                    {voiceTranscript && (
                      <p className="rounded border border-slate-200 bg-white px-2 py-1.5 text-[11px] italic text-slate-600">
                        “{voiceTranscript}”
                      </p>
                    )}
                    {voiceError && voiceState === "error" && (
                      <p className="text-[11px] font-medium text-red-700">
                        {voiceError}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>

          {/* SUBMIT */}
          <button
            type="submit"
            disabled={submitState === "submitting"}
            className="w-full rounded-xl bg-red-600 px-4 py-4 text-base font-bold uppercase tracking-wide text-white shadow-md transition hover:bg-red-700 active:bg-red-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitState === "submitting" ? "Submitting…" : "Submit Report"}
          </button>

          {DEMO_MODE && (
            <p className="-mt-2 text-center text-[11px] text-slate-400">
              Demo mode — not saved to live feed
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
