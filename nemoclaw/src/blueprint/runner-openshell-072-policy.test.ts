// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type fs from "node:fs";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createRunnerFsStore,
  FAKE_HOME,
  FIXED_RUN_UUID,
  inMemoryFsMethods,
  resolvedEndpointFor,
} from "./runner-mock-fixtures.js";
import {
  absentGlobalPolicyHistoryResult,
  gatewayInfoResult,
  gatewayStatusResult,
  globalPolicyResult,
  minimalBlueprint,
  sandboxPolicyResult,
  successResult,
  TEST_SANDBOX_POLICY,
  TEST_SANDBOX_POLICY_PATH,
} from "./runner-test-fixtures.js";

const { store } = createRunnerFsStore();
const mockExeca = vi.fn();

vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomUUID: () => FIXED_RUN_UUID,
}));
vi.mock("node:os", () => ({ homedir: () => FAKE_HOME }));
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  const memory = inMemoryFsMethods(store, { spy: vi.fn });
  return {
    ...original,
    closeSync: memory.closeSync,
    existsSync: memory.existsSync,
    fsyncSync: memory.fsyncSync,
    mkdirSync: memory.mkdirSync,
    openSync: memory.openSync,
    readFileSync: memory.readFileSync,
    readdirSync: memory.readdirSync,
    renameSync: memory.renameSync,
    unlinkSync: memory.unlinkSync,
    writeFileSync: memory.writeFileSync,
  };
});
vi.mock("execa", () => ({ execa: (...args: unknown[]) => mockExeca(...args) }));
vi.mock("./ssrf.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ssrf.js")>()),
  validateEndpointUrl: vi.fn(async (url: string) => resolvedEndpointFor(url)),
}));

const { actionApply, actionReconcile, actionStatus } = await import("./runner.js");

const additions = {
  nim_service: {
    name: "nim_service",
    endpoints: [{ host: "integrate.api.nvidia.com", port: 443, access: "full" as const }],
  },
};

function blueprint() {
  const value = minimalBlueprint();
  const components = value.components as Record<string, unknown>;
  return {
    ...value,
    components: { ...components, policy: { additions } },
  } as Parameters<typeof actionApply>[1];
}

function runDirectory(runId: string): string {
  return `${FAKE_HOME}/.nemoclaw/state/runs/${runId}`;
}

