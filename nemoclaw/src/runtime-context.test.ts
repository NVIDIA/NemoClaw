// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NemoClawState } from "../blueprint/state.js";
import type { NemoClawConfig, OpenClawPluginApi } from "./index.js";

// ---------------------------------------------------------------------------
// Mocks — must be declared before dynamic imports
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("./blueprint/state.js", () => ({
  loadState: vi.fn(),
}));

const { execFile } = await import("node:child_process");
const { loadState } = await import("./blueprint/state.js");
const { getRuntimeSummary, registerRuntimeContext } = await import("./runtime-context.js");

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const defaultConfig: NemoClawConfig = {
  blueprintVersion: "latest",
  blueprintRegistry: "ghcr.io/nvidia/nemoclaw-blueprint",
  sandboxName: "openclaw",
  inferenceProvider: "nvidia",
};

function blankState(): NemoClawState {
  return {
    lastRunId: null,
    lastAction: null,
    blueprintVersion: null,
    sandboxName: null,
    migrationSnapshot: null,
    hostBackupPath: null,
    createdAt: null,
    updatedAt: new Date().toISOString(),
  };
}

// Unique session keys prevent cross-test cache hits (the Map is module-level).
let sessionCounter = 0;
function nextSessionKey(): string {
  return `test-session-${++sessionCounter}`;
}

// ---------------------------------------------------------------------------
// OpenShell mock helpers
// ---------------------------------------------------------------------------

const SANDBOX_RUNNING = "Phase: Running\nName: openclaw";
const SANDBOX_STOPPED = "Phase: Stopped\nName: openclaw";
const POLICY_SUMMARY = "Version: 1.0\nHash: abc123\nStatus: active";

const POLICY_FULL_EMPTY_NETWORK = `---
version: "1.0"
network_policies: {}
filesystem_policy:
  include_workdir: true
  read_write:
    - /sandbox
  read_only:
    - /usr/local/bin
`;

const POLICY_FULL_WITH_RULES = `---
version: "1.0"
network_policies:
  nvidia-api:
    name: NVIDIA API
    endpoints:
      - host: integrate.api.nvidia.com
        port: 443
        access: https
    binaries:
      - path: /usr/bin/curl
  github:
    name: GitHub
    endpoints:
      - host: github.com
        port: 443
        access: https
filesystem_policy:
  include_workdir: true
  read_write:
    - /sandbox
    - /tmp
`;

type ExecFileCallback = (err: Error | null, result: { stdout: string; stderr: string }) => void;

/**
 * Mock execFile so that each openshell subcommand (matched by args substring)
 * resolves or rejects with the given value.
 */
function mockExecFile(responses: Record<string, string | Error>): void {
  vi.mocked(execFile as (...args: unknown[]) => void).mockImplementation((...args: unknown[]) => {
    const callback = args[args.length - 1] as ExecFileCallback;
    const fileArgs = (args[1] as string[]).join(" ");
    for (const [key, response] of Object.entries(responses)) {
      if (fileArgs.includes(key)) {
        if (response instanceof Error) {
          callback(response, { stdout: "", stderr: response.message });
        } else {
          callback(null, { stdout: response, stderr: "" });
        }
        return;
      }
    }
    callback(new Error(`openshell: unexpected args: ${fileArgs}`), { stdout: "", stderr: "" });
  });
}

// ---------------------------------------------------------------------------
// Mock API builder
// ---------------------------------------------------------------------------

type MockApi = OpenClawPluginApi & {
  _trigger(hookName: string, ...args: unknown[]): Promise<unknown>;
};

