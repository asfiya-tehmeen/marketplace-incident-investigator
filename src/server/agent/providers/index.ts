import { config } from "../../config";
import { anthropicProvider } from "./anthropic";
import { mockProvider } from "./mock";
import type { AgentProvider } from "./types";

export type ProviderName = "mock" | "anthropic";

export function availableProviders(): Array<{ name: ProviderName; label: string; available: boolean; reason?: string }> {
  const cfg = config();
  return [
    { name: "mock", label: "Deterministic playbook (no LLM)", available: true },
    {
      name: "anthropic",
      label: `Claude (${cfg.ANTHROPIC_MODEL})`,
      available: Boolean(cfg.ANTHROPIC_API_KEY),
      reason: cfg.ANTHROPIC_API_KEY ? undefined : "Set ANTHROPIC_API_KEY to enable",
    },
  ];
}

export function createProvider(name: ProviderName): AgentProvider {
  if (name === "mock") return mockProvider;
  const cfg = config();
  return anthropicProvider({ apiKey: cfg.ANTHROPIC_API_KEY, model: cfg.ANTHROPIC_MODEL, timeoutMs: cfg.LLM_TIMEOUT_MS });
}
