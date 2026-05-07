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

const NEED_OPTIONS: { value: Need; label: string; hindi: string; emoji: string }[] = [
  { value: "food",       label: "FOOD",       hindi: "खाना",   emoji: "🍚" },
  { value: "medicine",   label: "MEDICINE",   hindi: "दवाई",   emoji: "💊" },
  { value: "cash",       label: "CASH",       hindi: "पैसे",   emoji: "💵" },
  { value: "evacuation", label: "EVACUATION", hindi: "बचाओ",  emoji: "🚨" },
];

type Zone = {
  id: string;
  label: string;
  district: "Thrissur" | "Ernakulam";
  lat: number;
  lng: number;
};

const ZONES: Zone[] = [
  { id: "irinjalakuda",    label: "Irinjalakuda",    district: "Thrissur",  lat: 10.345,  lng: 76.215  },
  { id: "chalakudy",       label: "Chalakudy",       district: "Thrissur",  lat: 10.302,  lng: 76.336  },
  { id: "north-thrissur",  label: "North Thrissur",  district: "Thrissur",  lat: 10.620,  lng: 76.220  },
  { id: "east-thrissur",   label: "East Thrissur",   district: "Thrissur",  lat: 10.530,  lng: 76.380  },
  { id: "ernakulam-town",  label: "Ernakulam Town",  district: "Ernakulam", lat: 9.9816,  lng: 76.2998 },
  { id: "aluva",           label: "Aluva",           district: "Ernakulam", lat: 10.108,  lng: 76.354  },
  { id: "south-ernakulam", label: "South Ernakulam", district: "Ernakulam", lat: 9.890,   lng: 76.320  },
  { id: "west-ernakulam",  label: "West Ernakulam",  district: "Ernakulam", lat: 10.025,  lng: 76.170  },
];

const FALLBACK_LAT = 9.9816;
const FALLBACK_LNG = 76.2998;

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

// ─── SpeechRecognition shim ───────────────────────────────────────────────────
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

// Devanagari + romanized + English disaster signal check.
// Covers all major disaster types a postman might speak:
// flood, earthquake, fire, heat wave, cyclone, landslide, storm.
function transcriptIsCritical(t: string): boolean {
  const signals = [
    // Devanagari — disaster types
    "भूकंप", "बाढ़", "बाढ", "लू", "आग", "तूफान", "सुनामी",
    "भूस्खलन", "चक्रवात",
    // Devanagari — distress
    "मर", "जान", "खतरा", "बचाओ", "फंसे", "फंसा", "डूब",
    "पानी", "इमरजेंसी", "मदद", "निकालो", "संकट", "तुरंत", "आपदा",
    // Romanized Hindi — disaster types
    "bhukamp", "bhoochal",  // earthquake
    "baadh", "badh",        // flood
    "toofan", "tufan",      // storm
    "aandhi",               // dust storm
    "aag",                  // fire
    "lu", "loo",            // heat wave
    "tsunami", "sunami",
    "chakravat", "cyclone",
    "bhuskhalan",           // landslide
    // Romanized Hindi — distress
    "bachao", "bachaao", "khatra", "jaan", "doob", "paani",
    "pani", "nikaalo", "sankat",
    // English — disaster types
    "flood", "earthquake", "fire", "heat wave", "heatwave",
    "cyclone", "tsunami", "landslide", "storm", "tornado",
    // English — distress
    "trapped", "rescue", "evacuation", "emergency",
    "dying", "danger", "stranded", "urgent", "critical",
  ];
  const lower = t.toLowerCase();
  return signals.some((k) => lower.includes(k));
}