function makeMockApi(): { api: MockApi; warnMessages: string[] } {
  const warnMessages: string[] = [];
  const handlers = new Map<string, ((...args: unknown[]) => unknown)[]>();

  const api: MockApi = {
    id: "nemoclaw",
    name: "NemoClaw",
    config: {},
    pluginConfig: {},
    logger: {
      info: vi.fn(),
      warn: (msg: string) => {
        warnMessages.push(msg);
      },
      error: vi.fn(),
      debug: vi.fn(),
    },
    registerCommand: vi.fn(),
    registerCli: vi.fn(),
    registerProvider: vi.fn(),
    registerService: vi.fn(),
    resolvePath: (s: string) => s,
    on(hookName: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(hookName, [...(handlers.get(hookName) ?? []), handler]);
    },
    async _trigger(hookName: string, ...args: unknown[]) {
      const hooks = handlers.get(hookName) ?? [];
      const results = await Promise.all(hooks.map((h) => h(...args)));
      return results[0];
    },
  };

  return { api, warnMessages };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(loadState).mockReturnValue(blankState());
  mockExecFile({
    "sandbox get openclaw": SANDBOX_RUNNING,
    "policy get openclaw --full": POLICY_FULL_EMPTY_NETWORK,
    "policy get openclaw": POLICY_SUMMARY,
  });
});

// ---------------------------------------------------------------------------
// getRuntimeSummary
// ---------------------------------------------------------------------------