describe("blueprint policy convenience", () => {
  let livePolicy: Record<string, unknown>;
  let globalActive: boolean;
  let basePolicyFailure: string | null;
  let basePolicyOutput: string | null;
  let basePolicyReads: number;
  let mutateBasePolicyOnRead: number | null;
  let mutateBasePolicy: (() => void) | null;

  beforeEach(() => {
    store.clear();
    store.set(TEST_SANDBOX_POLICY_PATH, { type: "file", content: TEST_SANDBOX_POLICY });
    vi.stubEnv("OPENSHELL_SANDBOX_POLICY", TEST_SANDBOX_POLICY_PATH);
    livePolicy = {
      version: 1,
      future_section: { preserve: true },
      network_policies: { host_added: { endpoints: [{ host: "host.example", port: 443 }] } },
    };
    globalActive = false;
    basePolicyFailure = null;
    basePolicyOutput = null;
    basePolicyReads = 0;
    mutateBasePolicyOnRead = null;
    mutateBasePolicy = null;
    mockExeca.mockReset().mockImplementation(async (_command: string, args: string[]) => {
      const joined = args.join(" ");
      switch (joined) {
        case "status":
          return gatewayStatusResult();
        case "gateway info -g test-gateway":
          return gatewayInfoResult();
        case "policy list -g test-gateway --global --limit 1":
          return globalActive
            ? { exitCode: 0, stdout: "revision 1", stderr: "" }
            : absentGlobalPolicyHistoryResult();
        case "policy get -g test-gateway --global --full --output json":
          return globalPolicyResult(livePolicy.network_policies as Record<string, unknown>);
        case "policy get -g test-gateway --full --output json test-sandbox":
          return sandboxPolicyResult(
            "test-sandbox",
            globalActive ? "global" : "sandbox",
            livePolicy.network_policies as Record<string, unknown>,
            livePolicy,
          );
        case "policy get -g test-gateway --base test-sandbox":
          basePolicyReads += 1;
          (basePolicyReads === mutateBasePolicyOnRead ? mutateBasePolicy : null)?.();
          return basePolicyFailure
            ? { exitCode: 1, stdout: "", stderr: basePolicyFailure }
            : {
                exitCode: 0,
                stdout: basePolicyOutput ?? YAML.stringify(livePolicy),
                stderr: "",
              };
      }
      switch (`${args[0]} ${args[1]}`) {
        case "policy set": {
          const path = args[args.indexOf("--policy") + 1];
          livePolicy = YAML.parse(String(store.get(path)?.content ?? ""));
          return successResult();
        }
        case "provider get":
          return {
            exitCode: 0,
            stdout: `Name: ${args[2]}\nType: openai\nCredential keys: OPENAI_API_KEY\nConfig keys: OPENAI_BASE_URL\n`,
            stderr: "",
          };
        default:
          return successResult();
      }
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("preserves host-side entries while applying blueprint additions", async () => {
    await actionApply("default", blueprint());
    expect(livePolicy).toEqual(
      expect.objectContaining({
        future_section: { preserve: true },
        network_policies: expect.objectContaining({
          host_added: expect.any(Object),
          nim_service: additions.nim_service,
        }),
      }),
    );
    expect([...store.keys()].some((path) => path.endsWith("policy-update.yaml"))).toBe(false);
  });

  it("rebases additions when an unrelated host edit races the initial base-policy read", async () => {
    mutateBasePolicyOnRead = 2;
    mutateBasePolicy = () => {
      livePolicy.network_policies = {
        ...(livePolicy.network_policies as Record<string, unknown>),
        concurrent_host_edit: {
          endpoints: [{ host: "concurrent.example", port: 443 }],
        },
      };
    };

    await actionApply("default", blueprint());

    expect(livePolicy.network_policies).toEqual(
      expect.objectContaining({
        concurrent_host_edit: expect.any(Object),
        nim_service: additions.nim_service,
      }),
    );
  });

  it("stops when a host edit races the blueprint-owned policy key", async () => {
    mutateBasePolicyOnRead = 2;
    mutateBasePolicy = () => {
      livePolicy.network_policies = {
        ...(livePolicy.network_policies as Record<string, unknown>),
        nim_service: {
          name: "nim_service",
          endpoints: [{ host: "operator.example", port: 443, access: "full" }],
        },
      };
    };

    await expect(actionApply("default", blueprint())).rejects.toThrow(
      "network policy 'nim_service' changed concurrently",
    );
    expect(
      mockExeca.mock.calls.some(
        ([, args]) => Array.isArray(args) && args[0] === "policy" && args[1] === "set",
      ),
    ).toBe(false);
    expect(livePolicy.network_policies).toMatchObject({
      nim_service: { endpoints: [{ host: "operator.example" }] },
    });
  });

  it("skips the convenience mutation when OpenShell already contains the requirement", async () => {
    livePolicy.network_policies = {
      ...(livePolicy.network_policies as Record<string, unknown>),
      nim_service: additions.nim_service,
    };

    await actionApply("default", blueprint());

    expect(
      mockExeca.mock.calls.some(
        ([, args]) => Array.isArray(args) && args[0] === "policy" && args[1] === "set",
      ),
    ).toBe(false);
  });

  it("rejects a scalar future policy section before writing", async () => {
    livePolicy.future_section = "unreviewed-scalar";

    await expect(actionApply("default", blueprint())).rejects.toThrow(
      /future_section.*must be a YAML mapping/,
    );
  });

  it("surfaces a failed OpenShell policy write", async () => {
    const implementation = mockExeca.getMockImplementation();
    expect(implementation).toBeDefined();
    mockExeca.mockImplementation(async (command: string, args: string[]) =>
      args[0] === "policy" && args[1] === "set"
        ? { exitCode: 1, stdout: "", stderr: "write rejected" }
        : implementation!(command, args),
    );

    await expect(actionApply("default", blueprint())).rejects.toThrow(
      /Failed to apply policy additions: write rejected/,
    );
  });

  it("fails closed when policy inspection throws", async () => {
    const implementation = mockExeca.getMockImplementation();
    expect(implementation).toBeDefined();
    mockExeca.mockImplementation(async (command: string, args: string[]) =>
      args.join(" ") === "policy get -g test-gateway --full --output json test-sandbox"
        ? Promise.reject(new Error("transport interrupted"))
        : implementation!(command, args),
    );

    await expect(actionApply("default", blueprint())).rejects.toThrow(
      /sandbox policy inspection failed/,
    );
  });

  it("fails closed on malformed sandbox policy metadata", async () => {
    const implementation = mockExeca.getMockImplementation();
    expect(implementation).toBeDefined();
    mockExeca.mockImplementation(async (command: string, args: string[]) =>
      args.join(" ") === "policy get -g test-gateway --full --output json test-sandbox"
        ? { exitCode: 0, stdout: "{}", stderr: "" }
        : implementation!(command, args),
    );

    await expect(actionApply("default", blueprint())).rejects.toThrow(
      /invalid sandbox policy metadata.*must stop/,
    );
  });

  it("fails closed on malformed active global policy metadata", async () => {
    globalActive = true;
    const implementation = mockExeca.getMockImplementation();
    expect(implementation).toBeDefined();
    mockExeca.mockImplementation(async (command: string, args: string[]) =>
      args.join(" ") === "policy get -g test-gateway --global --full --output json"
        ? { exitCode: 0, stdout: "{}", stderr: "" }
        : implementation!(command, args),
    );

    await expect(actionApply("default", blueprint())).rejects.toThrow(
      /invalid global policy metadata.*must stop/,
    );
  });

  it("fails closed on ambiguous global policy history", async () => {
    const implementation = mockExeca.getMockImplementation();
    expect(implementation).toBeDefined();
    mockExeca.mockImplementation(async (command: string, args: string[]) =>
      args.join(" ") === "policy list -g test-gateway --global --limit 1"
        ? { exitCode: 0, stdout: "", stderr: "unexpected diagnostic" }
        : implementation!(command, args),
    );

    await expect(actionApply("default", blueprint())).rejects.toThrow(
      /invalid global policy history.*must stop/,
    );
  });

  it("accepts a global OpenShell policy and still uses the same convenience mutation", async () => {
    globalActive = true;
    await actionApply("default", blueprint());
    expect((livePolicy.network_policies as Record<string, unknown>).nim_service).toEqual(
      additions.nim_service,
    );
  });

  it("persists the gateway without storing requested policy additions", async () => {
    await actionApply("default", blueprint());
    const planEntry = [...store.entries()].find(([path]) => path.endsWith("/plan.json"));
    const plan = JSON.parse(planEntry?.[1].content ?? "{}");
    expect(plan.gateway).toEqual({ name: "test-gateway", host: "127.0.0.1", port: 8080 });
    expect(plan).not.toHaveProperty("policy_additions");
    expect(plan).not.toHaveProperty("policy_authority");
    expect(plan).not.toHaveProperty("policy_transition");
  });

  it("reconcile leaves policy entirely with OpenShell", async () => {
    const runId = "reconcile-live";
    const directory = runDirectory(runId);
    store.set(directory, { type: "dir" });
    store.set(`${directory}/plan.json`, {
      type: "file",
      content: JSON.stringify({
        run_id: runId,
        sandbox_name: "test-sandbox",
        gateway: { name: "test-gateway", host: "127.0.0.1", port: 8080 },
      }),
    });
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    await actionReconcile(runId);
    expect((livePolicy.network_policies as Record<string, unknown>).nim_service).toBeUndefined();
    expect(writes.join("")).toContain("policy is managed directly by OpenShell");
  });

  it("status omits legacy policy lifecycle fields", async () => {
    const runId = "status-live";
    const directory = runDirectory(runId);
    store.set(directory, { type: "dir" });
    store.set(`${directory}/plan.json`, {
      type: "file",
      content: JSON.stringify({ run_id: runId, policy_additions: additions }),
    });
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    actionStatus(runId);
    const output = writes.join("");
    expect(output).not.toContain('"policy_additions"');
    expect(output).not.toContain("policy_authority");
    expect(output).not.toContain("policy_transition");
  });

  it("fails closed when OpenShell cannot return a base policy", async () => {
    basePolicyFailure = "gateway unavailable";
    await expect(actionApply("default", blueprint())).rejects.toThrow();
    expect((livePolicy.network_policies as Record<string, unknown>).nim_service).toBeUndefined();
  });

  it.each([
    ["metadata only", "Version: 1\n---\n"],
    ["malformed YAML", "version: [unterminated"],
    ["array network policies", "version: 1\nnetwork_policies: []\n"],
  ])("rejects an invalid base policy: %s", async (_case, output) => {
    basePolicyOutput = output;
    await expect(actionApply("default", blueprint())).rejects.toThrow();
    expect((livePolicy.network_policies as Record<string, unknown>).nim_service).toBeUndefined();
  });

  it("strips provider-composed entries from the mutation payload", async () => {
    livePolicy = {
      version: 1,
      future_section: { preserve: true },
      network_policies: {
        host_added: { endpoints: [{ host: "host.example", port: 443 }] },
        _provider_token: { endpoints: [{ host: "credential.internal", port: 443 }] },
      },
    };

    await actionApply("default", blueprint());

    expect(livePolicy.future_section).toEqual({ preserve: true });
    expect(livePolicy.network_policies).toEqual(
      expect.objectContaining({
        host_added: expect.any(Object),
        nim_service: additions.nim_service,
      }),
    );
    expect(livePolicy.network_policies).not.toHaveProperty("_provider_token");
  });
});
