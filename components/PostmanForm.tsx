"use client";

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { encodeDigiPin } from "@/lib/digipin";

// ─── Types ───────────────────────────────────────────────────────────────────
type Need = "food" | "medicine" | "cash" | "evacuation";
type Severity = "medium" | "critical";
type Screen = 1 | 2 | 3;
type VoiceState = "idle" | "listening" | "processing" | "error";

// ─── Constants ───────────────────────────────────────────────────────────────
const POSTMAN_KEY = "postresilience.postman.name";

const NEED_OPTIONS: { value: Need; label: string; emoji: string }[] = [
  { value: "food", label: "FOOD", emoji: "🍚" },
  { value: "medicine", label: "MEDICINE", emoji: "💊" },
  { value: "cash", label: "CASH", emoji: "💵" },
  { value: "evacuation", label: "EVACUATION", emoji: "🚨" },
];

type Zone = {
  id: string;
  label: string;
  district: "Thrissur" | "Ernakulam";
  lat: number;
  lng: number;
};

const ZONES: Zone[] = [
  { id: "irinjalakuda",    label: "Irinjalakuda",    district: "Thrissur",  lat: 10.345,  lng: 76.215 },
  { id: "chalakudy",       label: "Chalakudy",       district: "Thrissur",  lat: 10.302,  lng: 76.336 },
  { id: "north-thrissur",  label: "North Thrissur",  district: "Thrissur",  lat: 10.620,  lng: 76.220 },
  { id: "east-thrissur",   label: "East Thrissur",   district: "Thrissur",  lat: 10.530,  lng: 76.380 },
  { id: "ernakulam-town",  label: "Ernakulam Town",  district: "Ernakulam", lat: 9.9816,  lng: 76.2998 },
  { id: "aluva",           label: "Aluva",           district: "Ernakulam", lat: 10.108,  lng: 76.354 },
  { id: "south-ernakulam", label: "South Ernakulam", district: "Ernakulam", lat: 9.890,   lng: 76.320 },
  { id: "west-ernakulam",  label: "West Ernakulam",  district: "Ernakulam", lat: 10.025,  lng: 76.170 },
];

// Fallback Kerala coords (Ernakulam Town) — used if encodeDigiPin somehow
// throws on the chosen zone. Within DIGIPIN bounds by construction.
const FALLBACK_LAT = 9.9816;
const FALLBACK_LNG = 76.2998;

// Voice-chip colour palette per the brief: red=evac, orange=med/cash, green=food
const NEED_CHIP_DARK: Record<Need, string> = {
  evacuation: "border-red-400/60 bg-red-500/20 text-red-100",
  medicine:   "border-orange-400/60 bg-orange-500/20 text-orange-100",
  cash:       "border-orange-400/60 bg-orange-500/20 text-orange-100",
  food:       "border-emerald-400/60 bg-emerald-500/20 text-emerald-100",
};
const NEED_CHIP_LIGHT: Record<Need, string> = {
  evacuation: "border-red-300 bg-red-50 text-red-700",
  medicine:   "border-orange-300 bg-orange-50 text-orange-700",
  cash:       "border-orange-300 bg-orange-50 text-orange-700",
  food:       "border-emerald-300 bg-emerald-50 text-emerald-700",
};

// ─── SpeechRecognition shim (lib.dom doesn't ship types yet) ─────────────────
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

// Encode a zone to a DigiPin, falling back to a known-valid Kerala point if
// the algorithm ever rejects the input. Keeps the demo from dead-ending.
function safeEncode(lat: number, lng: number): {
  digipin: string;
  lat: number;
  lng: number;
} {
  try {
    return { digipin: encodeDigiPin(lat, lng), lat, lng };
  } catch {
    return {
      digipin: encodeDigiPin(FALLBACK_LAT, FALLBACK_LNG),
      lat: FALLBACK_LAT,
      lng: FALLBACK_LNG,
    };
  }
}

