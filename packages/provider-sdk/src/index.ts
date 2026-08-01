import type {
  CommandResult,
  ProviderCommand,
  ProviderEvent,
  ProviderHealth,
  ProviderSnapshot,
  ProviderUsage,
} from "@agent-deck/domain";
import type { z } from "zod";

export interface ProviderManifest {
  id: string;
  displayName: string;
  version: string;
  sdkVersion: 2;
  capabilities: {
    discovery: boolean;
    discoveryMode?: "poll" | "startup";
    liveEvents: boolean;
    commands: string[];
    usage?: boolean;
  };
}

export interface ProviderLogger {
  debug(fields: Record<string, unknown>, message: string): void;
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface ProviderIngressRegistration {
  path: string;
  handle(input: unknown): Promise<{ statusCode: number; body: unknown }>;
}

export interface ProviderContext {
  providerId: string;
  config: Record<string, unknown>;
  dataDirectory: string;
  logger: ProviderLogger;
  now(): string;
  registerIngress(registration: ProviderIngressRegistration): void;
  checkpoints: {
    get(key: string): Promise<string | undefined>;
    set(key: string, value: string): Promise<void>;
  };
}

export type ProviderEventEmitter = (event: ProviderEvent) => Promise<void>;
export type Unsubscribe = () => Promise<void>;

export interface AgentProviderPlugin {
  manifest: ProviderManifest;
  configSchema: z.ZodType<Record<string, unknown>>;
  initialise(context: ProviderContext): Promise<void>;
  discover(): Promise<ProviderSnapshot>;
  subscribe(emit: ProviderEventEmitter): Promise<Unsubscribe>;
  execute(command: ProviderCommand): Promise<CommandResult>;
  usage?(): Promise<ProviderUsage>;
  healthCheck(): Promise<ProviderHealth>;
  dispose(): Promise<void>;
}

export type ProviderPluginFactory = () => AgentProviderPlugin;

export interface ProviderModule {
  createProviderPlugin: ProviderPluginFactory;
}
