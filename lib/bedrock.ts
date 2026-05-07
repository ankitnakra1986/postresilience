/**
 * AWS Bedrock client wrapper.
 *
 * Reads creds from env (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION
 * + optional AWS_SESSION_TOKEN). When creds are missing, `invokeClaude`
 * returns null so callers can fall back to a heuristic path. This keeps the
 * demo working on machines without AWS wired up.
 *
 * Default model is Claude Sonnet on Bedrock; override with BEDROCK_MODEL_ID.
 */
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

const REGION =
  process.env.AWS_REGION ||
  process.env.AWS_DEFAULT_REGION ||
  "ap-south-1";

const MODEL_ID =
  process.env.BEDROCK_MODEL_ID ||
  "anthropic.claude-3-5-sonnet-20241022-v2:0";

const HAS_CREDS = Boolean(
  process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
);

export const isBedrockConfigured: boolean = HAS_CREDS;
export const bedrockModelId: string = MODEL_ID;
export const bedrockRegion: string = REGION;

let cachedClient: BedrockRuntimeClient | null = null;

function getClient(): BedrockRuntimeClient | null {
  if (!HAS_CREDS) return null;
  if (cachedClient) return cachedClient;
  cachedClient = new BedrockRuntimeClient({ region: REGION });
  return cachedClient;
}

type ClaudeBody = {
  anthropic_version: "bedrock-2023-05-31";
  max_tokens: number;
  temperature?: number;
  messages: { role: "user" | "assistant"; content: string }[];
};

type ClaudeResponse = {
  content?: { type?: string; text?: string }[];
};

/**
 * Send a single user prompt to Claude on Bedrock. Returns the raw text reply,
 * or null when Bedrock isn't configured. Throws on network / model errors so
 * the caller can decide whether to fall back.
 */
export async function invokeClaude(
  prompt: string,
  opts?: { maxTokens?: number; temperature?: number }
): Promise<string | null> {
  const client = getClient();
  if (!client) return null;

  const body: ClaudeBody = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: opts?.maxTokens ?? 512,
    temperature: opts?.temperature ?? 0,
    messages: [{ role: "user", content: prompt }],
  };

  const command = new InvokeModelCommand({
    modelId: MODEL_ID,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify(body),
  });

  const response = await client.send(command);
  if (!response.body) return null;

  const decoded = new TextDecoder().decode(response.body);
  let parsed: ClaudeResponse;
  try {
    parsed = JSON.parse(decoded) as ClaudeResponse;
  } catch {
    return null;
  }

  const text = parsed.content?.find((c) => c.type === "text")?.text;
  return typeof text === "string" ? text : null;
}
