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

  it("accepts a global OpenShell policy and still uses the same convenience mutation", async () => {
    globalActive = true;
    await actionApply("default", blueprint());
    expect((livePolicy.network_policies as Record<string, unknown>).nim_service).toEqual(
      additions.nim_service,
    );
  });

  it("persists gateway and requested additions without policy ownership state", async () => {
    await actionApply("default", blueprint());
    const planEntry = [...store.entries()].find(([path]) => path.endsWith("/plan.json"));
    const plan = JSON.parse(planEntry?.[1].content ?? "{}");
    expect(plan.gateway).toEqual({ name: "test-gateway", host: "127.0.0.1", port: 8080 });
    expect(plan.policy_additions).toEqual(additions);
    expect(plan).not.toHaveProperty("policy_authority");
    expect(plan).not.toHaveProperty("policy_transition");
  });

  it("reconcile rereads OpenShell and applies missing requirements", async () => {
    const runId = "reconcile-live";
    const directory = runDirectory(runId);
    store.set(directory, { type: "dir" });
    store.set(`${directory}/plan.json`, {
      type: "file",
      content: JSON.stringify({
        run_id: runId,
        sandbox_name: "test-sandbox",
        gateway: { name: "test-gateway", host: "127.0.0.1", port: 8080 },
        policy_additions: additions,
      }),
    });
    await actionReconcile(runId);
    expect((livePolicy.network_policies as Record<string, unknown>).nim_service).toEqual(
      additions.nim_service,
    );
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
    expect(output).toContain('"policy_additions"');
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
