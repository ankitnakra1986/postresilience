"use client";

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { encodeDigiPin, inferKeralaDistrict } from "@/lib/digipin";

// ─── Types ───────────────────────────────────────────────────────────────────
type Need = "food" | "medicine" | "cash" | "evacuation";
type Severity = "medium" | "critical";
type Screen = 1 | 2 | 3;
type VoiceState = "idle" | "listening" | "processing" | "error";

// ─── Constants ───────────────────────────────────────────────────────────────
const POSTMAN_KEY = "postresilience.postman.name";

type GpsStatus = "idle" | "locating" | "done" | "error";

const NEED_OPTIONS: { value: Need; label: string; hindi: string; emoji: string }[] = [
  { value: "food",       label: "FOOD",       hindi: "खाना",   emoji: "🍚" },
  { value: "medicine",   label: "MEDICINE",   hindi: "दवाई",   emoji: "💊" },
  { value: "cash",       label: "CASH",       hindi: "पैसे",   emoji: "💵" },
  { value: "evacuation", label: "EVACUATION", hindi: "बचाओ",  emoji: "🚨" },
];


const FALLBACK_LAT = 9.9816;
const FALLBACK_LNG = 76.2998;

// Kerala bounding box — demo GPS is clamped here so reports always plot on the Kerala map
const KERALA_BOUNDS = { latMin: 8.2, latMax: 12.8, lngMin: 74.8, lngMax: 77.6 };
function inKerala(lat: number, lng: number) {
  return (
    lat >= KERALA_BOUNDS.latMin && lat <= KERALA_BOUNDS.latMax &&
    lng >= KERALA_BOUNDS.lngMin && lng <= KERALA_BOUNDS.lngMax
  );
}

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

