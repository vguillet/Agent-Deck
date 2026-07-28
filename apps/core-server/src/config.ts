import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";

const ProviderConfigurationSchema = z.object({
  id: z.string().min(1),
  module: z.string().min(1),
  enabled: z.boolean().default(true),
  config: z.record(z.string(), z.unknown()).default({}),
  discoveryIntervalMs: z.number().int().min(1_000).default(15_000),
});

const ServerConfigurationSchema = z.object({
  server: z
    .object({
      host: z.string().default("127.0.0.1"),
      port: z.number().int().min(1).max(65_535).default(47_831),
    })
    .default({ host: "127.0.0.1", port: 47_831 }),
  databasePath: z
    .string()
    .default(
      resolve(
        homedir(),
        "Library",
        "Application Support",
        "Agent Deck",
        "agent-deck.sqlite",
      ),
    ),
  retentionDays: z.number().int().min(1).default(30),
  staleAfterMs: z.number().int().min(60_000).default(300_000),
  healthIntervalMs: z.number().int().min(5_000).default(30_000),
  providers: z.array(ProviderConfigurationSchema).default([]),
});

export type AgentDeckConfiguration = z.infer<typeof ServerConfigurationSchema>;
export type ProviderConfiguration = z.infer<typeof ProviderConfigurationSchema>;

const isLoopback = (host: string): boolean =>
  host === "127.0.0.1" || host === "localhost" || host === "::1";

export const loadConfiguration = async (
  path = process.env.AGENT_DECK_CONFIG ?? "./agent-deck.config.json",
): Promise<AgentDeckConfiguration> => {
  let raw: unknown = {};
  try {
    raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "";
    if (code !== "ENOENT") throw error;
  }
  const configuration = ServerConfigurationSchema.parse(raw);
  if (!isLoopback(configuration.server.host)) {
    throw new Error(
      "Agent Deck developer preview has no authentication and only permits loopback binding",
    );
  }
  return configuration;
};