describe("getRuntimeSummary", () => {
  it("returns sandbox name from pluginConfig when state has none", async () => {
    const summary = await getRuntimeSummary(defaultConfig);
    expect(summary.sandboxName).toBe("openclaw");
  });

  it("returns sandbox name from state when present", async () => {
    vi.mocked(loadState).mockReturnValue({ ...blankState(), sandboxName: "custom-box" });
    mockExecFile({
      "sandbox get custom-box": "Phase: Running\nName: custom-box",
      "policy get custom-box --full": POLICY_FULL_EMPTY_NETWORK,
      "policy get custom-box": POLICY_SUMMARY,
    });
    const summary = await getRuntimeSummary(defaultConfig);
    expect(summary.sandboxName).toBe("custom-box");
  });

  it("returns phase from openshell sandbox output", async () => {
    const summary = await getRuntimeSummary(defaultConfig);
    expect(summary.sandboxPhase).toBe("Running");
  });

  it("returns null phase when openshell sandbox get fails", async () => {
    mockExecFile({
      "sandbox get openclaw": new Error("not found"),
      "policy get openclaw --full": POLICY_FULL_EMPTY_NETWORK,
      "policy get openclaw": POLICY_SUMMARY,
    });
    const summary = await getRuntimeSummary(defaultConfig);
    expect(summary.sandboxPhase).toBeNull();
  });

  it("produces deny-by-default network lines when no rules exist", async () => {
    const summary = await getRuntimeSummary(defaultConfig);
    expect(summary.networkLines.some((l) => l.includes("deny-by-default"))).toBe(true);
  });

  it("produces named rule lines when policy has entries", async () => {
    mockExecFile({
      "sandbox get openclaw": SANDBOX_RUNNING,
      "policy get openclaw --full": POLICY_FULL_WITH_RULES,
      "policy get openclaw": POLICY_SUMMARY,
    });
    const summary = await getRuntimeSummary(defaultConfig);
    expect(summary.networkLines.some((l) => l.includes("NVIDIA API"))).toBe(true);
    expect(summary.networkLines.some((l) => l.includes("integrate.api.nvidia.com:443"))).toBe(true);
  });

  it("includes binary path annotation when rule specifies a binary", async () => {
    mockExecFile({
      "sandbox get openclaw": SANDBOX_RUNNING,
      "policy get openclaw --full": POLICY_FULL_WITH_RULES,
      "policy get openclaw": POLICY_SUMMARY,
    });
    const summary = await getRuntimeSummary(defaultConfig);
    expect(summary.networkLines.some((l) => l.includes("via /usr/bin/curl"))).toBe(true);
  });

  it("caps network rule lines at MAX_SUMMARY_RULES and appends omission note", async () => {
    const manyRules = `---
version: "1.0"
network_policies:
  rule1:
    name: Rule 1
    endpoints: [{ host: a.example.com, port: 443, access: https }]
  rule2:
    name: Rule 2
    endpoints: [{ host: b.example.com, port: 443, access: https }]
  rule3:
    name: Rule 3
    endpoints: [{ host: c.example.com, port: 443, access: https }]
  rule4:
    name: Rule 4
    endpoints: [{ host: d.example.com, port: 443, access: https }]
filesystem_policy:
  include_workdir: true
`;
    mockExecFile({
      "sandbox get openclaw": SANDBOX_RUNNING,
      "policy get openclaw --full": manyRules,
      "policy get openclaw": POLICY_SUMMARY,
    });
    const summary = await getRuntimeSummary(defaultConfig);
    expect(summary.networkLines.some((l) => l.includes("additional network rule(s) omitted"))).toBe(true);
  });

  it("returns sandboxed filesystem line when no filesystem_policy in YAML", async () => {
    const noFs = `---
version: "1.0"
network_policies: {}
`;
    mockExecFile({
      "sandbox get openclaw": SANDBOX_RUNNING,
      "policy get openclaw --full": noFs,
      "policy get openclaw": POLICY_SUMMARY,
    });
    const summary = await getRuntimeSummary(defaultConfig);
    expect(summary.filesystemLines.some((l) => l.includes("sandboxed"))).toBe(true);
  });

  it("lists writable and read-only paths from filesystem_policy", async () => {
    const summary = await getRuntimeSummary(defaultConfig);
    expect(summary.filesystemLines.some((l) => l.includes("/sandbox"))).toBe(true);
    expect(summary.filesystemLines.some((l) => l.includes("/usr/local/bin"))).toBe(true);
  });

  it("notes include_workdir when set to true", async () => {
    const summary = await getRuntimeSummary(defaultConfig);
    expect(summary.filesystemLines.some((l) => l.includes("working directory"))).toBe(true);
  });

  it("returns gracefully when all openshell commands fail", async () => {
    mockExecFile({
      "sandbox get openclaw": new Error("not found"),
      "policy get openclaw --full": new Error("not found"),
      "policy get openclaw": new Error("not found"),
    });
    const summary = await getRuntimeSummary(defaultConfig);
    expect(summary.sandboxName).toBe("openclaw");
    expect(summary.sandboxPhase).toBeNull();
    expect(summary.networkLines.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// registerRuntimeContext
// ---------------------------------------------------------------------------

describe("registerRuntimeContext", () => {
  describe("hook registration", () => {
    it("registers a before_agent_start hook", () => {
      const { api } = makeMockApi();
      const onSpy = vi.spyOn(api, "on");
      registerRuntimeContext(api, defaultConfig);
      expect(onSpy).toHaveBeenCalledWith("before_agent_start", expect.any(Function));
    });
  });

  describe("first call — full context injection", () => {
    it("returns an object with prependContext", async () => {
      const { api } = makeMockApi();
      registerRuntimeContext(api, defaultConfig);
      const result = await api._trigger("before_agent_start", {}, { sessionKey: nextSessionKey() });
      expect(result).toHaveProperty("prependContext");
    });

    it("prependContext opens and closes nemoclaw-runtime tags", async () => {
      const { api } = makeMockApi();
      registerRuntimeContext(api, defaultConfig);
      const result = (await api._trigger("before_agent_start", {}, { sessionKey: nextSessionKey() })) as {
        prependContext: string;
      };
      expect(result.prependContext).toContain("<nemoclaw-runtime>");
      expect(result.prependContext).toContain("</nemoclaw-runtime>");
    });

    it("includes the sandbox name in the context", async () => {
      const { api } = makeMockApi();
      registerRuntimeContext(api, defaultConfig);
      const result = (await api._trigger("before_agent_start", {}, { sessionKey: nextSessionKey() })) as {
        prependContext: string;
      };
      expect(result.prependContext).toContain('"openclaw"');
    });

    it("includes sandbox phase when available", async () => {
      const { api } = makeMockApi();
      registerRuntimeContext(api, defaultConfig);
      const result = (await api._trigger("before_agent_start", {}, { sessionKey: nextSessionKey() })) as {
        prependContext: string;
      };
      expect(result.prependContext).toContain("Running");
    });

    it("includes Network policy section header", async () => {
      const { api } = makeMockApi();
      registerRuntimeContext(api, defaultConfig);
      const result = (await api._trigger("before_agent_start", {}, { sessionKey: nextSessionKey() })) as {
        prependContext: string;
      };
      expect(result.prependContext).toContain("Network policy:");
    });

    it("includes Filesystem policy section header", async () => {
      const { api } = makeMockApi();
      registerRuntimeContext(api, defaultConfig);
      const result = (await api._trigger("before_agent_start", {}, { sessionKey: nextSessionKey() })) as {
        prependContext: string;
      };
      expect(result.prependContext).toContain("Filesystem policy:");
    });

    it("includes Behavior section with internet access instruction", async () => {
      const { api } = makeMockApi();
      registerRuntimeContext(api, defaultConfig);
      const result = (await api._trigger("before_agent_start", {}, { sessionKey: nextSessionKey() })) as {
        prependContext: string;
      };
      expect(result.prependContext).toContain("do not claim unrestricted internet access");
    });
  });

  describe("caching — same session, unchanged fingerprint", () => {
    it("returns undefined on the second call", async () => {
      const { api } = makeMockApi();
      registerRuntimeContext(api, defaultConfig);
      const key = { sessionKey: nextSessionKey() };
      await api._trigger("before_agent_start", {}, key);
      const second = await api._trigger("before_agent_start", {}, key);
      expect(second).toBeUndefined();
    });

    it("re-injects for a different session key", async () => {
      const { api } = makeMockApi();
      registerRuntimeContext(api, defaultConfig);
      await api._trigger("before_agent_start", {}, { sessionKey: nextSessionKey() });
      const result = await api._trigger("before_agent_start", {}, { sessionKey: nextSessionKey() });
      expect(result).toHaveProperty("prependContext");
    });
  });

  describe("delta update — fingerprint changes between calls", () => {
    it("sends a nemoclaw-runtime-update block when phase changes", async () => {
      const { api } = makeMockApi();
      registerRuntimeContext(api, defaultConfig);
      const key = { sessionKey: nextSessionKey() };

      // First call: Running
      await api._trigger("before_agent_start", {}, key);

      // Phase changes
      mockExecFile({
        "sandbox get openclaw": SANDBOX_STOPPED,
        "policy get openclaw --full": POLICY_FULL_EMPTY_NETWORK,
        "policy get openclaw": POLICY_SUMMARY,
      });

      const result = (await api._trigger("before_agent_start", {}, key)) as { prependContext: string };
      expect(result.prependContext).toContain("<nemoclaw-runtime-update>");
      expect(result.prependContext).toContain("Running -> Stopped");
    });

    it("sends update when policy hash changes", async () => {
      const { api } = makeMockApi();
      registerRuntimeContext(api, defaultConfig);
      const key = { sessionKey: nextSessionKey() };

      await api._trigger("before_agent_start", {}, key);

      mockExecFile({
        "sandbox get openclaw": SANDBOX_RUNNING,
        "policy get openclaw --full": POLICY_FULL_EMPTY_NETWORK,
        "policy get openclaw": "Version: 1.1\nHash: newHash999\nStatus: active",
      });

      const result = await api._trigger("before_agent_start", {}, key);
      expect(result).toHaveProperty("prependContext");
    });

    it("update includes current network policy lines", async () => {
      const { api } = makeMockApi();
      registerRuntimeContext(api, defaultConfig);
      const key = { sessionKey: nextSessionKey() };

      await api._trigger("before_agent_start", {}, key);

      mockExecFile({
        "sandbox get openclaw": SANDBOX_STOPPED,
        "policy get openclaw --full": POLICY_FULL_WITH_RULES,
        "policy get openclaw": "Version: 2.0\nHash: new123\nStatus: active",
      });

      const result = (await api._trigger("before_agent_start", {}, key)) as { prependContext: string };
      expect(result.prependContext).toContain("NVIDIA API");
    });
  });

  describe("error fallback", () => {
    it("returns minimal static context and logs a warning when getCachedRuntimeInjection throws", async () => {
      vi.mocked(loadState).mockImplementation(() => {
        throw new Error("disk read failure");
      });

      const { api, warnMessages } = makeMockApi();
      registerRuntimeContext(api, defaultConfig);
      const result = (await api._trigger("before_agent_start", {}, { sessionKey: nextSessionKey() })) as {
        prependContext: string;
      };

      expect(result.prependContext).toContain("<nemoclaw-runtime>");
      expect(result.prependContext).toContain("deny-by-default");
      expect(warnMessages.some((m) => m.includes("nemoclaw runtime context injection failed"))).toBe(true);
    });

    it("includes the sandbox name from pluginConfig in the fallback block", async () => {
      vi.mocked(loadState).mockImplementation(() => {
        throw new Error("unexpected");
      });

      const { api } = makeMockApi();
      registerRuntimeContext(api, defaultConfig);
      const result = (await api._trigger("before_agent_start", {}, { sessionKey: nextSessionKey() })) as {
        prependContext: string;
      };
      expect(result.prependContext).toContain('"openclaw"');
    });

    it("still resolves (does not throw) when openshell is unavailable", async () => {
      mockExecFile({
        "sandbox get openclaw": new Error("openshell: not found"),
        "policy get openclaw --full": new Error("openshell: not found"),
        "policy get openclaw": new Error("openshell: not found"),
      });

      const { api } = makeMockApi();
      registerRuntimeContext(api, defaultConfig);
      const result = await api._trigger("before_agent_start", {}, { sessionKey: nextSessionKey() });
      // Null fingerprint fields are handled gracefully — context is still injected
      expect(result).toHaveProperty("prependContext");
    });
  });

  describe("session key resolution", () => {
    it("respects hookContext.sessionKey for cache isolation", async () => {
      const { api } = makeMockApi();
      registerRuntimeContext(api, defaultConfig);

      // Two separate calls with the same session key
      const sessionKey = "isolated-session-key";
      const first = await api._trigger("before_agent_start", {}, { sessionKey });
      const second = await api._trigger("before_agent_start", {}, { sessionKey });

      expect(first).toHaveProperty("prependContext");
      expect(second).toBeUndefined();
    });

    it("emits full context on every call when hookContext has no sessionKey (no shared caching)", async () => {
      const { api } = makeMockApi();
      registerRuntimeContext(api, defaultConfig);

      const first = await api._trigger("before_agent_start", {}, {});
      const second = await api._trigger("before_agent_start", {}, {});

      // Without a session key caching is disabled — both calls must inject context.
      expect(first).toHaveProperty("prependContext");
      expect(second).toHaveProperty("prependContext");
    });

    it("treats null hookContext as missing session key", async () => {
      // Use a unique sandbox name so this test doesn't collide with the
      // preceding empty-object test in the module-level session cache.
      const cfg = { ...defaultConfig, sandboxName: "null-ctx-sandbox" };
      mockExecFile({
        "sandbox get null-ctx-sandbox": "Phase: Running\nName: null-ctx-sandbox",
        "policy get null-ctx-sandbox --full": POLICY_FULL_EMPTY_NETWORK,
        "policy get null-ctx-sandbox": POLICY_SUMMARY,
      });

      const { api } = makeMockApi();
      registerRuntimeContext(api, cfg);

      const result = await api._trigger("before_agent_start", {}, null);
      expect(result).toHaveProperty("prependContext");
    });
  });
});
