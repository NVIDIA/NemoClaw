// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type fs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import {
  createRunnerFsStore,
  createStdoutCapture,
  FAKE_HOME,
  FIXED_RUN_UUID,
  inMemoryFsMethods,
  resolvedEndpointFor,
} from "./runner-mock-fixtures.js";
import {
  gatewayStatusResult,
  globalPolicyAuthorityResult,
  minimalBlueprint,
  resultWithBlueprintPolicyAuthority,
  sandboxPolicyAuthorityResult,
} from "./runner-test-fixtures.js";

const { store } = createRunnerFsStore();
const mockExeca = vi.fn();
const stdoutCapture = createStdoutCapture();

vi.mock("node:crypto", () => ({
  randomUUID: () => FIXED_RUN_UUID,
}));

vi.mock("node:os", () => ({
  homedir: () => FAKE_HOME,
}));

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  const memory = inMemoryFsMethods(store, { spy: vi.fn });
  return {
    ...original,
    existsSync: memory.existsSync,
    mkdirSync: memory.mkdirSync,
    readFileSync: memory.readFileSync,
    readdirSync: memory.readdirSync,
    renameSync: memory.renameSync,
    writeFileSync: memory.writeFileSync,
  };
});

vi.mock("execa", () => ({
  execa: (...args: unknown[]) => mockExeca(...args),
}));

vi.mock("./ssrf.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ssrf.js")>();
  return {
    ...actual,
    validateEndpointUrl: vi.fn(async (url: string) => resolvedEndpointFor(url)),
  };
});

const { actionApply, actionReconcile, actionRollback, actionStatus, main } =
  await import("./runner.js");
const { renameSync } = await import("node:fs");
const mockedRenameSync = vi.mocked(renameSync);

const BASE_POLICY = `version: 1
future_policy:
  opaque_setting:
    keep: true
filesystem_policy:
  default: deny
  roots: [/sandbox]
metadata:
  future_schema: opaque
  preserve: true
network_policies:
  existing_mcp:
    endpoints:
      - host: mcp.example.com
        port: 443
        path: /mcp
        protocol: mcp
        enforcement: enforce
        mcp:
          allow_all_known_mcp_methods: true
          max_body_bytes: 131072
          strict_tool_names: true
        rules:
          - allow:
              method: tools/call
              tool:
                any: [search_web, list_tools]
          - allow:
              method: resources/read
        deny_rules:
          - method: tools/call
            tool:
              any: [send_email, delete_resource]
  existing_json_rpc:
    endpoints:
      - host: rpc.example.com
        port: 443
        path: /rpc
        protocol: json-rpc
        enforcement: enforce
        json_rpc: { max_body_bytes: 131072 }
        rules:
          - allow:
              method: { any: [reports.search, reports.get] }
`;

const FULL_POLICY = `${BASE_POLICY}  _provider_nvidia-inference: {}
`;

function policyOutput(policy: string): string {
  return ["Version: 1", "Hash: sha256:test", "---", policy].join("\n");
}

function policySetCalls(): unknown[][] {
  return mockExeca.mock.calls.filter(
    (call) => Array.isArray(call[1]) && call[1][0] === "policy" && call[1][1] === "set",
  );
}

function defaultCommandResult(args: string[]) {
  return resultWithBlueprintPolicyAuthority(args, {
    exitCode: 0,
    stdout: "",
    stderr: "",
  });
}

function mergedPolicy(): Record<string, unknown> {
  const key = [...store.keys()].find((candidate) => candidate.endsWith("/merged-policy.yaml"));
  expect(key).toBeDefined();
  return YAML.parse(store.get(key ?? "")?.content ?? "");
}

function blueprint(): Parameters<typeof actionApply>[1] {
  return {
    version: "1.0",
    components: {
      inference: {
        profiles: {
          default: {
            provider_type: "openai",
            provider_name: "my-provider",
            endpoint: "https://api.example.com/v1",
            model: "gpt-4",
            credential_env: "MY_API_KEY",
          },
        },
      },
      sandbox: {
        image: "openclaw",
        name: "test-sandbox",
        forward_ports: [18789],
      },
      policy: {
        additions: {
          nim_service: {
            name: "nim_service",
            endpoints: [{ host: "integrate.api.nvidia.com", port: 443, access: "full" }],
          },
        },
      },
    },
  };
}

