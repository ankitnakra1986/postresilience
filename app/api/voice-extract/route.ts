import { NextRequest, NextResponse } from "next/server";
import { invokeClaude, isBedrockConfigured } from "@/lib/bedrock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_NEEDS = ["food", "medicine", "cash", "evacuation"] as const;
type Need = (typeof VALID_NEEDS)[number];
type Severity = "medium" | "critical";

type ExtractResult = {
  needs: Need[];
  severity: Severity;
  location_hint: string;
};

const PROMPT_TEMPLATE = `You are a disaster field report parser.
Extract ONLY these three things from the postman voice input:
1. needs: array containing any of [food, medicine, cash, evacuation]
2. severity: one of [medium, critical]
3. location_hint: any place name mentioned (string, can be empty string)
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
  "paani", "pani", "flood", "drowning", "drown", "bachao", "bachaao", "khatra", "danger", "dying", "jaan",
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
    severity: isCritical ? "critical" : "medium",
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

  const severity: Severity = raw.severity === "critical" ? "critical" : "medium";
  const locationHint =
    typeof raw.location_hint === "string" ? raw.location_hint.trim() : "";

  return {
    needs: Array.from(new Set(needs)),
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
