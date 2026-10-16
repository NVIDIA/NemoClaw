// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import * as onboardSession from "../state/onboard-session";
import * as registry from "../state/registry";
import { loadAgent } from "./defs";
// Import source directly so tests cannot pass against a stale build.
import {
  getRegisteredAgent,
  resolveRegisteredAgentDefinition,
  resolveRegisteredSandboxAgent,
  resolveSessionAgentDefinition,
} from "./runtime";

const hermesAgent = loadAgent("hermes");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getRegisteredAgent", () => {
  it("does not invent an agent when the target registry row is absent or OpenClaw", () => {
    expect(getRegisteredAgent(null)).toBeNull();
    expect(getRegisteredAgent({})).toBeNull();
    expect(getRegisteredAgent({ agent: "openclaw" })).toBeNull();
  });

  it("loads only the agent named by the supplied registry row", () => {
    expect(getRegisteredAgent({ agent: "hermes" })?.name).toBe("hermes");
  });

  it("fails closed when the registered agent definition is unavailable", () => {
    expect(getRegisteredAgent({ agent: "missing-agent" })).toBeNull();
  });

  it.each(["../openclaw", "/tmp/agent", "hermes/../openclaw", "hermes\\openclaw"])(
    "fails closed for path-like persisted agent name %j",
    (agent) => {
      expect(getRegisteredAgent({ agent })).toBeNull();
    },
  );
});

describe("resolveRegisteredAgentDefinition", () => {
  it("loads OpenClaw when a lifecycle needs its manifest-owned paths", () => {
    expect(resolveRegisteredAgentDefinition({ agent: "openclaw" })?.name).toBe("openclaw");
  });

  it("fails closed for an unknown registry value", () => {
    expect(resolveRegisteredAgentDefinition({ agent: "missing-agent" })).toBeNull();
  });
});

describe("resolveRegisteredSandboxAgent", () => {
  it("uses the agent persisted by a sibling gateway registry", () => {
    vi.spyOn(registry, "getSandboxAcrossGatewayRoots").mockReturnValue({
      name: "alpha",
      agent: "hermes",
    } as never);
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "alpha",
      agent: "openclaw",
    } as never);

    expect(resolveRegisteredSandboxAgent("alpha", null)?.name).toBe("hermes");
  });

  it("keeps a matching selected agent without changing registry roots", () => {
    vi.spyOn(registry, "getSandboxAcrossGatewayRoots").mockReturnValue({
      name: "alpha",
      agent: "hermes",
    } as never);

    expect(resolveRegisteredSandboxAgent("alpha", hermesAgent)).toBe(hermesAgent);
  });
});

describe("resolveSessionAgentDefinition", () => {
  it.each(["hermes", "langchain-deepagents-code"])(
    "keeps a registered null agent on OpenClaw after %s onboarding (#12586)",
    (sessionAgent) => {
      vi.spyOn(registry, "getSandbox").mockReturnValue({ agent: null } as never);
      const session = vi.spyOn(onboardSession, "loadSession").mockReturnValue({
        agent: sessionAgent,
      } as never);

      expect(resolveSessionAgentDefinition("alpha", null)).toEqual({
        agent: loadAgent("openclaw"),
        requestedName: "openclaw",
        resolved: true,
      });
      expect(session).not.toHaveBeenCalled();
    },
  );

  it.each(["openclaw", "hermes", "langchain-deepagents-code", "missing-agent"])(
    "uses session agent %s when no registry row exists",
    (name) => {
      vi.spyOn(registry, "getSandbox").mockReturnValue(null);
      vi.spyOn(onboardSession, "loadSession").mockReturnValue({ agent: name } as never);

      expect(resolveSessionAgentDefinition("alpha", null)).toEqual({
        agent: name === "openclaw" ? loadAgent("openclaw") : null,
        requestedName: name,
        resolved: name === "openclaw",
      });
    },
  );

  it.each(["", false, 0, {}, [], "../openclaw"])(
    "rejects malformed registered agent %j without using the session",
    (agent) => {
      vi.spyOn(registry, "getSandbox").mockReturnValue({ agent } as never);
      vi.spyOn(onboardSession, "loadSession").mockReturnValue({ agent: "openclaw" } as never);

      expect(resolveSessionAgentDefinition("alpha", null)).toEqual({
        agent: null,
        requestedName: agent,
        resolved: false,
      });
    },
  );

  it.each(["hermes", "langchain-deepagents-code"])("preserves a selected %s definition", (name) => {
    const selectedAgent = loadAgent(name);
    expect(resolveSessionAgentDefinition("alpha", selectedAgent)).toEqual({
      agent: selectedAgent,
      requestedName: name,
      resolved: true,
    });
  });

  it("defaults to OpenClaw when no registry row or session exists", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue(null);
    vi.spyOn(onboardSession, "loadSession").mockReturnValue(null);

    expect(resolveSessionAgentDefinition("alpha", null)).toEqual({
      agent: loadAgent("openclaw"),
      requestedName: "openclaw",
      resolved: true,
    });
  });

  it("loads the trusted OpenClaw manifest for the legacy null representation", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({ agent: "openclaw" } as never);
    const resolved = resolveSessionAgentDefinition("alpha", null);

    expect(resolved.resolved).toBe(true);
    expect(resolved.agent).toBe(loadAgent("openclaw"));
    expect(resolved.agent?.binary_path).toBe("/usr/local/bin/openclaw");
  });

  it("preserves an unresolved registered agent instead of changing it to OpenClaw", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({ agent: "missing-agent" } as never);

    expect(resolveSessionAgentDefinition("alpha", null)).toEqual({
      agent: null,
      requestedName: "missing-agent",
      resolved: false,
    });
  });
});
