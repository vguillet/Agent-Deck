import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTION_IDS } from "./action-settings.js";

const pluginRoot = resolve(
  import.meta.dirname,
  "../com.agentdeck.monitor.sdPlugin",
);
const assetsRoot = resolve(pluginRoot, "assets");

const defaultAssets = {
  [ACTION_IDS.agentSlot]: {
    name: "action-agent",
    digest: "150377a77d6d489997e4414248920d5fcfd1e47276a33ffe8846491bf3f22013",
  },
  [ACTION_IDS.agentSummary]: {
    name: "action-summary",
    digest: "d5a7db2289d5aef06c0fe0f0275e9d710b4261a2cb696c86c4b9c0b452b8c195",
  },
  [ACTION_IDS.attention]: {
    name: "action-attention",
    digest: "58e59e6ed728bbff98f7752bd2455e03c3117c9ac0963656478ababa20678c79",
  },
  [ACTION_IDS.providerHealth]: {
    name: "action-health",
    digest: "efb3db451bb34b6863896d06c7ec1155f9840ca72ab6a8d516a7831154460b70",
  },
  [ACTION_IDS.newAgent]: {
    name: "action-create",
    digest: "efc5a591df82d73834cf3b0d2a3ceb2a60e976ce55527329eb1148284dfbef8e",
  },
  [ACTION_IDS.providerUsage]: {
    name: "action-usage",
    digest: "27296e492c66f123dfe6568ccbb32523a6523a9f67c86b7f89983607279493bf",
  },
  [ACTION_IDS.systemHealth]: {
    name: "action-system",
    digest: "48d5a8eb1773318293bac20ff4952ae1d27b589043d2962ddfd23fa19c7588f3",
  },
} as const;

interface ManifestAction {
  UUID: string;
  Icon: string;
  States: readonly { Image: string }[];
}

describe("Stream Deck default action icons", () => {
  it("uses its disabled key artwork for every action state", async () => {
    const manifest = JSON.parse(
      await readFile(resolve(pluginRoot, "manifest.json"), "utf8"),
    ) as { Actions: readonly ManifestAction[] };

    for (const [actionId, asset] of Object.entries(defaultAssets)) {
      const action = manifest.Actions.find(({ UUID }) => UUID === actionId);
      expect(action).toBeDefined();
      expect(action?.Icon).toBe(`assets/${asset.name}`);
      expect(action?.States).toHaveLength(1);
      expect(action?.States[0]?.Image).toBe(`assets/${asset.name}`);
    }
  });

  it("keeps the default key artwork visually stable at both resolutions", async () => {
    for (const { name, digest } of Object.values(defaultAssets)) {
      const image = await readFile(resolve(assetsRoot, `${name}.svg`), "utf8");
      const highDensityImage = await readFile(
        resolve(assetsRoot, `${name}@2x.svg`),
        "utf8",
      );

      expect(image).toContain('viewBox="0 0 144 144"');
      expect(highDensityImage).toBe(image);
      expect(createHash("sha256").update(image).digest("hex")).toBe(digest);
    }
  });

  it("reserves the disconnected treatment for Connection Overview", async () => {
    const system = await readFile(
      resolve(assetsRoot, "action-system.svg"),
      "utf8",
    );
    const disabledActions = await Promise.all(
      [
        "action-agent",
        "action-summary",
        "action-attention",
        "action-health",
        "action-create",
      ].map((name) => readFile(resolve(assetsRoot, `${name}.svg`), "utf8")),
    );
    const usage = await readFile(
      resolve(assetsRoot, "action-usage.svg"),
      "utf8",
    );

    expect(system).toContain('fill="#dc2626"');
    expect(system).toContain('d="m3 3 18 18"');
    for (const action of disabledActions) {
      expect(action).toContain('filter id="agent-slot-muted"');
      expect(action).toContain('fill="#64748b" opacity=".32"');
    }
    expect(usage).toContain('filter id="usage-muted-logo"');
    expect(usage).toContain(
      '<text x="72" y="77" text-anchor="middle" font-family="system-ui" font-size="16" font-weight="800" fill="#cbd5e1">Unavailable</text>',
    );
  });
});