// ─── Component ───────────────────────────────────────────────────────────────
export default function PostmanForm() {
  // Screen orchestration
  const [screen, setScreen] = useState<Screen>(1);
  const [voiceSupported, setVoiceSupported] = useState(true);

  // Postman identity (sticky in localStorage)
  const [postman, setPostman] = useState("");
  const [postmanLocked, setPostmanLocked] = useState(false);
  const [nameDraft, setNameDraft] = useState("");

  // Voice
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [voiceTranscript, setVoiceTranscript] = useState("");
  const [voiceError, setVoiceError] = useState("");
  const [voiceApiError, setVoiceApiError] = useState("");
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const gotResultRef = useRef(false);

  // Form state
  const [needs, setNeeds] = useState<Need[]>([]);
  const [severity, setSeverity] = useState<Severity | null>(null);
  const [zoneId, setZoneId] = useState<string | null>(null);
  const [routeBlocked, setRouteBlocked] = useState(false);

  // Submit
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  // Screen 3 confirmation snapshot (frozen at submit time so subsequent
  // resets don't blank the success card).
  const [confirmation, setConfirmation] = useState<{
    zone: Zone;
    needs: Need[];
    severity: Severity;
    digipin: string;
    blocked: boolean;
  } | null>(null);
  const [countdown, setCountdown] = useState(10);

  const selectedZone = zoneId
    ? ZONES.find((z) => z.id === zoneId) ?? null
    : null;

  // ── Mount: hydrate postman name + detect voice support
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(POSTMAN_KEY);
    if (stored && stored.trim()) {
      setPostman(stored.trim());
      setPostmanLocked(true);
    }
    const supported = getSpeechRecognitionCtor() !== null;
    setVoiceSupported(supported);
    if (!supported) setScreen(2);
  }, []);

  // ── Cleanup any in-flight recognition on unmount
  useEffect(() => {
    return () => {
      try {
        recognitionRef.current?.abort();
      } catch {
        /* no-op */
      }
    };
  }, []);

  // ── Screen 3 countdown + auto-return to Screen 1
  useEffect(() => {
    if (screen !== 3) return;
    setCountdown(10);
    const interval = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          clearInterval(interval);
          handleStartOver();
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
    // handleStartOver is stable across renders for our purposes; intentionally
    // omitted from deps so the timer isn't reset by unrelated state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);

  // ── Postman name lock
  const lockPostman = () => {
    const name = (postmanLocked ? postman : nameDraft).trim();
    if (!name) return;
    setPostman(name);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(POSTMAN_KEY, name);
    }
    setPostmanLocked(true);
  };

  const unlockPostman = () => {
    setNameDraft(postman);
    setPostmanLocked(false);
  };

  const onNameKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      lockPostman();
    }
  };

  // ── Voice capture
  const startVoice = () => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;

    setVoiceError("");
    setVoiceTranscript("");
    setVoiceApiError("");
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
        setVoiceState("idle");
      } catch (err) {
        console.warn("Voice extract failed:", err);
        setVoiceState("idle");
        setVoiceApiError(
          "Voice unavailable, please select needs manually"
        );
      }
    };

    rec.onerror = (e: SpeechErrorEvent) => {
      setVoiceState("error");
      const code = e.error;
      if (code === "no-speech") setVoiceError("Didn't hear anything.");
      else if (code === "not-allowed") setVoiceError("Mic permission denied.");
      else setVoiceError("Voice error.");
    };

    rec.onend = () => {
      if (!gotResultRef.current) {
        setVoiceState((s) => (s === "listening" ? "idle" : s));
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

  // ── Form interactions
  const toggleNeed = (n: Need) => {
    setNeeds((prev) =>
      prev.includes(n) ? prev.filter((x) => x !== n) : [...prev, n]
    );
  };

  const pickZone = (id: string) => {
    setZoneId(id);
    setSubmitError("");
  };

  const canSubmit =
    !!postman.trim() &&
    !!zoneId &&
    (routeBlocked || (needs.length > 0 && severity !== null));

  const handleSubmit = async (e?: FormEvent) => {
    e?.preventDefault();
    setSubmitError("");
    if (!canSubmit || !selectedZone) return;

    const { digipin, lat, lng } = safeEncode(
      selectedZone.lat,
      selectedZone.lng
    );
    const submittedNeeds: string[] = routeBlocked ? ["blocked"] : needs;
    const submittedSeverity: Severity = routeBlocked
      ? "critical"
      : (severity as Severity);

    setSubmitting(true);
    try {
      const res = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          postman: postman.trim(),
          digipin,
          lat,
          lng,
          needs: submittedNeeds,
          severity: submittedSeverity,
          blocked: routeBlocked,
          timestamp: new Date().toISOString(),
          photoFlag: false,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `Submit failed (${res.status})`);
      }
      setConfirmation({
        zone: selectedZone,
        needs: routeBlocked ? [] : needs,
        severity: submittedSeverity,
        digipin,
        blocked: routeBlocked,
      });
      setScreen(3);
    } catch (err) {
      console.error("PostmanForm submit error:", err);
      setSubmitError(
        err instanceof Error ? err.message : "Could not submit. Try again."
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleStartOver = () => {
    setNeeds([]);
    setSeverity(null);
    setZoneId(null);
    setRouteBlocked(false);
    setVoiceTranscript("");
    setVoiceError("");
    setVoiceApiError("");
    setSubmitError("");
    setConfirmation(null);
    setScreen(voiceSupported ? 1 : 2);
  };

  const goToDashboard = () => {
    if (typeof window !== "undefined") {
      window.location.href = "/dashboard";
    }
  };

  // ──────────────────────────────────────────────────────────────────────────
  // RENDER
  // ──────────────────────────────────────────────────────────────────────────

  // ─── SCREEN 1 — SPEAK ────────────────────────────────────────────────────
  if (screen === 1) {
    const showNameInput = !postmanLocked;
    const continueDisabled = !postman.trim() && !nameDraft.trim();

    return (
      <div className="min-h-screen bg-[#0f172a] px-4 py-4 text-slate-100">
        <div className="mx-auto flex min-h-[calc(100vh-2rem)] max-w-md flex-col">
          {/* Header */}
          <header className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-red-600 text-sm font-bold text-white">
                IP
              </div>
              <span className="text-base font-bold">PostResilience</span>
            </div>
            {postmanLocked ? (
              <button
                type="button"
                onClick={unlockPostman}
                className="flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-800/60 px-2.5 py-1"
              >
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-red-600 text-[9px] font-bold text-white">
                  {postman.charAt(0).toUpperCase()}
                </span>
                <span className="text-xs font-medium text-slate-100">
                  {postman}
                </span>
              </button>
            ) : null}
          </header>

          {/* Name capture (inline, blocks the mic until set) */}
          {showNameInput && (
            <div className="mt-6 rounded-xl border border-slate-700 bg-slate-800/40 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Your name
              </p>
              <div className="mt-1.5 flex gap-2">
                <input
                  type="text"
                  inputMode="text"
                  autoComplete="name"
                  placeholder="e.g. Rajan K"
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onBlur={lockPostman}
                  onKeyDown={onNameKey}
                  className="block w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2.5 text-base text-slate-100 placeholder:text-slate-500 focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-500/40"
                />
                <button
                  type="button"
                  onClick={lockPostman}
                  disabled={!nameDraft.trim()}
                  className="shrink-0 rounded-lg bg-red-600 px-3 py-2.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-40"
                >
                  Save
                </button>
              </div>
            </div>
          )}

          {/* Mic — centred in the remaining space */}
          <div className="flex flex-1 flex-col items-center justify-center py-8">
            <button
              type="button"
              onClick={
                voiceState === "listening" ? stopVoice : startVoice
              }
              disabled={
                showNameInput ||
                voiceState === "processing" ||
                !voiceSupported
              }
              aria-label="Start voice capture"
              className={`relative flex h-20 w-20 items-center justify-center rounded-full text-3xl shadow-2xl transition disabled:cursor-not-allowed disabled:opacity-40 ${
                voiceState === "listening"
                  ? "animate-pulse bg-red-500"
                  : voiceState === "processing"
                  ? "bg-slate-700"
                  : "bg-red-600 hover:bg-red-500 active:scale-95"
              }`}
            >
              {voiceState === "processing" ? (
                <span className="inline-block h-7 w-7 animate-spin rounded-full border-4 border-slate-300 border-t-transparent" />
              ) : (
                <span aria-hidden>🎤</span>
              )}
              {voiceState === "listening" && (
                <span className="absolute inset-0 -z-10 animate-ping rounded-full bg-red-500/40" />
              )}
            </button>

            <div className="mt-5 text-center">
              <div className="text-xl font-bold">
                {voiceState === "idle" && "बोलिए / Speak"}
                {voiceState === "listening" &&
                  "सुन रहे हैं… / Listening…"}
                {voiceState === "processing" &&
                  "समझ रहे हैं… / Understanding…"}
                {voiceState === "error" &&
                  "फिर कोशिश करें / Try again"}
              </div>
              <div className="mt-1 text-xs text-slate-400">
                {voiceState === "listening"
                  ? "Tap to stop"
                  : "Hindi · English · Malayalam"}
              </div>
              {voiceError && voiceState === "error" && (
                <div className="mt-2 text-xs font-medium text-red-300">
                  {voiceError}
                </div>
              )}
              {voiceApiError && (
                <div className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-200">
                  {voiceApiError}
                </div>
              )}
            </div>

            {/* Extracted output */}
            {(needs.length > 0 || severity || voiceTranscript) && (
              <div className="mt-6 w-full space-y-3">
                {needs.length > 0 && (
                  <div className="flex flex-wrap justify-center gap-1.5">
                    {needs.map((n) => (
                      <span
                        key={n}
                        className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider ${NEED_CHIP_DARK[n]}`}
                      >
                        {n}
                      </span>
                    ))}
                  </div>
                )}
                {severity && (
                  <div className="flex justify-center">
                    <span
                      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider ${
                        severity === "critical"
                          ? "border-red-400/60 bg-red-500/20 text-red-100"
                          : "border-amber-400/60 bg-amber-500/20 text-amber-100"
                      }`}
                    >
                      {severity === "critical"
                        ? "🔴 Critical"
                        : "⚠️ Not urgent"}
                    </span>
                  </div>
                )}
                {voiceTranscript && (
                  <p className="text-center text-[11px] italic text-slate-400">
                    “{voiceTranscript}”
                  </p>
                )}
              </div>
            )}
          </div>

          {/* CTAs pinned at the bottom */}
          <div className="space-y-3 pb-2">
            <button
              type="button"
              onClick={() => {
                if (!postmanLocked) lockPostman();
                setScreen(2);
              }}
              disabled={continueDisabled}
              className="w-full rounded-xl bg-red-600 px-4 py-4 text-base font-bold text-white shadow-lg transition hover:bg-red-500 active:bg-red-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              आगे बढ़ें → / Continue
            </button>
            <button
              type="button"
              onClick={() => {
                if (!postmanLocked && nameDraft.trim()) lockPostman();
                setScreen(2);
              }}
              className="block w-full text-center text-xs font-medium text-slate-400 underline-offset-2 hover:text-slate-200 hover:underline"
            >
              No mic? Type instead →
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── SCREEN 3 — SUBMITTED ────────────────────────────────────────────────
  if (screen === 3 && confirmation) {
    return (
      <div className="min-h-screen bg-[#059669] px-4 py-8">
        <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-md flex-col">
          {/* Hero */}
          <div className="flex flex-1 flex-col items-center justify-center text-center text-white">
            <div className="flex h-16 w-16 items-center justify-center rounded-full border-2 border-white/40 bg-white/10">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-10 w-10"
                aria-hidden
              >
                <polyline points="5 12 10 17 19 7" />
              </svg>
            </div>

            <h1 className="mt-6 text-3xl font-black">रिपोर्ट मिल गई!</h1>
            <p className="mt-2 text-sm font-medium text-emerald-50">
              Help is on the way · मदद आ रही है
            </p>

            {/* Summary card */}
            <div className="mt-6 w-full rounded-xl bg-white p-4 text-left shadow-xl">
              <div className="text-sm font-semibold text-slate-900">
                📍 {confirmation.zone.label}, {confirmation.zone.district}
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  Needs
                </span>
                {confirmation.blocked ? (
                  <span className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-amber-700">
                    🚫 Route blocked
                  </span>
                ) : confirmation.needs.length === 0 ? (
                  <span className="text-[11px] text-slate-400">—</span>
                ) : (
                  confirmation.needs.map((n) => (
                    <span
                      key={n}
                      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${NEED_CHIP_LIGHT[n]}`}
                    >
                      {n}
                    </span>
                  ))
                )}
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  Severity
                </span>
                <span
                  className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${
                    confirmation.severity === "critical"
                      ? "border-red-300 bg-red-50 text-red-700"
                      : "border-amber-300 bg-amber-50 text-amber-700"
                  }`}
                >
                  {confirmation.severity === "critical"
                    ? "Critical"
                    : "Not urgent"}
                </span>
              </div>

              <div className="mt-3 flex items-center gap-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  DigiPin
                </span>
                <span className="font-mono text-xs font-semibold text-slate-700">
                  {confirmation.digipin}
                </span>
              </div>
            </div>

            <p className="mt-4 text-xs text-emerald-50/80">
              Returning to form in {countdown}s…
            </p>
          </div>

          {/* Actions */}
          <div className="space-y-2 pt-6">
            <button
              type="button"
              onClick={goToDashboard}
              className="w-full rounded-xl bg-white px-4 py-4 text-base font-bold text-slate-900 shadow-md transition hover:bg-slate-50 active:scale-[0.99]"
            >
              View SDMA Dashboard →
            </button>
            <button
              type="button"
              onClick={handleStartOver}
              className="w-full rounded-xl border-2 border-white/80 bg-transparent px-4 py-3.5 text-sm font-semibold text-white transition hover:bg-white/10"
            >
              Submit another report
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── SCREEN 2 — WHERE + WHAT ─────────────────────────────────────────────
  const grouped: Record<"Thrissur" | "Ernakulam", Zone[]> = {
    Thrissur: ZONES.filter((z) => z.district === "Thrissur"),
    Ernakulam: ZONES.filter((z) => z.district === "Ernakulam"),
  };

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-4">
      <div className="mx-auto max-w-md">
        {/* Top bar */}
        <header className="mb-3 flex items-center justify-between">
          <button
            type="button"
            onClick={() => setScreen(voiceSupported ? 1 : 2)}
            disabled={!voiceSupported}
            aria-label="Back"
            className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-30"
          >
            ←
          </button>
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            2 of 3
          </span>
          {postmanLocked ? (
            <div className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-red-600 text-[9px] font-bold text-white">
                {postman.charAt(0).toUpperCase()}
              </span>
              <span className="text-xs font-medium text-slate-800">
                {postman}
              </span>
            </div>
          ) : (
            <span className="h-9 w-9" aria-hidden />
          )}
        </header>

        {/* Inline name capture (only if we're stranded on Screen 2 with no name) */}
        {!postmanLocked && (
          <div className="mb-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              Your name
            </p>
            <div className="mt-1.5 flex gap-2">
              <input
                type="text"
                inputMode="text"
                autoComplete="name"
                placeholder="e.g. Rajan K"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={lockPostman}
                onKeyDown={onNameKey}
                className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-base text-slate-900 placeholder:text-slate-400 focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-200"
              />
              <button
                type="button"
                onClick={lockPostman}
                disabled={!nameDraft.trim()}
                className="shrink-0 rounded-lg bg-slate-900 px-3 py-2.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </div>
        )}

        {submitError && (
          <div className="mb-3 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm font-medium text-red-800">
            ⚠ {submitError}
          </div>
        )}

        <form
          onSubmit={handleSubmit}
          className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
        >
          {/* A — Needs */}
          <section>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
              What is needed
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
                    className={`flex min-h-[80px] flex-col items-center justify-center gap-1 rounded-xl border-2 px-3 py-4 text-sm font-bold uppercase tracking-wide transition disabled:cursor-not-allowed disabled:opacity-40 ${
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

            <div className="mt-3 space-y-2">
              <button
                type="button"
                disabled={routeBlocked}
                onClick={() => setSeverity("medium")}
                aria-pressed={severity === "medium"}
                className={`flex min-h-[56px] w-full items-center gap-3 rounded-xl border-2 px-4 py-3 text-left transition disabled:cursor-not-allowed disabled:opacity-40 ${
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
                className={`flex min-h-[56px] w-full items-center gap-3 rounded-xl border-2 px-4 py-3 text-left transition disabled:cursor-not-allowed disabled:opacity-40 ${
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

          {/* B — Zone picker */}
          <section>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
              अपना इलाका चुनें / Select your area
            </p>

            {(["Thrissur", "Ernakulam"] as const).map((district) => (
              <div key={district} className="mt-2">
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-slate-400">
                  {district}
                </p>
                <div className="space-y-1.5">
                  {grouped[district].map((zone) => {
                    const active = zoneId === zone.id;
                    return (
                      <button
                        key={zone.id}
                        type="button"
                        onClick={() => pickZone(zone.id)}
                        aria-pressed={active}
                        className={`flex min-h-[56px] w-full items-center justify-between gap-3 rounded-xl border-2 px-4 text-left transition ${
                          active
                            ? "border-red-600 bg-red-50"
                            : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50"
                        }`}
                      >
                        <span
                          className={`text-sm font-semibold ${
                            active ? "text-red-700" : "text-slate-900"
                          }`}
                        >
                          {zone.label}
                        </span>
                        {active && (
                          <span className="text-base text-red-600">✓</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </section>

          {/* C — Route-blocked toggle */}
          <section>
            <button
              type="button"
              role="switch"
              aria-checked={routeBlocked}
              onClick={() => setRouteBlocked((v) => !v)}
              className={`flex min-h-[56px] w-full items-center justify-between gap-3 rounded-xl border-2 px-4 py-3 text-left transition ${
                routeBlocked
                  ? "border-amber-500 bg-amber-50"
                  : "border-slate-200 bg-white hover:bg-slate-50"
              }`}
            >
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                <span className="text-xl">🚫</span>
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
              <p className="mt-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] font-medium text-amber-800">
                Submitting as coverage gap — needs &amp; severity disabled.
              </p>
            )}
          </section>

          {/* Submit */}
          <button
            type="submit"
            disabled={!canSubmit || submitting}
            className="flex min-h-[56px] w-full items-center justify-center rounded-xl bg-red-600 px-4 text-base font-bold text-white shadow-md transition hover:bg-red-700 active:bg-red-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? "Submitting…" : "रिपोर्ट भेजें / Submit Report"}
          </button>
        </form>
      </div>
    </div>
  );
}
