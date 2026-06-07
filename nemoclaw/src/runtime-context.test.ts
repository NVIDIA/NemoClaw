// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NemoClawState } from "./blueprint/state.js";
import type { NemoClawConfig, OpenClawPluginApi } from "./index.js";

vi.mock("./blueprint/state.js", () => ({
  loadState: vi.fn(),
}));

import { loadState } from "./blueprint/state.js";
import { getRuntimeSummary, registerRuntimeContext } from "./runtime-context.js";

const mockedLoadState = vi.mocked(loadState);

const defaultConfig: NemoClawConfig = {
  blueprintVersion: "latest",
  blueprintRegistry: "ghcr.io/nvidia/nemoclaw-blueprint",
  sandboxName: "openclaw",
  inferenceProvider: "nvidia",
};

function blankState(patch: Partial<NemoClawState> = {}): NemoClawState {
  return {
    lastRunId: null,
    lastAction: null,
    blueprintVersion: null,
    sandboxName: null,
    migrationSnapshot: null,
    hostBackupPath: null,
    createdAt: null,
    updatedAt: "2026-03-01T00:00:00.000Z",
    lastRebuildAt: null,
    lastRebuildBackupPath: null,
    shieldsDown: false,
    shieldsDownAt: null,
    shieldsDownTimeout: null,
    shieldsDownReason: null,
    shieldsDownPolicy: null,
    shieldsPolicySnapshotPath: null,
    ...patch,
  };
}

type MockOpenClawPluginApi = OpenClawPluginApi & {
  _trigger: (name: string, ...args: readonly unknown[]) => Promise<unknown>;
};

function createMockApi(): MockOpenClawPluginApi {
  const hooks = new Map<string, (...args: readonly unknown[]) => unknown>();
  return {
    id: "nemoclaw",
    name: "NemoClaw",
    version: "0.1.0",
    config: {},
    pluginConfig: {},
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    registerCommand: vi.fn(),
    registerProvider: vi.fn(),
    registerService: vi.fn(),
    resolvePath: vi.fn((p: string) => p),
    on: vi.fn((name, handler) => {
      hooks.set(name, handler as (...args: readonly unknown[]) => unknown);
    }),
    _trigger: async (name: string, ...args: readonly unknown[]) => hooks.get(name)?.(...args),
  } as MockOpenClawPluginApi;
}

describe("getRuntimeSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedLoadState.mockReturnValue(blankState());
  });

  it("returns static deny-by-default context for the configured sandbox", async () => {
    const summary = await getRuntimeSummary(defaultConfig);

    expect(summary.sandboxName).toBe("openclaw");
    expect(summary.sandboxPhase).toBeNull();
    expect(summary.networkLines).toContain(
      "outbound network is deny-by-default, but allowed endpoints work, so verify by attempting a request rather than assuming a host is unreachable",
    );
    expect(summary.filesystemLines).toContain(
      "filesystem and process access are scoped to the sandbox, not the host; do not assume access to host paths outside it",
    );
  });

  it("prefers the persisted sandbox name when available", async () => {
    mockedLoadState.mockReturnValue(blankState({ sandboxName: "my-assistant" }));

    const summary = await getRuntimeSummary(defaultConfig);

    expect(summary.sandboxName).toBe("my-assistant");
  });

  it("falls back to plugin config when state cannot be read", async () => {
    mockedLoadState.mockImplementation(() => {
      throw new Error("state unavailable");
    });

    const summary = await getRuntimeSummary(defaultConfig);

    expect(summary.sandboxName).toBe("openclaw");
  });
});

describe("registerRuntimeContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedLoadState.mockReturnValue(blankState());
  });

  it("registers a before_prompt_build hook", () => {
    const api = createMockApi();

    registerRuntimeContext(api, defaultConfig);

    expect(api.on).toHaveBeenCalledWith("before_prompt_build", expect.any(Function));
  });

  it("prepends static NemoClaw runtime context", async () => {
    const api = createMockApi();
    registerRuntimeContext(api, defaultConfig);

    const result = (await api._trigger("before_prompt_build", {}, {})) as {
      prependSystemContext: string;
    };

    expect(result.prependSystemContext).toContain("<nemoclaw-runtime>");
    expect(result.prependSystemContext).toContain('OpenShell sandbox "openclaw"');
    expect(result.prependSystemContext).toContain("Network policy:");
    expect(result.prependSystemContext).toContain("Filesystem policy:");
    expect(result.prependSystemContext).toContain("</nemoclaw-runtime>");
    // Grounding directive: the agent must attempt before asserting a host is
    // blocked rather than refusing preemptively, and report the real failure
    // mode instead of assuming a specific status code.
    expect(result.prependSystemContext).toContain(
      "unless you have actually attempted it this turn",
    );
    expect(result.prependSystemContext).toContain("raises an operator approval request");
  });

  it("uses the persisted sandbox name in the injected context", async () => {
    mockedLoadState.mockReturnValue(blankState({ sandboxName: "my-assistant" }));
    const api = createMockApi();
    registerRuntimeContext(api, defaultConfig);

    const result = (await api._trigger("before_prompt_build", {}, {})) as {
      prependSystemContext: string;
    };

    expect(result.prependSystemContext).toContain('OpenShell sandbox "my-assistant"');
  });
});
