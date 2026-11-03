import { models as anthropic } from "@nexusai/adapter-claude-local";
import { models as openai } from "@nexusai/adapter-codex-local";
import { models as google } from "@nexusai/adapter-gemini-local";
import { models as xai } from "@nexusai/adapter-grok-local";
import type { AiConnectionMetadata } from "@nexusai/shared";

/** Catalogs follow the saved API connection, never the host CLI's credentials or environment. */
export function fastResponseCatalogModels(connection: Pick<AiConnectionMetadata, "provider" | "routing">) {
  if (connection.routing) return connection.routing.models ?? [];
  return { anthropic, openai, google, xai, openrouter: [], github: [] }[connection.provider];
}