// Client-side needs extraction — runs as a fallback when the API heuristic
// returns empty needs. Two layers:
// 1. Explicit need words ("khane", "paani", "dawai" etc.)
// 2. Disaster-context inference — when a postman says "flood ho gaye" or
//    "garmi se pareshan hai" without naming needs, infer from disaster type.
function clientExtractNeeds(t: string): Need[] {
  const lower = t.toLowerCase();
  const has = (kws: string[]) => kws.some((k) => lower.includes(k));
  const result: Need[] = [];

  // ── Layer 1: explicit need words ────────────────────────────────────────
  if (
    has([
      "khana", "khaana", "khaane", "khane", "khaney",
      "paani", "pani", "paanee", "paany", "paane",
      "water", "food", "ration", "rashan", "raashan",
      "bhojan", "anna", "anaaj", "anaj", "meal",
      "bhukhaa", "bhukha", "hungry", "starving",
      "peena", "piyenge", "khate", "khaate",
      "पानी", "खाना", "खाने", "भोजन", "राशन", "भूखा",
    ])
  ) result.push("food");

  if (
    has([
      "dawai", "dawaai", "dava", "davai", "dawa", "medicine", "medicines",
      "doctor", "ilaaj", "tablet", "injection", "aspatal", "hospital",
      "beemar", "bimar", "patient", "sick", "injured", "hurt", "medical",
      "दवाई", "दवा", "डॉक्टर", "इलाज", "बीमार", "अस्पताल",
    ])
  ) result.push("medicine");

  if (
    has([
      "paisa", "paise", "rupaye", "rupiya", "rupee", "rupees",
      "cash", "money", "funds",
      "पैसा", "पैसे", "रुपये",
    ])
  ) result.push("cash");

  if (
    has([
      "evacuation", "evacuate", "rescue", "trapped", "phanse", "fasaye",
      "fase", "fasna", "phans", "nikaalo", "stranded",
      "bachao", "bachaao", "boat", "naav", "doob", "dooba", "drowning",
      "बचाओ", "निकालो", "फंसे", "डूब", "नाव",
    ])
  ) result.push("evacuation");

  // ── Layer 2: disaster-context inference (only when layer 1 found nothing) ─
  // Postmen describe situations ("flood ho gaye", "garmi se pareshan") not
  // need lists. Infer the most common relief needs for each disaster type.
  if (result.length === 0) {
    if (has(["flood", "floods", "baadh", "baarish", "बाढ़", "बाढ"])) {
      result.push("food", "evacuation");
    } else if (has(["earthquake", "bhukamp", "bhoochal", "भूकंप", "bhoochaal"])) {
      result.push("food", "medicine", "evacuation");
    } else if (has(["garmi", "tapish", "heat wave", "heatwave", "लू"])) {
      result.push("medicine");
    } else if (has(["cyclone", "toofan", "tufan", "aandhi", "storm", "तूफान"])) {
      result.push("food", "evacuation");
    } else if (has(["landslide", "bhuskhalan", "भूस्खलन"])) {
      result.push("evacuation");
    } else if (has([" aag ", " fire ", "आग"])) {
      result.push("evacuation");
    }
  }

  return result;
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
    "bhukamp", "bhoochal",          // earthquake
    "baadh",                        // flood (avoid "badh" — substring of "badhiya")
    "toofan", "tufan",              // storm
    "aandhi",                       // dust storm
    " aag ", "aag hai",             // fire (space-padded to avoid false substrings)
    "garmi", "tapish",              // heat wave (drop "garm" — too short)
    "heat wave", "heatwave",        // heat wave (English)
    "tsunami", "sunami",
    "chakravat", "cyclone",
    "bhuskhalan",                   // landslide
    // Romanized Hindi — distress
    "bachao", "bachaao", "khatra", "doob",
    "paani bhar", "paani aa", "pani bhar", "pani aa", // flood-water specific, not bare "paani"
    "nikaalo", "sankat",
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

/** Demo: postman marks a stable / accessible pocket — drives lime dot on SDMA map. */
function transcriptIndicatesSafeZone(t: string): boolean {
  const lower = t.toLowerCase().normalize("NFC");
  if (/\bसुरक्षित\b/.test(t)) return true;
  if (/\bgreen[\s-]*zone\b/i.test(t) || /\bgreenzone\b/i.test(t)) return true;
  if (
    lower.includes("surakshit") ||
    lower.includes("surakshith") ||
    lower.includes("surakshat") ||
    lower.includes("surkshit")
  ) {
    return true;
  }
  if (/\bsafe\b/i.test(t) && !/\bunsafe\b/i.test(t)) return true;
  if (/\bsecure\b/i.test(t) && !/\binsecure\b/i.test(t)) return true;

  // "theek hai / theek hain / sab theek" — common Hindi for "all is fine/okay"
  if (lower.includes("theek") || lower.includes("thik") || lower.includes("sabkuch theek")) return true;

  // Negation + flood/disaster = safe signal
  // "floods nahin aaye", "flood nahi hai", "not flooded", "no flood"
  const hasFloodWord = /flood/i.test(t) || lower.includes("baadh");
  const hasNegation = /\b(nahin|nahi|nhi|naheen|mat|not|no)\b/i.test(t);
  if (hasFloodWord && hasNegation) return true;

  return false;
}

/** One-line demo narrative: proactive "sense" without pretending full NLP. */
function fieldReadInsight(
  transcript: string,
  needs: Need[],
  severity: Severity | null
): { tone: "routine" | "relay" | "escalate" | "scan" | "safe"; lines: string } | null {
  const trimmed = transcript.trim();
  if (!trimmed) return null;

  if (
    transcriptIndicatesSafeZone(transcript) &&
    !(severity === "critical" || transcriptIsCritical(transcript))
  ) {
    return {
      tone: "safe",
      lines:
        "AI field read: Safe / green-pocket signal — lime dot on SDMA map for routing. · सुरक्षित इलाका",
    };
  }

  const critical = severity === "critical" || transcriptIsCritical(transcript);
  if (critical) {
    return {
      tone: "escalate",
      lines:
        "AI field read: Escalation pattern — route to priority queue. · तत्काल ध्यान दें",
    };
  }
  if (needs.length > 0) {
    return {
      tone: "relay",
      lines:
        "AI field read: Relief cues packaged for SDMA dispatch (keyword + context rules). · राहत संकेत टैग",
    };
  }

  const t = trimmed.toLowerCase();
  const routinePhrase =
    /sab (badhiya|badhiyaa|theek|theekh|acch|achha|achhe)|bahut acch|all good|everything is (fine|ok)|normal routine|koi (dikkat|problem) nahi|no (issue|problem)|har[ea] bhara|hara bhara/i.test(
      t
    );
  if (routinePhrase) {
    return {
      tone: "routine",
      lines:
        "AI field read: Routine / green status — no auto relief match (valuable for proactive heatmaps: \"where we heard all-clear\"). · स्थिति सामान्य",
    };
  }

  return {
    tone: "scan",
    lines:
      "AI field read: No strong relief keyword match — confirm on next screen if anything changed. · पुष्टि करें",
  };
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
  const [showPermTip, setShowPermTip] = useState(false);
  const [showTypeInput, setShowTypeInput] = useState(false);
  const [typeDraft, setTypeDraft] = useState("");
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const gotResultRef = useRef(false);
  // Tracks how many lang fallbacks we've attempted in current session
  const langAttemptRef = useRef(0);

  const [needs, setNeeds] = useState<Need[]>([]);
  const [severity, setSeverity] = useState<Severity | null>(null);
  /** Voice / narrative: reports an accessible pocket — lime marker on dashboard. */
  const [safeZoneReport, setSafeZoneReport] = useState(false);
  const [routeBlocked, setRouteBlocked] = useState(false);

  const [gpsStatus, setGpsStatus] = useState<GpsStatus>("idle");
  const [gpsLat, setGpsLat]       = useState<number | null>(null);
  const [gpsLng, setGpsLng]       = useState<number | null>(null);
  const [gpsDigipin, setGpsDigipin] = useState<string | null>(null);

  const [photoDataUrl, setPhotoDataUrl] = useState<string | null>(null);
  const [photoFileName, setPhotoFileName] = useState<string | null>(null);
  const photoInputRef = useRef<HTMLInputElement | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");


  // Screen 2: whether full needs/severity editor is expanded (only matters
  // when voice already pre-filled them — default collapsed to show zone hero)
  const [editOpen, setEditOpen] = useState(false);

  const [confirmation, setConfirmation] = useState<{
    zoneName: string;
    district: string;
    needs: Need[];
    severity: Severity;
    digipin: string;
    blocked: boolean;
    photoFileName: string | null;
    safeZone: boolean;
  } | null>(null);


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

  // ── GPS — trigger when user reaches Screen 2
  useEffect(() => {
    if (screen !== 2) return;
    if (gpsStatus === "done" || gpsStatus === "locating") return;
    if (!navigator.geolocation) {
      setGpsStatus("error");
      return;
    }
    setGpsStatus("locating");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        // If device is outside Kerala (demo elsewhere), fall back to Ernakulam centre
        const rawLat = pos.coords.latitude;
        const rawLng = pos.coords.longitude;
        const lat = inKerala(rawLat, rawLng) ? rawLat : FALLBACK_LAT;
        const lng = inKerala(rawLat, rawLng) ? rawLng : FALLBACK_LNG;
        try {
          const pin = encodeDigiPin(lat, lng);
          setGpsLat(lat);
          setGpsLng(lng);
          setGpsDigipin(pin);
          setGpsStatus("done");
        } catch {
          setGpsStatus("error");
        }
      },
      () => setGpsStatus("error"),
      { timeout: 10000, maximumAge: 60000, enableHighAccuracy: false }
    );
  }, [screen, gpsStatus]);


  // ── Postman name
  const lockPostman = () => {
    if (postmanLocked) return;
    const name = nameDraft.trim();
    if (!name) return;
    setPostman(name);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(POSTMAN_KEY, name);
    }
    setPostmanLocked(true);
    // Auto-open mic immediately after name is saved so the demo flows
    // without a dead pause. Small delay lets React re-render first (mic
    // button must be enabled before start() is called).
    if (voiceSupported) {
      setTimeout(() => startVoice(), 80);
    }
  };

  const unlockPostman = () => {
    setNameDraft(postman);
    setPostmanLocked(false);
  };

  const onNameKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); lockPostman(); }
  };

  // ── Voice
  // Lang priority: en-IN (works on all Indian iPhones) → en-US fallback.
  // hi-IN requires the user to have Hindi Dictation enabled in iOS Settings
  // and silently fails on most iPhones — avoided as primary.
  // en-IN first: romanizes Hinglish well on most Indian iPhones.
  // hi-IN fallback: pure Devanagari output — client extractor handles it.
  // en-US last resort for venues where en-IN is unsupported.
  const VOICE_LANGS = ["en-IN", "hi-IN", "en-US"] as const;

  const startVoice = () => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;

    // Always abort the previous instance before creating a new one.
    // On iOS, reusing or starting a second session without aborting the first
    // causes the second tap to silently fail (onstart fires, onend fires immediately).
    try { recognitionRef.current?.abort(); } catch { /* no-op */ }
    recognitionRef.current = null;

    setVoiceError("");
    setVoiceTranscript("");
    setVoiceApiError("");
    setShowPermTip(false);
    gotResultRef.current = false;

    const lang = VOICE_LANGS[Math.min(langAttemptRef.current, VOICE_LANGS.length - 1)];

    const rec = new Ctor();
    rec.lang = lang;
    rec.continuous = false;
    rec.interimResults = false;

    rec.onstart = () => {
      // Clear previous attempt's detections so stale state never bleeds
      // into a new recording (e.g. user re-taps mic after a partial result).
      setNeeds([]);
      setSeverity(null);
      setSafeZoneReport(false);
      setVoiceState("listening");
    };

    rec.onresult = async (e: SpeechResultEvent) => {
      gotResultRef.current = true;
      langAttemptRef.current = 0;
      const transcript = e.results?.[0]?.[0]?.transcript ?? "";
      await processTranscript(transcript);
    };

    rec.onerror = (e: SpeechErrorEvent) => {
      const code = e.error;
      if (code === "language-not-supported") {
        // Advance to next fallback lang; user taps mic again
        langAttemptRef.current = Math.min(
          langAttemptRef.current + 1,
          VOICE_LANGS.length - 1
        );
        setVoiceState("idle");
        setVoiceError("Tap mic again to retry.");
        return;
      }
      setVoiceState("error");
      if (code === "no-speech") {
        setVoiceError("Didn't hear anything — tap mic and speak.");
      } else if (code === "not-allowed") {
        // iOS: permission dialog appears AFTER start() fires onend.
        // User must allow mic in the prompt, then tap the button again.
        setShowPermTip(true);
        setVoiceError("Allow mic access, then tap 🎤 again.");
      } else {
        setVoiceError("Voice error — tap mic to retry.");
      }
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
      setVoiceError("Mic unavailable — tap to retry.");
    }
  };

  const stopVoice = () => {
    try { recognitionRef.current?.stop(); } catch { /* no-op */ }
    setVoiceState("idle");
  };

  // Shared pipeline — runs for both real voice and the type-shortcut path.
  const processTranscript = async (transcript: string) => {
    setVoiceTranscript(transcript);
    setNeeds([]);
    setSeverity(null);
    setSafeZoneReport(false);
    setVoiceError("");
    setVoiceApiError("");
    setShowPermTip(false);
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
      let nextNeeds: Need[] = [];
      if (Array.isArray(data.needs)) {
        const valid = data.needs
          .map((n) => String(n).toLowerCase())
          .filter((n): n is Need =>
            ["food", "medicine", "cash", "evacuation"].includes(n)
          );
        nextNeeds = valid.length > 0 ? valid : clientExtractNeeds(transcript);
      } else {
        nextNeeds = clientExtractNeeds(transcript);
      }
      setNeeds(nextNeeds);
      const serverCritical = data.severity === "critical";
      const clientCritical = transcriptIsCritical(transcript);
      const isSafeZone = transcriptIndicatesSafeZone(transcript);
      let nextSeverity: Severity | null = null;
      if (serverCritical || clientCritical) {
        nextSeverity = "critical";
      } else if (nextNeeds.length > 0) {
        nextSeverity = "medium";
      }
      // #region agent log
      fetch('/api/debug-log',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'1ec22d',location:'PostmanForm.tsx:processTranscript',message:'severity decision point',data:{transcript,serverCritical,clientCritical,isSafeZone,nextSeverityBeforeOverride:nextSeverity,serverRawSeverity:data.severity,needsLength:nextNeeds.length},timestamp:Date.now(),hypothesisId:'A-B-C'})}).catch(()=>{});
      // #endregion
      if (isSafeZone) {
        setSafeZoneReport(true);
        // Safe zone always overrides severity to medium — postman explicitly
        // saying "safe/surakshit" beats any substring critical match (e.g.
        // "not flooded" contains "flood" but the postman is asserting safety).
        nextSeverity = "medium";
      }
      // #region agent log
      fetch('/api/debug-log',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'1ec22d',location:'PostmanForm.tsx:processTranscript',message:'final severity set (post-fix)',data:{finalSeverity:nextSeverity,isSafeZone,runId:'post-fix-2'},timestamp:Date.now(),hypothesisId:'A-B-C'})}).catch(()=>{});
      // #endregion
      setSeverity(nextSeverity);
      setShowTypeInput(false);
      setTypeDraft("");
      setVoiceState("idle");
    } catch {
      setVoiceState("idle");
      setVoiceApiError("Extract failed — select needs manually on next screen");
    }
  };

  // ── Form
  const toggleNeed = (n: Need) => {
    setNeeds((prev) => {
      const next = prev.includes(n) ? prev.filter((x) => x !== n) : [...prev, n];
      // Auto-set severity to medium when the first need is tapped so the user
      // never hits the "select urgency" guard after manually picking needs.
      // They can still upgrade to critical by tapping the severity button.
      if (next.length > 0 && severity === null) setSeverity("medium");
      // Clear severity when all needs are removed (clean slate).
      if (next.length === 0 && !safeZoneReport) setSeverity(null);
      return next;
    });
  };

  // ── Submit
  const handleSubmit = async (e?: FormEvent) => {
    e?.preventDefault();
    setSubmitError("");

    // Recompute guards using local variables — never rely on the async closure
    // capturing stale React state (especially after lockPostman() setState calls).
    const nameToUse = postman.trim() || nameDraft.trim();
    if (!nameToUse) {
      setSubmitError("Enter your name to continue.");
      return;
    }
    if (gpsStatus === "locating") {
      setSubmitError("Getting your location… please wait a moment.");
      return;
    }
    if (!routeBlocked) {
      const effectiveSafeDraft =
        safeZoneReport || transcriptIndicatesSafeZone(voiceTranscript);
      if (
        (needs.length === 0 && !effectiveSafeDraft) ||
        (severity === null && !effectiveSafeDraft)
      ) {
        setSubmitError("Select what is needed and urgency level.");
        return;
      }
    }

    // Persist the name to localStorage if not already locked
    if (!postmanLocked && nameToUse) lockPostman();

    // Use GPS coordinates; fall back to demo centre if GPS failed
    const lat  = gpsLat  ?? FALLBACK_LAT;
    const lng  = gpsLng  ?? FALLBACK_LNG;
    const { digipin } = safeEncode(lat, lng);
    const zoneName = gpsDigipin ? `GPS · ${gpsDigipin}` : "Field Location";
    const district = inferKeralaDistrict(lat, lng);

    const effectiveSafe =
      !routeBlocked &&
      (safeZoneReport || transcriptIndicatesSafeZone(voiceTranscript));

    const submittedNeeds: string[] = routeBlocked
      ? ["blocked"]
      : needs.length > 0
        ? [...needs]
        : effectiveSafe
          ? ["other"]
          : [];

    const submittedSeverity: Severity = routeBlocked
      ? "critical"
      : effectiveSafe && !transcriptIsCritical(voiceTranscript)
        ? "medium"
        : (severity as Severity);

    setSubmitting(true);
    try {
      const res = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          postman: nameToUse,
          digipin,
          lat,
          lng,
          needs: submittedNeeds,
          severity: submittedSeverity,
          blocked: routeBlocked,
          safeZone: effectiveSafe,
          timestamp: new Date().toISOString(),
          photoFlag: photoDataUrl !== null,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `Submit failed (${res.status})`);
      }
      setConfirmation({
        zoneName,
        district,
        needs: routeBlocked ? [] : needs,
        severity: submittedSeverity,
        digipin,
        blocked: routeBlocked,
        photoFileName: photoFileName ?? null,
        safeZone: effectiveSafe,
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
    try { recognitionRef.current?.abort(); } catch { /* no-op */ }
    setNeeds([]);
    setSeverity(null);
    setRouteBlocked(false);
    setGpsStatus("idle");
    setGpsLat(null);
    setGpsLng(null);
    setGpsDigipin(null);
    setVoiceState("idle");
    setVoiceTranscript("");
    setVoiceError("");
    setVoiceApiError("");
    setShowPermTip(false);
    setPhotoDataUrl(null);
    setPhotoFileName(null);
    setSubmitError("");
    setConfirmation(null);
    setEditOpen(false);
    setSafeZoneReport(false);
    setShowTypeInput(false);
    setTypeDraft("");
    langAttemptRef.current = 0;
    gotResultRef.current = false;
    setScreen(voiceSupported ? 1 : 2);
  };

  const goToDashboard = () => {
    if (typeof window !== "undefined") {
      window.location.href = "/dashboard";
    }
  };

  const voiceInsightScreen1 =
    screen === 1 && voiceTranscript && voiceState === "idle"
      ? fieldReadInsight(voiceTranscript, needs, severity)
      : null;
  // #region agent log
  if (screen === 1 && voiceTranscript && voiceState === "idle" && voiceInsightScreen1) {
    fetch('/api/debug-log',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'1ec22d',location:'PostmanForm.tsx:fieldReadInsight',message:'insight computed',data:{tone:voiceInsightScreen1.tone,severity,safeZoneReport,voiceTranscript},timestamp:Date.now(),hypothesisId:'D'})}).catch(()=>{});
  }
  // #endregion

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
            {(voiceError) && (
              <p className="mt-2 text-xs font-medium text-red-300">{voiceError}</p>
            )}
            {showPermTip && (
              <div className="mt-2 rounded-lg border border-slate-600 bg-slate-800/80 px-3 py-2 text-left text-[11px] text-slate-300">
                <p className="font-semibold text-white">iPhone mic steps:</p>
                <p className="mt-0.5">Settings → Safari → Microphone → Allow</p>
                <p>Then return here and tap 🎤</p>
              </div>
            )}
            {voiceApiError && (
              <div className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-200">
                {voiceApiError}
              </div>
            )}
          </div>

          {/* Proactive demo narrative */}
          {voiceInsightScreen1 && (
            <div
              className={`mt-5 w-full max-w-sm rounded-xl border px-3 py-2.5 text-left text-[11px] leading-snug ${
                voiceInsightScreen1.tone === "escalate"
                  ? "border-red-500/50 bg-red-950/40 text-red-100"
                  : voiceInsightScreen1.tone === "relay"
                  ? "border-emerald-500/40 bg-emerald-950/30 text-emerald-100"
                  : voiceInsightScreen1.tone === "safe"
                  ? "border-lime-500/50 bg-lime-950/35 text-lime-100"
                  : voiceInsightScreen1.tone === "routine"
                  ? "border-slate-500/40 bg-slate-800/80 text-slate-200"
                  : "border-amber-500/35 bg-amber-950/25 text-amber-100"
              }`}
            >
              <span className="font-semibold text-white/90">Sense layer · </span>
              {voiceInsightScreen1.lines}
            </div>
          )}

          {/* Voice extraction output chips */}
          {(needs.length > 0 || severity || voiceTranscript || safeZoneReport) && (
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
              {safeZoneReport && (
                <div className="flex justify-center">
                  <span className="inline-flex items-center rounded-full border border-lime-400/70 bg-lime-500/20 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-lime-100">
                    🟢 Safe / green pocket → lime on map
                  </span>
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
                    {severity === "critical" ? "🔴 Critical" : "📋 Standard relay"}
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
              try { recognitionRef.current?.abort(); } catch { /* no-op */ }
              if (!postmanLocked) lockPostman();
              setScreen(2);
            }}
            disabled={continueDisabled || voiceState === "processing"}
            style={{ WebkitTapHighlightColor: "transparent" }}
            className="w-full touch-manipulation rounded-xl bg-red-600 px-4 py-4 text-base font-bold text-white shadow-lg transition-opacity active:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {voiceState === "processing" ? "समझ रहे हैं… / Processing…" : "आगे बढ़ें → / Continue"}
          </button>
          <button
            type="button"
            onClick={() => setShowTypeInput((v) => !v)}
            style={{ WebkitTapHighlightColor: "transparent" }}
            className="block w-full touch-manipulation text-center text-sm font-medium text-slate-400 underline-offset-2 active:text-slate-200"
          >
            माइक नहीं? यहाँ लिखें →
          </button>

          {showTypeInput && (
            <div className="mt-2 flex gap-2">
              <input
                type="text"
                inputMode="text"
                placeholder="e.g. yahan baadh hain, khana chahiye"
                value={typeDraft}
                onChange={(e) => setTypeDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && typeDraft.trim() && voiceState !== "processing") {
                    void processTranscript(typeDraft.trim());
                    setTypeDraft("");
                  }
                }}
                disabled={voiceState === "processing"}
                className="flex-1 rounded-xl border border-slate-600 bg-slate-800 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-500/40 disabled:opacity-50"
              />
              <button
                type="button"
                disabled={!typeDraft.trim() || voiceState === "processing"}
                onClick={() => {
                  if (typeDraft.trim()) {
                    void processTranscript(typeDraft.trim());
                    setTypeDraft("");
                  }
                }}
                style={{ WebkitTapHighlightColor: "transparent" }}
                className="shrink-0 touch-manipulation rounded-xl bg-red-600 px-4 py-2.5 text-sm font-bold text-white active:bg-red-700 disabled:opacity-40"
              >
                {voiceState === "processing"
                  ? <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  : "→"}
              </button>
            </div>
          )}
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
              {confirmation.district && (
                <div className="mt-0.5 text-xs text-slate-500">
                  {confirmation.district} District
                </div>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  Needs
                </span>
                {confirmation.blocked ? (
                  <span className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-amber-700">
                    🚫 Route blocked
                  </span>
                ) : confirmation.safeZone && confirmation.needs.length === 0 ? (
                  <span className="inline-flex items-center rounded-full border border-lime-400 bg-lime-50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-lime-900">
                    Safe / green pocket
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
                      : confirmation.safeZone
                      ? "border-lime-300 bg-lime-50 text-lime-900"
                      : "border-amber-300 bg-amber-50 text-amber-700"
                  }`}
                >
                  {confirmation.severity === "critical"
                    ? "Critical"
                    : confirmation.safeZone
                    ? "Medium · routing intel"
                    : "Standard relay"}
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

              {photoDataUrl && (
                <div className="mt-3 flex items-center gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                    Photo
                  </span>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={photoDataUrl}
                    alt="Field photo"
                    className="h-10 w-10 rounded-lg object-cover shadow"
                  />
                  <div className="flex flex-col">
                    <span className="text-[11px] font-semibold text-emerald-700">✓ Attached</span>
                    {confirmation.photoFileName && (
                      <span className="max-w-[160px] truncate text-[10px] text-slate-400">
                        {confirmation.photoFileName}
                      </span>
                    )}
                  </div>
                </div>
              )}
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
  // GPS location card — shown in place of zone picker in both voice and manual modes
  const GpsCard = (
    <section>
      <p className="mb-2 text-sm font-bold text-slate-800">📍 आपकी लोकेशन / Your Location</p>
      {gpsStatus === "locating" && (
        <div className="flex items-center gap-3 rounded-xl border-2 border-blue-200 bg-blue-50 px-4 py-4">
          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />
          <span className="text-sm font-medium text-blue-700">Location मिल रही है…</span>
        </div>
      )}
      {gpsStatus === "done" && gpsDigipin && (
        <div className="rounded-xl border-2 border-emerald-500 bg-emerald-50 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-lg">✅</span>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-widest text-emerald-600">DigiPin</div>
              <div className="font-mono text-xl font-black tracking-widest text-emerald-800">{gpsDigipin}</div>
            </div>
          </div>
          <div className="mt-1.5 text-[10px] text-emerald-600">
            {gpsLat?.toFixed(4)}°N, {gpsLng?.toFixed(4)}°E · accurate to ~4 m
          </div>
        </div>
      )}
      {gpsStatus === "error" && (
        <div className="rounded-xl border-2 border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          ⚠ Location नहीं मिली — demo location use होगी.
        </div>
      )}
    </section>
  );

  // True when voice already captured needs/severity on Screen 1.
  // In this mode Screen 2 shows a compact summary + zone as the hero,
  // collapsing the full need buttons unless the postman taps "Edit".
  const voicePrefilled =
    (needs.length > 0 || severity !== null || safeZoneReport) && !routeBlocked;
  // If voice only set severity (no needs captured), force edit mode open so
  // the postman must pick at least one need before submit becomes active.
  // Safe / green-pocket phrases submit with meta need "other" — skip this trap.
  const needsNeedSelection =
    voicePrefilled &&
    needs.length === 0 &&
    !routeBlocked &&
    !safeZoneReport &&
    !transcriptIndicatesSafeZone(voiceTranscript);

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

        <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">

          {/* ── VOICE-PREFILLED MODE: compact summary + zone as hero ── */}
          {voicePrefilled && !editOpen && !needsNeedSelection ? (
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
                          {safeZoneReport ? "🟢 Safe pocket — no relief ask" : "No needs — tap Edit to add"}
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

              {GpsCard}
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

              {GpsCard}
            </>
          )}

          {/* Route-blocked toggle — always visible */}
          <section>
            <button
              type="button"
              role="switch"
              aria-checked={routeBlocked}
              onClick={() =>
                setRouteBlocked((v) => {
                  const next = !v;
                  if (next) setSafeZoneReport(false);
                  return next;
                })
              }
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

          {/* Safe / green pocket — demo (or if voice missed, toggle here) */}
          <section>
            <button
              type="button"
              role="switch"
              aria-checked={safeZoneReport}
              disabled={routeBlocked}
              onClick={() => {
                setSafeZoneReport((v) => {
                  const next = !v;
                  if (next && severity === null && !routeBlocked) setSeverity("medium");
                  if (!next && needs.length === 0) setSeverity(null);
                  return next;
                });
              }}
              style={{ WebkitTapHighlightColor: "transparent" }}
              className={`flex min-h-[56px] w-full touch-manipulation items-center justify-between gap-3 rounded-xl border-2 px-4 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                safeZoneReport
                  ? "border-lime-500 bg-lime-50"
                  : "border-slate-200 bg-white active:bg-slate-50"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-xl">🟢</span>
                <div>
                  <div className="text-sm font-bold text-slate-900">Safe / green pocket</div>
                  <div className="text-[11px] text-slate-500">
                    सुरक्षित इलाका — lime dot on SDMA map
                  </div>
                </div>
              </div>
              <span
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                  safeZoneReport ? "bg-lime-500" : "bg-slate-300"
                }`}
                aria-hidden="true"
              >
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                    safeZoneReport ? "translate-x-5" : "translate-x-0.5"
                  }`}
                />
              </span>
            </button>
          </section>

          {/* Photo capture */}
          <section>
            <input
              ref={photoInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setPhotoFileName(file.name);
                const reader = new FileReader();
                reader.onload = () => {
                  if (typeof reader.result === "string") {
                    setPhotoDataUrl(reader.result);
                  }
                };
                reader.readAsDataURL(file);
              }}
            />
            {photoDataUrl ? (
              <div className="flex items-center gap-3 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={photoDataUrl}
                  alt="Captured photo"
                  className="h-14 w-14 rounded-lg object-cover shadow"
                />
                <div className="flex-1">
                  <p className="text-sm font-bold text-emerald-800">📸 फ़ोटो मिल गई</p>
                  <p className="text-[11px] text-emerald-600">Photo attached to report</p>
                </div>
                <button
                  type="button"
                  onClick={() => { setPhotoDataUrl(null); setPhotoFileName(null); if (photoInputRef.current) photoInputRef.current.value = ""; }}
                  style={{ WebkitTapHighlightColor: "transparent" }}
                  className="touch-manipulation text-xs font-semibold text-slate-400 active:text-red-500"
                >
                  Remove
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => photoInputRef.current?.click()}
                style={{ WebkitTapHighlightColor: "transparent" }}
                className="flex min-h-[56px] w-full touch-manipulation items-center gap-3 rounded-xl border-2 border-dashed border-slate-300 bg-white px-4 py-3 text-left active:bg-slate-50"
              >
                <span className="text-2xl">📷</span>
                <div>
                  <div className="text-sm font-bold text-slate-700">फ़ोटो लें / Take Photo</div>
                  <div className="text-[11px] text-slate-400">Optional — attach flood situation photo</div>
                </div>
              </button>
            )}
          </section>

          {/* Submit error — shown when user taps Submit with incomplete form */}
          {submitError && !submitting && (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-center text-sm font-medium text-red-700">
              ⚠ {submitError}
            </p>
          )}

          {/* Submit — always enabled so Safari/mobile never silently blocks the tap;
              validation runs inside handleSubmit and surfaces via submitError */}
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={submitting}
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
