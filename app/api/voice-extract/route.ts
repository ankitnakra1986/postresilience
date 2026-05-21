import { NextRequest, NextResponse } from "next/server";
import { invokeClaude, isBedrockConfigured } from "@/lib/bedrock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_NEEDS = ["food", "medicine", "cash", "evacuation"] as const;
type Need = (typeof VALID_NEEDS)[number];
type Severity = "medium" | "critical";

type ExtractResult = {
  needs: Need[];
  /** null = routine / no relief ask / no danger — not "medium urgency" */
  severity: Severity | null;
  location_hint: string;
};

const PROMPT_TEMPLATE = `You are a disaster field report parser for India Post field postmen.
Extract ONLY these three things from the voice input:
1. needs: array from [food, medicine, cash, evacuation] — empty [] if they only describe a normal/safe situation or there is no concrete relief ask.
2. severity:
   - "critical" only if life-threatening / stuck / drowning / major damage / must evacuate NOW.
   - "medium" only if there is at least one need in (1) but situation is not life-critical.
   - null (JSON null, not string) if needs is empty and the situation sounds routine, calm, or "all good" — do NOT use "medium" as a default.
3. location_hint: place name if any (string, can be "")
Return ONLY valid JSON. No explanation. No markdown.
Voice input: {transcript}`;

// Hindi (romanised) + English keyword lexicon. Tuned against the four demo
// phrases in the build brief so the heuristic path stays useful even when AWS
// creds are missing on a venue laptop.
const NEED_KEYWORDS: Record<Need, string[]> = {
  food: ["food", "khana", "khaana", "khaane", "ration", "raashan", "bhojan", "meal", "anaaj", "anaj", "hungry", "starving"],
  medicine: ["medicine", "medicines", "dawai", "dawaai", "davai", "dava", "medical", "doctor", "ilaaj", "injection", "tablet"],
  cash: ["cash", "paisa", "paise", "money", "rupaye", "rupiya", "rupee", "rupees", "funds"],
  evacuation: ["evacuation", "evacuate", "rescue", "trapped", "phanse", "fasaye", "fase", "fasna", "phans", "nikaalo", "nikalna", "stranded", "save us", "bachao", "bachaao", "boat"],
};

const CRITICAL_SIGNALS = [
  "evacuation", "evacuate", "trapped", "phanse", "fasaye", "fase", "rescue", "stranded",
  "lives at risk", "act now", "immediately", "urgent", "emergency",
  // flood/water distress — require more specific forms to avoid "pani pi lo" etc.
  "baadh", "flood", "drowning", "drown", "pani bhar", "paani bhar",
  "bachao", "bachaao", "khatra", "danger", "dying",
];

function heuristicExtract(transcript: string): ExtractResult {
  const t = transcript.toLowerCase();
  const has = (kws: string[]) => kws.some((k) => t.includes(k));

  const needs: Need[] = [];
  for (const n of VALID_NEEDS) {
    if (has(NEED_KEYWORDS[n])) needs.push(n);
  }

  const isCritical =
    needs.includes("evacuation") || CRITICAL_SIGNALS.some((k) => t.includes(k));

  // Location hint: pull a capitalised proper noun after a positional word.
  // We hit the original (non-lowercased) transcript so case survives.
  let locationHint = "";
  const placeMatch = transcript.match(
    /\b(?:in|at|near|yahan|yaha|yahaan|main)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/
  );
  if (placeMatch) locationHint = placeMatch[1].trim();

  return {
    needs: Array.from(new Set(needs)),
    severity: isCritical ? "critical" : needs.length > 0 ? "medium" : null,
    location_hint: locationHint,
  };
}

function tryParseJSON(text: string): Partial<ExtractResult> | null {
  const cleaned = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned) as Partial<ExtractResult>;
  } catch {
    // Model leaked prose; salvage the first JSON object we can find.
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]) as Partial<ExtractResult>;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function normalise(raw: Partial<ExtractResult>): ExtractResult {
  const rawNeeds = Array.isArray(raw.needs) ? raw.needs : [];
  const needs = rawNeeds
    .map((n) => String(n).toLowerCase())
    .filter((n): n is Need => (VALID_NEEDS as readonly string[]).includes(n));

  const uniqNeeds = Array.from(new Set(needs));
  // Never label "medium urgency" when the model returned no needs (model habit).
  let severity: Severity | null = null;
  if (raw.severity === "critical") severity = "critical";
  else if (uniqNeeds.length > 0) severity = "medium";
  else severity = null;

  const locationHint =
    typeof raw.location_hint === "string" ? raw.location_hint.trim() : "";

  return {
    needs: uniqNeeds,
    severity,
    location_hint: locationHint,
  };
}

export async function POST(req: NextRequest) {
  let body: { transcript?: unknown };
  try {
    body = (await req.json()) as { transcript?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const transcript =
    typeof body.transcript === "string" ? body.transcript.trim() : "";
  if (!transcript) {
    return NextResponse.json(
      { error: "transcript is required" },
      { status: 400 }
    );
  }

  // Try Bedrock; on any failure (missing creds, throttle, malformed JSON),
  // silently fall through to the heuristic so the demo never dead-ends.
  if (isBedrockConfigured) {
    try {
      const prompt = PROMPT_TEMPLATE.replace("{transcript}", transcript);
      const text = await invokeClaude(prompt, { maxTokens: 256 });
      if (text) {
        const parsed = tryParseJSON(text);
        if (parsed) {
          return NextResponse.json({
            ...normalise(parsed),
            transcript,
            source: "bedrock",
          });
        }
      }
    } catch (err) {
      console.warn(
        "Bedrock voice-extract failed; falling back to heuristic:",
        err instanceof Error ? err.message : err
      );
    }
  }

  const result = heuristicExtract(transcript);
  return NextResponse.json({
    ...result,
    transcript,
    source: "heuristic",
  });
}