// ─── Component ───────────────────────────────────────────────────────────────
export default function PostmanForm() {
  const [screen, setScreen] = useState<Screen>(1);
  const [voiceSupported, setVoiceSupported] = useState(true);

  const [postman, setPostman] = useState("");
  const [postmanLocked, setPostmanLocked] = useState(false);
  const [nameDraft, setNameDraft] = useState("");

  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [voiceTranscript, setVoiceTranscript] = useState("");
  const [voiceError, setVoiceError] = useState("");
  const [voiceApiError, setVoiceApiError] = useState("");
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const gotResultRef = useRef(false);

  const [needs, setNeeds] = useState<Need[]>([]);
  const [severity, setSeverity] = useState<Severity | null>(null);
  const [zoneId, setZoneId] = useState<string | null>(null);
  const [routeBlocked, setRouteBlocked] = useState(false);


  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  // Screen 2: whether full needs/severity editor is expanded (only matters
  // when voice already pre-filled them — default collapsed to show zone hero)
  const [editOpen, setEditOpen] = useState(false);

  const [confirmation, setConfirmation] = useState<{
    zone: Zone | null;
    zoneName: string;
    needs: Need[];
    severity: Severity;
    digipin: string;
    blocked: boolean;
  } | null>(null);
  const selectedZone = zoneId
    ? ZONES.find((z) => z.id === zoneId) ?? null
    : null;

  const canSubmit =
    !!postman.trim() &&
    !!zoneId &&
    (routeBlocked || (needs.length > 0 && severity !== null));

  // ── Mount
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

  // ── Cleanup recognition on unmount
  useEffect(() => {
    return () => {
      try { recognitionRef.current?.abort(); } catch { /* no-op */ }
    };
  }, []);


  // ── Postman name
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
    if (e.key === "Enter") { e.preventDefault(); lockPostman(); }
  };

  // ── Voice
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
        const serverSeverity =
          data.severity === "critical" || data.severity === "medium"
            ? data.severity
            : null;
        if (serverSeverity) {
          setSeverity(
            serverSeverity === "medium" && transcriptIsCritical(transcript)
              ? "critical"
              : serverSeverity
          );
        } else if (transcriptIsCritical(transcript)) {
          setSeverity("critical");
        }
        setVoiceState("idle");
      } catch (err) {
        console.warn("Voice extract failed:", err);
        setVoiceState("idle");
        setVoiceApiError("Voice unavailable, please select needs manually");
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
    try { recognitionRef.current?.stop(); } catch { /* no-op */ }
    setVoiceState("idle");
  };

  // ── Form
  const toggleNeed = (n: Need) => {
    setNeeds((prev) =>
      prev.includes(n) ? prev.filter((x) => x !== n) : [...prev, n]
    );
  };

  const pickZone = (id: string) => {
    setZoneId(id);
    setSubmitError("");
  };

  // ── Submit
  const handleSubmit = async (e?: FormEvent) => {
    e?.preventDefault();
    setSubmitError("");
    if (!canSubmit) return;

    if (!selectedZone) return;

    const { digipin, lat, lng } = safeEncode(selectedZone.lat, selectedZone.lng);
    const zoneName = `${selectedZone.label}, ${selectedZone.district}`;

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
        zoneName,
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
    setEditOpen(false);
    setScreen(voiceSupported ? 1 : 2);
  };

  const goToDashboard = () => {
    if (typeof window !== "undefined") {
      window.location.href = "/dashboard";
    }
  };

  // ──────────────────────────────────────────────────────────────────────────
  // SCREEN 1 — SPEAK
  // ──────────────────────────────────────────────────────────────────────────
  if (screen === 1) {
    const showNameInput = !postmanLocked;
    const continueDisabled = !postman.trim() && !nameDraft.trim();

    return (
      <div className="flex min-h-[100dvh] flex-col bg-[#0f172a] px-4 pt-4 text-slate-100">
        {/* Header */}
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-red-600 text-sm font-bold text-white">
              IP
            </div>
            <span className="text-base font-bold">PostResilience</span>
          </div>
          {postmanLocked && (
            <button
              type="button"
              onClick={unlockPostman}
              style={{ WebkitTapHighlightColor: "transparent" }}
              className="flex touch-manipulation items-center gap-1.5 rounded-full border border-slate-700 bg-slate-800/60 px-2.5 py-1"
            >
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-red-600 text-[9px] font-bold text-white">
                {postman.charAt(0).toUpperCase()}
              </span>
              <span className="text-xs font-medium text-slate-100">{postman}</span>
            </button>
          )}
        </header>

        {/* Name capture */}
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
                className="block w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-3 text-base text-slate-100 placeholder:text-slate-500 focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-500/40"
              />
              <button
                type="button"
                onClick={lockPostman}
                disabled={!nameDraft.trim()}
                style={{ WebkitTapHighlightColor: "transparent" }}
                className="shrink-0 touch-manipulation rounded-lg bg-red-600 px-4 py-3 text-sm font-semibold text-white active:bg-red-700 disabled:opacity-40"
              >
                Save
              </button>
            </div>
          </div>
        )}

        {/* Mic — fills remaining space */}
        <div className="flex flex-1 flex-col items-center justify-center gap-0 py-6">
          <button
            type="button"
            onClick={voiceState === "listening" ? stopVoice : startVoice}
            disabled={showNameInput || voiceState === "processing" || !voiceSupported}
            aria-label="Start voice capture"
            style={{ WebkitTapHighlightColor: "transparent" }}
            className={`relative flex h-20 w-20 touch-manipulation items-center justify-center rounded-full text-3xl shadow-2xl transition-opacity disabled:cursor-not-allowed disabled:opacity-40 ${
              voiceState === "listening"
                ? "bg-red-500"
                : voiceState === "processing"
                ? "bg-slate-700"
                : "bg-red-600 active:opacity-80"
            }`}
          >
            {voiceState === "processing" ? (
              <span className="inline-block h-7 w-7 animate-spin rounded-full border-4 border-slate-300 border-t-transparent" />
            ) : (
              <span aria-hidden>🎤</span>
            )}
            {voiceState === "listening" && (
              <span
                className="absolute inset-0 animate-ping rounded-full bg-red-500/50"
                aria-hidden
              />
            )}
          </button>

          <div className="mt-5 text-center">
            <div className="text-xl font-bold">
              {voiceState === "idle" && "बोलिए / Speak"}
              {voiceState === "listening" && "सुन रहे हैं… / Listening…"}
              {voiceState === "processing" && "समझ रहे हैं… / Understanding…"}
              {voiceState === "error" && "फिर कोशिश करें / Try again"}
            </div>
            <div className="mt-1 text-xs text-slate-400">
              {voiceState === "listening" ? "Tap to stop" : "Hindi · English · Malayalam"}
            </div>
            {voiceError && voiceState === "error" && (
              <p className="mt-2 text-xs font-medium text-red-300">{voiceError}</p>
            )}
            {voiceApiError && (
              <div className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-200">
                {voiceApiError}
              </div>
            )}
          </div>

          {/* Voice extraction output chips */}
          {(needs.length > 0 || severity || voiceTranscript) && (
            <div className="mt-6 w-full max-w-xs space-y-3">
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
                    {severity === "critical" ? "🔴 Critical" : "⚠️ Not urgent"}
                  </span>
                </div>
              )}
              {voiceTranscript && (
                <p className="text-center text-[11px] italic text-slate-400">
                  &ldquo;{voiceTranscript}&rdquo;
                </p>
              )}
            </div>
          )}
        </div>

        {/* CTA — pinned to bottom with safe-area inset */}
        <div
          className="space-y-3 pb-4"
          style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
        >
          <button
            type="button"
            onClick={() => {
              if (!postmanLocked) lockPostman();
              setScreen(2);
            }}
            disabled={continueDisabled}
            style={{ WebkitTapHighlightColor: "transparent" }}
            className="w-full touch-manipulation rounded-xl bg-red-600 px-4 py-4 text-base font-bold text-white shadow-lg transition-opacity active:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
          >
            आगे बढ़ें → / Continue
          </button>
          <button
            type="button"
            onClick={() => {
              if (!postmanLocked && nameDraft.trim()) lockPostman();
              setScreen(2);
            }}
            style={{ WebkitTapHighlightColor: "transparent" }}
            className="block w-full touch-manipulation text-center text-sm font-medium text-slate-400 underline-offset-2 active:text-slate-200"
          >
            No mic? Type instead →
          </button>
        </div>
      </div>
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // SCREEN 3 — SUBMITTED
  // ──────────────────────────────────────────────────────────────────────────
  if (screen === 3 && confirmation) {
    return (
      <div
        className="flex min-h-[100dvh] flex-col bg-[#059669] px-4 pt-8 text-white"
        style={{ paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}
      >
        <div className="mx-auto flex w-full max-w-md flex-1 flex-col">
          {/* Hero */}
          <div className="flex flex-1 flex-col items-center justify-center text-center">
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
                📍 {confirmation.zoneName}
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
                  {confirmation.severity === "critical" ? "Critical" : "Not urgent"}
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

          </div>

          {/* Actions */}
          <div className="space-y-2 pt-4">
            <button
              type="button"
              onClick={goToDashboard}
              style={{ WebkitTapHighlightColor: "transparent" }}
              className="w-full touch-manipulation rounded-xl bg-white px-4 py-4 text-base font-bold text-slate-900 shadow-md active:opacity-90"
            >
              View SDMA Dashboard →
            </button>
            <button
              type="button"
              onClick={handleStartOver}
              style={{ WebkitTapHighlightColor: "transparent" }}
              className="w-full touch-manipulation rounded-xl border-2 border-white/80 bg-transparent px-4 py-3.5 text-sm font-semibold text-white active:bg-white/10"
            >
              Submit another report
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // SCREEN 2 — WHERE + WHAT
  // ──────────────────────────────────────────────────────────────────────────
  const grouped: Record<"Thrissur" | "Ernakulam", Zone[]> = {
    Thrissur: ZONES.filter((z) => z.district === "Thrissur"),
    Ernakulam: ZONES.filter((z) => z.district === "Ernakulam"),
  };

  // True when voice already captured needs/severity on Screen 1.
  // In this mode Screen 2 shows a compact summary + zone as the hero,
  // collapsing the full need buttons unless the postman taps "Edit".
  const voicePrefilled = (needs.length > 0 || severity !== null) && !routeBlocked;

  return (
    <div
      className="flex min-h-[100dvh] flex-col bg-slate-50 overscroll-contain"
      style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
    >
      <div className="mx-auto w-full max-w-md flex-1 px-4 pt-4">
        {/* Top bar */}
        <header className="mb-3 flex items-center justify-between">
          <button
            type="button"
            onClick={() => setScreen(voiceSupported ? 1 : 2)}
            disabled={!voiceSupported}
            aria-label="Back"
            style={{ WebkitTapHighlightColor: "transparent" }}
            className="flex h-10 w-10 touch-manipulation items-center justify-center rounded-full border border-slate-200 bg-white text-lg text-slate-700 active:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-30"
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
              <span className="text-xs font-medium text-slate-800">{postman}</span>
            </div>
          ) : (
            <span className="h-10 w-10" aria-hidden />
          )}
        </header>

        {/* Inline name capture */}
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
                className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-3 text-base text-slate-900 placeholder:text-slate-400 focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-200"
              />
              <button
                type="button"
                onClick={lockPostman}
                disabled={!nameDraft.trim()}
                style={{ WebkitTapHighlightColor: "transparent" }}
                className="shrink-0 touch-manipulation rounded-lg bg-slate-900 px-4 py-3 text-sm font-semibold text-white active:bg-slate-800 disabled:opacity-50"
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

        <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">

          {/* ── VOICE-PREFILLED MODE: compact summary + zone as hero ── */}
          {voicePrefilled && !editOpen ? (
            <>
              {/* Voice summary card */}
              <section className="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-2">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700">
                        🎤 आवाज़ से मिला
                      </span>
                    </div>
                    {/* Need chips */}
                    <div className="flex flex-wrap gap-1.5">
                      {needs.map((n) => (
                        <span
                          key={n}
                          className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-bold uppercase tracking-wide ${NEED_CHIP_LIGHT[n]}`}
                        >
                          {NEED_OPTIONS.find((o) => o.value === n)?.emoji}{" "}
                          {NEED_OPTIONS.find((o) => o.value === n)?.hindi}
                        </span>
                      ))}
                      {needs.length === 0 && (
                        <span className="text-xs text-emerald-600">
                          No needs — tap Edit to add
                        </span>
                      )}
                    </div>
                    {/* Severity chip */}
                    {severity && (
                      <span
                        className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-bold ${
                          severity === "critical"
                            ? "border-red-300 bg-red-50 text-red-700"
                            : "border-amber-300 bg-amber-50 text-amber-700"
                        }`}
                      >
                        {severity === "critical" ? "🔴 जान खतरे में" : "⚠️ मदद चाहिए"}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setEditOpen(true)}
                    style={{ WebkitTapHighlightColor: "transparent" }}
                    className="shrink-0 touch-manipulation rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-600 active:bg-slate-100"
                  >
                    Edit
                  </button>
                </div>
              </section>

              {/* Zone picker — HERO in voice mode */}
              <section>
                <p className="mb-2 text-sm font-bold text-slate-800">
                  📍 अपना इलाका चुनें
                </p>
                <p className="mb-3 text-[11px] text-slate-500">
                  Select your area — tap once to confirm
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
                            style={{ WebkitTapHighlightColor: "transparent" }}
                            className={`flex min-h-[56px] w-full touch-manipulation items-center justify-between gap-3 rounded-xl border-2 px-4 text-left transition-colors ${
                              active
                                ? "border-red-600 bg-red-50"
                                : "border-slate-200 bg-white active:bg-red-50"
                            }`}
                          >
                            <span className={`text-base font-bold ${active ? "text-red-700" : "text-slate-900"}`}>
                              {zone.label}
                            </span>
                            {active ? (
                              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-red-600 text-white text-sm font-bold">✓</span>
                            ) : (
                              <span className="h-7 w-7 rounded-full border-2 border-slate-200" aria-hidden />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </section>
            </>
          ) : (
            <>
              {/* ── MANUAL / EDIT MODE: full needs + severity + zone ── */}

              {/* Back to compact if voice was pre-filled */}
              {voicePrefilled && editOpen && (
                <button
                  type="button"
                  onClick={() => setEditOpen(false)}
                  style={{ WebkitTapHighlightColor: "transparent" }}
                  className="flex touch-manipulation items-center gap-1 text-xs font-semibold text-slate-400 active:text-slate-600"
                >
                  ← आवाज़ वाले जवाब पर वापस जाएं
                </button>
              )}

              {/* Needs */}
              <section>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
                  क्या चाहिए / What is needed
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
                        style={{ WebkitTapHighlightColor: "transparent" }}
                        className={`flex min-h-[80px] touch-manipulation flex-col items-center justify-center gap-0.5 rounded-xl border-2 px-3 py-3 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                          active
                            ? "border-red-600 bg-red-600 text-white"
                            : "border-slate-200 bg-white text-slate-700 active:bg-slate-50"
                        }`}
                      >
                        <span className="text-2xl leading-none">{opt.emoji}</span>
                        <span className="text-base font-bold leading-tight">{opt.hindi}</span>
                        <span className={`text-[10px] font-semibold uppercase tracking-wide ${active ? "text-red-100" : "text-slate-400"}`}>{opt.label}</span>
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
                    style={{ WebkitTapHighlightColor: "transparent" }}
                    className={`flex min-h-[60px] w-full touch-manipulation items-center gap-3 rounded-xl border-2 px-4 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                      severity === "medium"
                        ? "border-amber-500 bg-amber-50"
                        : "border-slate-200 bg-white active:bg-slate-50"
                    }`}
                  >
                    <span className="text-2xl">⚠️</span>
                    <div>
                      <div className="text-sm font-bold text-slate-900">मदद चाहिए</div>
                      <div className="text-[11px] text-slate-500">People need help — not urgent</div>
                    </div>
                  </button>
                  <button
                    type="button"
                    disabled={routeBlocked}
                    onClick={() => setSeverity("critical")}
                    aria-pressed={severity === "critical"}
                    style={{ WebkitTapHighlightColor: "transparent" }}
                    className={`flex min-h-[60px] w-full touch-manipulation items-center gap-3 rounded-xl border-2 px-4 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                      severity === "critical"
                        ? "border-red-600 bg-red-50"
                        : "border-slate-200 bg-white active:bg-slate-50"
                    }`}
                  >
                    <span className="text-2xl">🔴</span>
                    <div>
                      <div className="text-sm font-bold text-slate-900">जान खतरे में है</div>
                      <div className="text-[11px] text-slate-500">Lives at risk — act now</div>
                    </div>
                  </button>
                </div>
              </section>

              {/* Zone picker */}
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
                            style={{ WebkitTapHighlightColor: "transparent" }}
                            className={`flex min-h-[52px] w-full touch-manipulation items-center justify-between gap-3 rounded-xl border-2 px-4 text-left transition-colors ${
                              active
                                ? "border-red-600 bg-red-50"
                                : "border-slate-200 bg-white active:bg-slate-50"
                            }`}
                          >
                            <span className={`text-sm font-semibold ${active ? "text-red-700" : "text-slate-900"}`}>
                              {zone.label}
                            </span>
                            {active && <span className="text-base text-red-600" aria-hidden>✓</span>}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </section>
            </>
          )}

          {/* Route-blocked toggle — always visible */}
          <section>
            <button
              type="button"
              role="switch"
              aria-checked={routeBlocked}
              onClick={() => setRouteBlocked((v) => !v)}
              style={{ WebkitTapHighlightColor: "transparent" }}
              className={`flex min-h-[56px] w-full touch-manipulation items-center justify-between gap-3 rounded-xl border-2 px-4 py-3 text-left transition-colors ${
                routeBlocked
                  ? "border-amber-500 bg-amber-50"
                  : "border-slate-200 bg-white active:bg-slate-50"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-xl">🚫</span>
                <div>
                  <div className="text-sm font-bold text-slate-900">रास्ता बंद है</div>
                  <div className="text-[11px] text-slate-500">Cannot reach this area</div>
                </div>
              </div>
              <span
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                  routeBlocked ? "bg-amber-500" : "bg-slate-300"
                }`}
                aria-hidden="true"
              >
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                    routeBlocked ? "translate-x-5" : "translate-x-0.5"
                  }`}
                />
              </span>
            </button>
            {routeBlocked && (
              <p className="mt-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] font-medium text-amber-800">
                रास्ता बंद — coverage gap के रूप में submit होगा।
              </p>
            )}
          </section>

          {/* Submit */}
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit || submitting}
            style={{ WebkitTapHighlightColor: "transparent" }}
            className="flex min-h-[56px] w-full touch-manipulation items-center justify-center rounded-xl bg-red-600 px-4 text-base font-bold text-white shadow-md transition-opacity active:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? "Submitting…" : "रिपोर्ट भेजें / Submit Report"}
          </button>
        </div>

        {/* bottom spacer so content clears the safe-area */}
        <div className="h-4" />
      </div>
    </div>
  );
}