describe("OpenShell 0.0.72 blueprint policy round-trip", () => {
  beforeEach(() => {
    store.clear();
    stdoutCapture.reset();
    mockExeca.mockReset();
    vi.spyOn(process.stdout, "write").mockImplementation(stdoutCapture.write);
    const policyByCommand = new Map([
      ["policy get -g test-gateway --base test-sandbox", policyOutput(BASE_POLICY)],
      ["policy get -g test-gateway --full test-sandbox", policyOutput(FULL_POLICY)],
    ]);
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) => {
      const policy = policyByCommand.get(args.join(" "));
      return policy === undefined
        ? defaultCommandResult(args)
        : { exitCode: 0, stdout: policy, stderr: "" };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves MCP, JSON-RPC, and unknown mapping sections without provider entries", async () => {
    await actionApply("default", blueprint());

    expect(mockExeca).toHaveBeenCalledWith(
      "openshell",
      ["policy", "get", "-g", "test-gateway", "--base", "test-sandbox"],
      expect.objectContaining({ reject: false }),
    );
    expect(mockExeca).not.toHaveBeenCalledWith(
      "openshell",
      ["policy", "get", "-g", "test-gateway", "--full", "test-sandbox"],
      expect.anything(),
    );

    const merged = mergedPolicy() as {
      future_policy: { opaque_setting: { keep: boolean } };
      filesystem_policy: { default: string; roots: string[] };
      metadata: { future_schema: string; preserve: boolean };
      network_policies: Record<string, unknown>;
    };
    expect(merged.future_policy).toEqual({ opaque_setting: { keep: true } });
    expect(merged.filesystem_policy).toEqual({ default: "deny", roots: ["/sandbox"] });
    expect(merged.metadata).toEqual({ future_schema: "opaque", preserve: true });
    expect(merged.network_policies).toEqual({
      ...YAML.parse(BASE_POLICY).network_policies,
      nim_service: expect.any(Object),
    });
    expect(merged.network_policies).not.toHaveProperty("_provider_nvidia-inference");
    const planEntry = [...store.values()].find((entry) =>
      entry.content?.includes('"policy_transition"'),
    );
    expect(JSON.parse(planEntry?.content ?? "{}")).toMatchObject({
      policy_transition: {
        status: "complete",
        sandbox_name: "test-sandbox",
        gateway: "test-gateway",
        expected_authority: "nemoclaw-managed",
        policy_addition_names: ["nim_service"],
      },
    });
  });

  it.each([
    ["scalar", "future_mode", "future_mode: strict\n"],
    ["sequence", "future_features", "future_features: [audit, attribution]\n"],
  ])("fails closed for an unknown top-level %s", async (_shape, key, fragment) => {
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
      args.join(" ") === "policy get -g test-gateway --base test-sandbox"
        ? { exitCode: 0, stdout: policyOutput(`${fragment}${BASE_POLICY}`), stderr: "" }
        : defaultCommandResult(args),
    );

    await expect(actionApply("default", blueprint())).rejects.toThrow(
      `Current policy top-level field "${key}" must be a YAML mapping`,
    );
    expect(policySetCalls()).toEqual([]);
  });

  it("fails closed when policy get --base fails", async () => {
    const diagnostic = `MY_API_KEY=super-secret ${"policy details ".repeat(80)}`;
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
      args.join(" ") === "policy get -g test-gateway --base test-sandbox"
        ? { exitCode: 1, stdout: "", stderr: diagnostic }
        : defaultCommandResult(args),
    );

    const error = await actionApply("default", blueprint()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "Failed to read current policy before applying additions",
    );
    expect((error as Error).message).toContain("MY_API_KEY=<REDACTED>");
    expect((error as Error).message).not.toContain("super-secret");
    expect((error as Error).message).toContain("…");
    expect((error as Error).message.length).toBeLessThan(600);
    expect(policySetCalls()).toEqual([]);
  });

  it("fails closed when policy get --base returns metadata without a policy document", async () => {
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
      args.join(" ") === "policy get -g test-gateway --base test-sandbox"
        ? { exitCode: 0, stdout: "Version: 1\nHash: sha256:test\n", stderr: "" }
        : defaultCommandResult(args),
    );

    await expect(actionApply("default", blueprint())).rejects.toThrow(
      /does not contain a policy YAML document/,
    );
    expect(policySetCalls()).toEqual([]);
  });

  it("filters a malformed provider-composed entry returned by --base", async () => {
    const malformedBase = YAML.parse(BASE_POLICY);
    malformedBase.network_policies["_provider_unexpected"] = {
      endpoints: [{ host: "provider.invalid", port: 443, access: "full" }],
    };
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
      args.join(" ") === "policy get -g test-gateway --base test-sandbox"
        ? { exitCode: 0, stdout: policyOutput(YAML.stringify(malformedBase)), stderr: "" }
        : defaultCommandResult(args),
    );

    await actionApply("default", blueprint());
    const merged = mergedPolicy() as {
      network_policies: Record<string, unknown>;
    };
    expect(merged.network_policies).not.toHaveProperty("_provider_unexpected");
    expect(merged.network_policies).toHaveProperty("existing_mcp");
    expect(merged.network_policies).toHaveProperty("existing_json_rpc");
  });

  it("filters reserved provider entries from the final blueprint mutation payload", async () => {
    const blueprintWithReservedAddition = blueprint();
    blueprintWithReservedAddition.components!.policy!.additions!._provider_injected = {
      name: "must-not-submit",
      endpoints: [{ host: "provider.invalid", port: 443, access: "full" }],
    };

    await actionApply("default", blueprintWithReservedAddition);

    const merged = mergedPolicy() as {
      network_policies: Record<string, unknown>;
    };
    expect(merged.network_policies).not.toHaveProperty("_provider_injected");
    expect(merged.network_policies).toHaveProperty("nim_service");
  });

  it("fails closed for a legacy network_policies array instead of dropping it", async () => {
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
      args.join(" ") === "policy get -g test-gateway --base test-sandbox"
        ? {
            exitCode: 0,
            stdout: policyOutput("version: 1\nnetwork_policies:\n  - name: legacy\n"),
            stderr: "",
          }
        : defaultCommandResult(args),
    );

    await expect(actionApply("default", blueprint())).rejects.toThrow(
      /network_policies must be a YAML mapping/,
    );
    expect(policySetCalls()).toEqual([]);
  });

  it("uses exact external additions without mutating policy (#9833)", async () => {
    const bp = blueprint();
    const additions = bp.components!.policy!.additions!;
    vi.stubEnv("OPENSHELL_SANDBOX_POLICY", "/tmp/caller-policy.yaml");
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
      args.join(" ") === "status"
        ? gatewayStatusResult("recorded-gateway")
        : args.join(" ") === "policy list -g recorded-gateway --global --limit 1"
          ? { exitCode: 0, stdout: "VERSION STATUS\n1 loaded\n", stderr: "" }
          : args.join(" ") === "policy get -g recorded-gateway --global --full --output json"
            ? globalPolicyAuthorityResult(additions)
            : args.join(" ") === "policy get -g recorded-gateway --full --output json test-sandbox"
              ? sandboxPolicyAuthorityResult("test-sandbox", "externally-managed", additions)
              : { exitCode: 0, stdout: "", stderr: "" },
    );

    await actionApply("default", bp);

    const policyCalls = mockExeca.mock.calls.filter(
      (call) => Array.isArray(call[1]) && call[1][0] === "policy",
    );
    expect(policyCalls.every((call) => call[1].includes("recorded-gateway"))).toBe(true);
    expect(policySetCalls()).toEqual([]);
    const sandboxCreate = mockExeca.mock.calls.find(
      (call) => Array.isArray(call[1]) && call[1][0] === "sandbox" && call[1][1] === "create",
    );
    expect(sandboxCreate?.[2].env).not.toHaveProperty("OPENSHELL_SANDBOX_POLICY");
  });

  it("refuses missing external additions before creating a sandbox (#9833)", async () => {
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
      args.join(" ") === "status"
        ? gatewayStatusResult()
        : args.join(" ") === "policy list -g test-gateway --global --limit 1"
          ? { exitCode: 0, stdout: "VERSION STATUS\n1 loaded\n", stderr: "" }
          : args.join(" ") === "policy get -g test-gateway --global --full --output json"
            ? globalPolicyAuthorityResult()
            : { exitCode: 0, stdout: "", stderr: "" },
    );

    await expect(actionApply("default", blueprint())).rejects.toThrow(
      /missing entries "nim_service"/,
    );
    expect(
      mockExeca.mock.calls.some(
        (call) => Array.isArray(call[1]) && call[1][0] === "sandbox" && call[1][1] === "create",
      ),
    ).toBe(false);
  });

  it("fails closed on malformed global authority before sandbox creation (#9833)", async () => {
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
      args.join(" ") === "status"
        ? gatewayStatusResult()
        : args.join(" ") === "policy list -g test-gateway --global --limit 1"
          ? { exitCode: 0, stdout: "VERSION STATUS\n1 loaded\n", stderr: "" }
          : args.join(" ") === "policy get -g test-gateway --global --full --output json"
            ? { exitCode: 0, stdout: "{", stderr: "" }
            : { exitCode: 0, stdout: "", stderr: "" },
    );

    await expect(actionApply("default", minimalBlueprint())).rejects.toThrow(
      /malformed global policy authority metadata/,
    );
    expect(
      mockExeca.mock.calls.some(
        (call) => Array.isArray(call[1]) && call[1][0] === "sandbox" && call[1][1] === "create",
      ),
    ).toBe(false);
  });

  it("stops before provider and policy mutation when sandbox authority is malformed (#9833)", async () => {
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
      args.join(" ") === "policy get -g test-gateway --full --output json test-sandbox"
        ? { exitCode: 0, stdout: "{", stderr: "" }
        : defaultCommandResult(args),
    );

    await expect(actionApply("default", minimalBlueprint())).rejects.toThrow(
      /malformed sandbox policy authority metadata/,
    );
    expect(
      mockExeca.mock.calls.some(
        (call) => Array.isArray(call[1]) && call[1][0] === "provider" && call[1][1] === "create",
      ),
    ).toBe(false);
    expect(policySetCalls()).toEqual([]);
  });

  it("rechecks authority immediately before a managed policy mutation (#9833)", async () => {
    let sandboxAuthorityReads = 0;
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) => {
      switch (args.join(" ")) {
        case "sandbox create --from openclaw --name test-sandbox --forward 18789":
          return { exitCode: 1, stdout: "", stderr: "sandbox already exists" };
        case "policy get -g test-gateway --base test-sandbox":
          return {
            exitCode: 0,
            stdout: "Version: 1\nHash: sha256:test\n---\nversion: 1\nnetwork_policies: {}\n",
            stderr: "",
          };
        case "policy get -g test-gateway --full --output json test-sandbox":
          sandboxAuthorityReads += 1;
          return sandboxPolicyAuthorityResult(
            "test-sandbox",
            sandboxAuthorityReads < 3 ? "nemoclaw-managed" : "externally-managed",
          );
        default:
          return defaultCommandResult(args);
      }
    });

    await expect(actionApply("default", blueprint())).rejects.toThrow(/policy authority changed/);
    expect(policySetCalls()).toEqual([]);
    expect(sandboxAuthorityReads).toBe(3);
  });

  it("records and reports an incomplete reused-sandbox policy transition (#9833)", async () => {
    let sandboxAuthorityReads = 0;
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) => {
      switch (args.join(" ")) {
        case "sandbox create --from openclaw --name test-sandbox --forward 18789":
          return { exitCode: 1, stdout: "", stderr: "sandbox already exists" };
        case "policy get -g test-gateway --base test-sandbox":
          return {
            exitCode: 0,
            stdout: "Version: 1\nHash: sha256:test\n---\nversion: 1\nnetwork_policies: {}\n",
            stderr: "",
          };
        case "policy get -g test-gateway --full --output json test-sandbox":
          sandboxAuthorityReads += 1;
          return sandboxPolicyAuthorityResult(
            "test-sandbox",
            sandboxAuthorityReads < 4 ? "nemoclaw-managed" : "externally-managed",
          );
        default:
          return defaultCommandResult(args);
      }
    });

    await expect(actionApply("default", blueprint())).rejects.toThrow(/policy authority changed/);
    expect(policySetCalls()).toHaveLength(1);
    expect(sandboxAuthorityReads).toBe(4);

    const planEntry = [...store.entries()].find(([path]) => path.endsWith("/plan.json"));
    expect(planEntry).toBeDefined();
    const plan = JSON.parse(planEntry?.[1].content ?? "{}") as {
      run_id: string;
      sandbox_created_by_apply: boolean;
      policy_transition: Record<string, unknown>;
    };
    expect(plan).toMatchObject({
      sandbox_created_by_apply: false,
      policy_transition: {
        status: "incomplete",
        sandbox_name: "test-sandbox",
        gateway: "test-gateway",
        expected_authority: "nemoclaw-managed",
        policy_addition_names: ["nim_service"],
      },
    });

    stdoutCapture.reset();
    actionStatus(plan.run_id);
    expect(stdoutCapture.jsonOutput()).toMatchObject({
      policy_transition: {
        status: "incomplete",
        sandbox_name: "test-sandbox",
        reconciliation_required: true,
        reconciliation_action: expect.stringContaining("Run reconcile"),
      },
    });

    await expect(actionRollback(plan.run_id)).rejects.toThrow(
      /policy transition for reused sandbox "test-sandbox".*is incomplete.*reconcile/u,
    );
    expect(store.has(`${planEntry?.[0].replace(/\/plan\.json$/u, "")}/rolled_back`)).toBe(false);

    mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
      args.join(" ") === "policy get -g test-gateway --full --output json test-sandbox"
        ? sandboxPolicyAuthorityResult(
            "test-sandbox",
            "nemoclaw-managed",
            blueprint().components!.policy!.additions!,
          )
        : defaultCommandResult(args),
    );
    stdoutCapture.reset();
    await main(["reconcile", "--run-id", plan.run_id]);
    expect(stdoutCapture.text()).toContain(`Policy transition for run ${plan.run_id} is complete.`);
    expect(JSON.parse(store.get(planEntry?.[0] ?? "")?.content ?? "{}")).toMatchObject({
      policy_transition: { status: "complete" },
    });

    await actionRollback(plan.run_id);
    expect(store.has(`${planEntry?.[0].replace(/\/plan\.json$/u, "")}/rolled_back`)).toBe(true);
  });

  it("keeps a pending receipt when a reused-sandbox policy set fails (#9833)", async () => {
    const diagnostic = `POLICY_TOKEN=super-secret ${"policy details ".repeat(80)}`;
    const responses = new Map([
      [
        "sandbox create --from openclaw --name test-sandbox --forward 18789",
        { exitCode: 1, stdout: "", stderr: "sandbox already exists" },
      ],
      [
        "policy get -g test-gateway --base test-sandbox",
        {
          exitCode: 0,
          stdout: policyOutput("version: 1\nnetwork_policies: {}\n"),
          stderr: "",
        },
      ],
      ["policy set", { exitCode: 1, stdout: "", stderr: diagnostic }],
    ]);
    mockExeca.mockImplementation(
      async (_cmd: string, args: string[]) =>
        responses.get(args.join(" ")) ??
        responses.get(args.slice(0, 2).join(" ")) ??
        defaultCommandResult(args),
    );

    const error = await actionApply("default", blueprint()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Failed to apply policy additions");
    expect((error as Error).message).toContain("POLICY_TOKEN=<REDACTED>");
    expect((error as Error).message).not.toContain("super-secret");
    expect((error as Error).message).toContain("…");
    expect((error as Error).message.length).toBeLessThan(600);
    const planEntry = [...store.entries()].find(([, entry]) =>
      entry.content?.includes('"policy_transition"'),
    );
    const plan = JSON.parse(planEntry?.[1].content ?? "{}") as { run_id: string };
    expect(plan).toMatchObject({
      sandbox_created_by_apply: false,
      policy_transition: {
        status: "pending",
        sandbox_name: "test-sandbox",
        gateway: "test-gateway",
        policy_addition_names: ["nim_service"],
      },
    });

    mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
      args.join(" ") === "policy get -g test-gateway --full --output json test-sandbox"
        ? sandboxPolicyAuthorityResult(
            "test-sandbox",
            "nemoclaw-managed",
            blueprint().components!.policy!.additions!,
          )
        : defaultCommandResult(args),
    );
    await actionReconcile(plan.run_id);
    expect(JSON.parse(store.get(planEntry?.[0] ?? "")?.content ?? "{}")).toMatchObject({
      policy_transition: { status: "complete" },
    });
  });

  it.each([
    ["authority change", "externally-managed" as const, blueprint().components!.policy!.additions!],
    ["missing addition", "nemoclaw-managed" as const, {}],
  ])(
    "retains an incomplete receipt after a reconciliation %s (#9833)",
    async (_case, authority, observed) => {
      const runId = "incomplete-transition";
      const stateDir = `${FAKE_HOME}/.nemoclaw/state/runs/${runId}`;
      const additions = blueprint().components!.policy!.additions!;
      store.set(stateDir, { type: "dir" });
      store.set(`${stateDir}/plan.json`, {
        type: "file",
        content: JSON.stringify({
          run_id: runId,
          sandbox_name: "test-sandbox",
          sandbox_created_by_apply: false,
          policy_additions: additions,
          policy_transition: {
            status: "incomplete",
            sandbox_name: "test-sandbox",
            gateway: "recorded-gateway",
            expected_authority: "nemoclaw-managed",
            policy_addition_names: ["nim_service"],
          },
        }),
      });
      mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
        args.join(" ") === "policy get -g recorded-gateway --full --output json test-sandbox"
          ? sandboxPolicyAuthorityResult("test-sandbox", authority, observed)
          : defaultCommandResult(args),
      );

      await expect(actionReconcile(runId)).rejects.toThrow(/Cannot reconcile/u);
      expect(JSON.parse(store.get(`${stateDir}/plan.json`)?.content ?? "{}")).toMatchObject({
        policy_transition: { status: "incomplete" },
      });
      await expect(actionRollback(runId)).rejects.toThrow(/is incomplete/u);
    },
  );

  it("rejects an invalid persisted policy transition (#9833)", async () => {
    const runId = "invalid-transition";
    const stateDir = `${FAKE_HOME}/.nemoclaw/state/runs/${runId}`;
    store.set(stateDir, { type: "dir" });
    store.set(`${stateDir}/plan.json`, {
      type: "file",
      content: JSON.stringify({
        run_id: runId,
        sandbox_name: "test-sandbox",
        sandbox_created_by_apply: false,
        policy_transition: {
          status: "unknown",
          sandbox_name: "test-sandbox",
          gateway: "test-gateway",
          expected_authority: "nemoclaw-managed",
          policy_addition_names: ["nim_service"],
        },
      }),
    });

    stdoutCapture.reset();
    actionStatus(runId);
    expect(stdoutCapture.jsonOutput()).toMatchObject({
      run_id: runId,
      status: "unknown",
      receipt_error_kind: "invalid",
      run_directory: stateDir,
      recovery: expect.stringContaining("Do not reconstruct plan.json"),
    });
    await expect(actionReconcile(runId)).rejects.toThrow(/policy transition receipt is invalid/u);
    await expect(actionRollback(runId)).rejects.toThrow(/policy transition receipt is invalid/u);
    expect(mockExeca).not.toHaveBeenCalled();
  });

  const reconciliationPlan = {
    run_id: "invalid-reconciliation",
    sandbox_name: "test-sandbox",
    sandbox_created_by_apply: false,
    policy_additions: blueprint().components!.policy!.additions!,
    policy_transition: {
      status: "incomplete",
      sandbox_name: "test-sandbox",
      gateway: "test-gateway",
      expected_authority: "nemoclaw-managed",
      policy_addition_names: ["nim_service"],
    },
  };

  it.each([
    ["a non-object body", [], /plan\.json must contain a JSON object/u],
    [
      "an apply-owned sandbox",
      { ...reconciliationPlan, sandbox_created_by_apply: true },
      /requires a reused sandbox/u,
    ],
    [
      "a mismatched sandbox",
      { ...reconciliationPlan, sandbox_name: "other-sandbox" },
      /sandbox does not match/u,
    ],
    [
      "invalid policy additions",
      { ...reconciliationPlan, policy_additions: [] },
      /policy additions are invalid/u,
    ],
    [
      "mismatched policy addition names",
      {
        ...reconciliationPlan,
        policy_transition: {
          ...reconciliationPlan.policy_transition,
          policy_addition_names: ["other"],
        },
      },
      /additions do not match/u,
    ],
  ])("rejects a reconciliation plan with %s (#9833)", async (_case, plan, expected) => {
    const runId = "invalid-reconciliation";
    const stateDir = `${FAKE_HOME}/.nemoclaw/state/runs/${runId}`;
    store.set(stateDir, { type: "dir" });
    store.set(`${stateDir}/plan.json`, { type: "file", content: JSON.stringify(plan) });

    await expect(actionReconcile(runId)).rejects.toThrow(expected);
  });

  it("rejects reconciliation for a missing run (#9833)", async () => {
    await expect(actionReconcile("missing-reconciliation")).rejects.toThrow(/not found/u);
  });

  it("preserves the previous receipt when reconciliation replacement is interrupted (#9833)", async () => {
    const runId = "interrupted-reconciliation";
    const stateDir = `${FAKE_HOME}/.nemoclaw/state/runs/${runId}`;
    const planFile = `${stateDir}/plan.json`;
    store.set(stateDir, { type: "dir" });
    store.set(planFile, {
      type: "file",
      content: JSON.stringify({ ...reconciliationPlan, run_id: runId }),
    });
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
      args.join(" ") === "policy get -g test-gateway --full --output json test-sandbox"
        ? sandboxPolicyAuthorityResult(
            "test-sandbox",
            "nemoclaw-managed",
            blueprint().components!.policy!.additions!,
          )
        : defaultCommandResult(args),
    );
    mockedRenameSync.mockImplementationOnce(() => {
      throw new Error("simulated interrupted receipt replacement");
    });

    await expect(actionReconcile(runId)).rejects.toThrow(/interrupted receipt replacement/u);
    expect(JSON.parse(store.get(planFile)?.content ?? "{}")).toMatchObject({
      policy_transition: { status: "incomplete" },
    });

    stdoutCapture.reset();
    actionStatus(runId);
    expect(stdoutCapture.jsonOutput()).toMatchObject({
      policy_transition: { status: "incomplete", reconciliation_required: true },
    });
    await expect(actionRollback(runId)).rejects.toThrow(/is incomplete.*reconcile/u);

    await actionReconcile(runId);
    expect(JSON.parse(store.get(planFile)?.content ?? "{}")).toMatchObject({
      policy_transition: { status: "complete" },
    });
  });

  it("treats a complete reconciliation as idempotent and requires a CLI run ID (#9833)", async () => {
    const runId = "complete-reconciliation";
    const stateDir = `${FAKE_HOME}/.nemoclaw/state/runs/${runId}`;
    store.set(stateDir, { type: "dir" });
    store.set(`${stateDir}/plan.json`, {
      type: "file",
      content: JSON.stringify({
        ...reconciliationPlan,
        run_id: runId,
        policy_transition: {
          ...reconciliationPlan.policy_transition,
          status: "complete",
        },
      }),
    });

    await actionReconcile(runId);

    expect(stdoutCapture.text()).toContain(
      `Policy transition for run ${runId} is already complete.`,
    );
    expect(mockExeca).not.toHaveBeenCalled();
    await expect(main(["reconcile"])).rejects.toThrow(/--run-id is required/u);
  });
});
