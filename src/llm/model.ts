import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { loadEnv } from "../env.ts";

const PORTKEY_BASE_URL = "https://api.portkey.ai/v1";

/**
 * Build the Portkey-flavoured OpenAI-compatible client. Headers mirror the
 * older `src/agent.ts` setup so the model continues to route through the
 * same OpenRouter virtual key / config that the QA team has been using.
 */
const buildPortkeyHeaders = (
  apiKey: string,
  virtualKey: string | undefined,
  config: string | undefined
): Record<string, string> => {
  const headers: Record<string, string> = {
    "x-portkey-api-key": apiKey,
  };
  if (virtualKey) {
    headers["x-portkey-virtual-key"] = virtualKey;
  }
  if (config) {
    headers["x-portkey-config"] = config;
  }
  return headers;
};

/**
 * Single source of truth for constructing the LLM client used by every
 * caller in this codebase (phases, report interpretation, future
 * orchestrator pieces). Reads validated env on every call — cheap, since
 * `loadEnv` is just zod parsing of `process.env` — so we don't have to
 * thread the env through callers.
 */
export const createModel = (): LanguageModel => {
  const env = loadEnv();
  const portkey = createOpenAICompatible({
    name: "portkey",
    baseURL: PORTKEY_BASE_URL,
    apiKey: env.PORTKEY_API_KEY,
    headers: buildPortkeyHeaders(
      env.PORTKEY_API_KEY,
      env.PORTKEY_VIRTUAL_KEY,
      env.PORTKEY_CONFIG
    ),
  });
  return portkey.chatModel(env.PORTKEY_MODEL);
};
