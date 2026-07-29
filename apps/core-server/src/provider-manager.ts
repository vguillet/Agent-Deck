import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import type {
  CanonicalEvent,
  CommandResult,
  Provider,
  ProviderCommand,
  ProviderHealth,
} from "@agent-deck/domain";
import type { EventStore } from "@agent-deck/event-store";
import type {
  AgentProviderPlugin,
  ProviderIngressRegistration,
  ProviderModule,
} from "@agent-deck/provider-sdk";
import type { ProviderConfiguration } from "./config.js";

interface ManagedProvider {
  configuration: ProviderConfiguration;
  plugin: AgentProviderPlugin;
  provider: Provider;
  stopSubscription?: () => Promise<void>;
  discoveryTimer?: NodeJS.Timeout;
  healthTimer?: NodeJS.Timeout;
}

export class ProviderManager {
  private readonly providers: ManagedProvider[] = [];
  private readonly ingress: Array<{
    providerId: string;
    registration: ProviderIngressRegistration;
  }> = [];

  constructor(
    private readonly configurations: ProviderConfiguration[],
    private readonly store: EventStore,
    private readonly app: FastifyInstance,
    private readonly dataDirectory: string,
    private readonly healthIntervalMs: number,
    private readonly publish: (event: CanonicalEvent) => void,
  ) {}

  async initialise(): Promise<void> {
    for (const configuration of this.configurations.filter(
      (candidate) => candidate.enabled,
    )) {
      const imported = (await import(configuration.module)) as ProviderModule;
      if (typeof imported.createProviderPlugin !== "function") {
        throw new Error(
          `Provider module ${configuration.module} does not export createProviderPlugin`,
        );
      }
      const plugin = imported.createProviderPlugin();
      if (plugin.manifest.sdkVersion !== 1)
        throw new Error(
          `Unsupported provider SDK version for ${configuration.id}`,
        );
      if (plugin.manifest.id !== configuration.id)
        throw new Error(
          `Configured provider ${configuration.id} loaded manifest ${plugin.manifest.id}`,
        );
      const config = plugin.configSchema.parse(configuration.config);
      const providerDirectory = resolve(this.dataDirectory, configuration.id);
      await mkdir(providerDirectory, { recursive: true });
      await plugin.initialise({
        providerId: configuration.id,
        config,
        dataDirectory: providerDirectory,
        logger: {
          debug: (fields, message) =>
            this.app.log.debug(
              { providerId: configuration.id, ...fields },
              message,
            ),
          info: (fields, message) =>
            this.app.log.info(
              { providerId: configuration.id, ...fields },
              message,
            ),
          warn: (fields, message) =>
            this.app.log.warn(
              { providerId: configuration.id, ...fields },
              message,
            ),
          error: (fields, message) =>
            this.app.log.error(
              { providerId: configuration.id, ...fields },
              message,
            ),
        },
        now: () => new Date().toISOString(),
        registerIngress: (registration) =>
          this.ingress.push({
            providerId: configuration.id,
            registration,
          }),
        checkpoints: {
          get: async (key) => this.store.getCheckpoint(configuration.id, key),
          set: async (key, value) => {
            this.store.setCheckpoint(configuration.id, key, value);
          },
        },
      });
      const provider: Provider = {
        id: plugin.manifest.id,
        displayName: plugin.manifest.displayName,
        version: plugin.manifest.version,
        health: "starting",
        consecutiveFailures: 0,
        capabilities: plugin.manifest.capabilities,
      };
      const event = this.store.updateProvider(provider);
      if (event) this.publish(event);
      this.providers.push({ configuration, plugin, provider });
    }
  }

  registerIngressRoutes(): void {
    for (const { providerId, registration } of this.ingress) {
      const path = `/internal/providers/${encodeURIComponent(providerId)}${registration.path}`;
      this.app.post(path, async (request, reply) => {
        const result = await registration.handle(request.body);
        return reply.code(result.statusCode).send(result.body);
      });
    }
  }

  async execute(command: ProviderCommand): Promise<CommandResult> {
    const agent = this.store.getAgent(command.agentId);
    const managed = agent
      ? this.providers.find(
          (candidate) => candidate.provider.id === agent.providerId,
        )
      : undefined;
    if (!agent || !managed)
      return {
        commandId: command.commandId,
        status: "failed",
        message: "Agent provider is unavailable",
      };
    if (!managed.provider.capabilities.commands.includes(command.action))
      return {
        commandId: command.commandId,
        status: "unsupported",
        message: `${managed.provider.displayName} does not support ${command.action}`,
      };
    return managed.plugin.execute(command);
  }

  async start(): Promise<void> {
    for (const managed of this.providers) {
      managed.stopSubscription = await managed.plugin.subscribe(
        async (event) => {
          const persisted = this.store.applyProviderEvent(event);
          if (persisted) this.publish(persisted);
        },
      );
      await this.discover(managed);
      if (managed.plugin.manifest.capabilities.discoveryMode !== "startup") {
        managed.discoveryTimer = setInterval(() => {
          void this.discover(managed);
        }, managed.configuration.discoveryIntervalMs);
        managed.discoveryTimer.unref();
      }
      managed.healthTimer = setInterval(() => {
        void this.checkHealth(managed);
      }, this.healthIntervalMs);
      managed.healthTimer.unref();
      await this.checkHealth(managed);
    }
  }

  async dispose(): Promise<void> {
    for (const managed of this.providers) {
      if (managed.discoveryTimer) clearInterval(managed.discoveryTimer);
      if (managed.healthTimer) clearInterval(managed.healthTimer);
      await managed.stopSubscription?.();
      await managed.plugin.dispose();
      managed.provider = {
        ...managed.provider,
        health: "stopped",
        lastCheckedAt: new Date().toISOString(),
      };
      const event = this.store.updateProvider(managed.provider);
      if (event) this.publish(event);
    }
  }

  private async discover(managed: ManagedProvider): Promise<void> {
    try {
      const snapshot = await managed.plugin.discover();
      for (const event of this.store.applySnapshot(
        managed.provider.id,
        snapshot,
      )) {
        this.publish(event);
      }
    } catch (error) {
      this.app.log.warn(
        { providerId: managed.provider.id, error },
        "Provider discovery failed",
      );
    }
  }

  private async checkHealth(managed: ManagedProvider): Promise<void> {
    let health: ProviderHealth;
    try {
      health = await managed.plugin.healthCheck();
      managed.provider = {
        ...managed.provider,
        health: health.status,
        ...(health.message ? { healthMessage: health.message } : {}),
        lastCheckedAt: health.checkedAt,
        consecutiveFailures:
          health.status === "unhealthy"
            ? managed.provider.consecutiveFailures + 1
            : 0,
      };
    } catch (error) {
      const failures = managed.provider.consecutiveFailures + 1;
      managed.provider = {
        ...managed.provider,
        health: failures >= 3 ? "unhealthy" : "degraded",
        healthMessage: error instanceof Error ? error.message : String(error),
        lastCheckedAt: new Date().toISOString(),
        consecutiveFailures: failures,
      };
    }
    const event = this.store.updateProvider(managed.provider);
    if (event) this.publish(event);
  }
}
