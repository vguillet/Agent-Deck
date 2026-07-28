import { describe, expect, it } from "vitest";
import { AgentJsonSchema, AgentSchema } from "./index.js";

const agent = {
  id: "codex:thread-1",
  providerId: "codex",
  externalId: "thread-1",
  title: "Agent focus",
  state: "running",
  freshness: "fresh",
  requiresAttention: false,
  lastActivityAt: "2026-07-28T09:00:00.000Z",
  revision: 1,
  archived: false,
  capabilities: {
    messages: false,
    approvals: false,
    cancellation: false,
    creation: false,
  },
  links: [
    {
      rel: "focus",
      label: "Open in Codex",
      href: "codex://threads/thread-1",
    },
  ],
  metadata: {},
};

describe("Agent focus link contract", () => {
  it("accepts focus links and publishes them in JSON Schema", () => {
    expect(AgentSchema.parse(agent).links[0]).toEqual(agent.links[0]);
    expect(JSON.stringify(AgentJsonSchema)).toContain('"focus"');
  });

  it("rejects invalid relations and URLs", () => {
    expect(() =>
      AgentSchema.parse({
        ...agent,
        links: [{ rel: "launch", label: "Open", href: "not a URL" }],
      }),
    ).toThrow();
  });
});
