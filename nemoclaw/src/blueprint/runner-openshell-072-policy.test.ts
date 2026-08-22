// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type fs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import {
  createRunnerFsStore,
  FAKE_HOME,
  FIXED_RUN_UUID,
  inMemoryFsMethods,
  resolvedEndpointFor,
} from "./runner-mock-fixtures.js";
import {
  createInferenceRouteResult,
  gatewayStatusResult,
  globalPolicyAbsentResult,
  globalPolicyAuthorityResult,
  globalPolicyHistoryResult,
  minimalBlueprint,
  sandboxPolicyAuthorityResult,
  successResult,
} from "./runner-test-fixtures.js";

const { store } = createRunnerFsStore();
const mockExeca = vi.fn();
const mockCloseSync = vi.hoisted(() => vi.fn());
const mockFsyncSync = vi.hoisted(() => vi.fn());
const mockOpenSync = vi.hoisted(() => vi.fn());
const mockWriteFileSync = vi.hoisted(() => vi.fn());
const mockRenameSync = vi.hoisted(() => vi.fn());
const mockUnlinkSync = vi.hoisted(() => vi.fn());
let inferenceRouteResult = createInferenceRouteResult("gateway-a");

vi.mock("node:crypto", () => ({
  randomUUID: () => FIXED_RUN_UUID,
}));

vi.mock("node:os", () => ({
  homedir: () => FAKE_HOME,
}));

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  const memory = inMemoryFsMethods(store, { spy: vi.fn });
  mockCloseSync.mockImplementation(memory.closeSync);
  mockFsyncSync.mockImplementation(memory.fsyncSync);
  mockOpenSync.mockImplementation(memory.openSync);
  mockWriteFileSync.mockImplementation(memory.writeFileSync);
  mockRenameSync.mockImplementation(memory.renameSync);
  mockUnlinkSync.mockImplementation(memory.unlinkSync);
  return {
    ...original,
    closeSync: mockCloseSync,
    fsyncSync: mockFsyncSync,
    mkdirSync: memory.mkdirSync,
    openSync: mockOpenSync,
    readFileSync: memory.readFileSync,
    readdirSync: memory.readdirSync,
    renameSync: mockRenameSync,
    unlinkSync: mockUnlinkSync,
    writeFileSync: mockWriteFileSync,
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

const { BlueprintPolicyAuthorityRefusalError } = await import("./runtime-identity.js");
const { actionApply } = await import("./runner.js");

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
  const fallback =
    args.join(" ") === "policy list -g gateway-a --global --limit 1"
      ? globalPolicyAbsentResult()
      : args.join(" ") === "status"
        ? gatewayStatusResult("gateway-a")
        : args.join(" ") === "sandbox get -g gateway-a test-sandbox"
          ? { exitCode: 0, stdout: "Name: test-sandbox\nPhase: Ready", stderr: "" }
          : args.join(" ") === "policy get -g gateway-a --full --output json test-sandbox"
            ? sandboxPolicyAuthorityResult("test-sandbox")
            : successResult();
  return inferenceRouteResult(args, fallback);
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
    vi.clearAllMocks();
    store.clear();
    inferenceRouteResult = createInferenceRouteResult("gateway-a");
    mockExeca.mockReset();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const policyByCommand = new Map([
      ["policy get -g gateway-a --base test-sandbox", policyOutput(BASE_POLICY)],
      ["policy get -g gateway-a --full test-sandbox", policyOutput(FULL_POLICY)],
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
    vi.unstubAllEnvs();
  });

  it("preserves MCP, JSON-RPC, and unknown mapping sections without provider entries", async () => {
    await actionApply("default", blueprint());
    expect(mockExeca).toHaveBeenCalledWith(
      "openshell",
      ["policy", "get", "-g", "gateway-a", "--base", "test-sandbox"],
      expect.objectContaining({ reject: false }),
    );
    expect(mockExeca).not.toHaveBeenCalledWith(
      "openshell",
      ["policy", "get", "-g", "gateway-a", "--full", "test-sandbox"],
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
  });

  it.each([
    ["scalar", "future_mode", "future_mode: strict\n"],
    ["sequence", "future_features", "future_features: [audit, attribution]\n"],
  ])("fails closed for an unknown top-level %s", async (_shape, key, fragment) => {
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
      args.join(" ") === "policy get -g gateway-a --base test-sandbox"
        ? { exitCode: 0, stdout: policyOutput(`${fragment}${BASE_POLICY}`), stderr: "" }
        : defaultCommandResult(args),
    );
    await expect(actionApply("default", blueprint())).rejects.toThrow(
      `Current policy top-level field "${key}" must be a YAML mapping`,
    );
    expect(policySetCalls()).toEqual([]);
  });
  it("fails closed when policy get --base fails", async () => {
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
      args.join(" ") === "policy get -g gateway-a --base test-sandbox"
        ? { exitCode: 1, stdout: "", stderr: "gateway unavailable" }
        : defaultCommandResult(args),
    );

    await expect(actionApply("default", blueprint())).rejects.toThrow(
      /Failed to read current policy.*gateway unavailable/,
    );
    expect(policySetCalls()).toEqual([]);
  });

  it("fails closed when policy get --base returns metadata without a policy document", async () => {
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
      args.join(" ") === "policy get -g gateway-a --base test-sandbox"
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
      args.join(" ") === "policy get -g gateway-a --base test-sandbox"
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
      args.join(" ") === "policy get -g gateway-a --base test-sandbox"
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

  it("records external authority and omits ambient create policy without additions (#9833)", async () => {
    vi.stubEnv("OPENSHELL_SANDBOX_POLICY", "/tmp/caller-policy.yaml");
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
      args.join(" ") === "policy list -g gateway-a --global --limit 1"
        ? globalPolicyHistoryResult()
        : args.join(" ") === "policy get -g gateway-a --global --full --output json"
          ? globalPolicyAuthorityResult()
          : args.join(" ") === "policy get -g gateway-a --full --output json test-sandbox"
            ? sandboxPolicyAuthorityResult("test-sandbox", "externally-managed")
            : defaultCommandResult(args),
    );

    await actionApply("default", minimalBlueprint());

    const createCall = mockExeca.mock.calls.find(([, args]) => args[0] === "sandbox");
    expect(createCall?.[2].env).not.toHaveProperty("OPENSHELL_SANDBOX_POLICY");
    const plan = [...store.entries()].find(([key]) => key.endsWith("/plan.json"))?.[1];
    expect(JSON.parse(plan?.content ?? "{}").policy_authority).toEqual({
      authority: "externally-managed",
      scope: "sandbox",
      sandbox_name: "test-sandbox",
    });
    expect(policySetCalls()).toEqual([]);
  });

  it.each([
    ["empty stdout", { exitCode: 0, stdout: "", stderr: "" }],
    [
      "empty stdout and an informational stderr message",
      { exitCode: 0, stdout: "", stderr: "No policy revisions exist" },
    ],
  ])("accepts a fresh gateway when policy list returns %s (#9833)", async (_label, result) => {
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
      args.join(" ") === "policy list -g gateway-a --global --limit 1"
        ? result
        : defaultCommandResult(args),
    );

    await expect(actionApply("default", minimalBlueprint())).resolves.toBeUndefined();

    const commands = mockExeca.mock.calls.map(([, args]) => args.join(" "));
    expect(commands.some((command) => command.startsWith("sandbox create "))).toBe(true);
    expect(commands).not.toContain("policy get -g gateway-a --global --full --output json");
  });

  it.each([
    ["empty global metadata", () => globalPolicyHistoryResult(), () => successResult()],
    [
      "malformed global metadata",
      () => globalPolicyHistoryResult(),
      () => ({ ...successResult(), stdout: "{" }),
    ],
    [
      "non-object global metadata",
      () => globalPolicyHistoryResult(),
      () => ({ ...successResult(), stdout: "[]" }),
    ],
    [
      "unsupported global status",
      () => globalPolicyHistoryResult(),
      () => ({
        ...successResult(),
        stdout: JSON.stringify({
          scope: "global",
          status: "effective",
          policy_source: "global",
          policy: {},
        }),
      }),
    ],
    [
      "missing loaded global policy",
      () => globalPolicyHistoryResult(),
      () => ({
        ...successResult(),
        stdout: JSON.stringify({ scope: "global", status: "loaded", policy_source: "global" }),
      }),
    ],
    [
      "failed global history command",
      () => ({ exitCode: 1, stdout: "", stderr: "history denied" }),
      () => successResult(),
    ],
    [
      "thrown global history command",
      () => {
        throw new Error("history spawn denied");
      },
      () => successResult(),
    ],
  ])("fails closed on %s (#9833)", async (_case, historyResult, metadataResult) => {
    const responses = new Map([
      ["policy list -g gateway-a --global --limit 1", historyResult],
      ["policy get -g gateway-a --global --full --output json", metadataResult],
    ]);
    mockExeca.mockImplementation(
      async (_cmd: string, args: string[]) =>
        responses.get(args.join(" "))?.() ?? defaultCommandResult(args),
    );

    const error = await actionApply("default", minimalBlueprint()).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(BlueprintPolicyAuthorityRefusalError);
    expect(
      mockExeca.mock.calls.some(([, args]) => args[0] === "sandbox" && args[1] === "create"),
    ).toBe(false);
  });

  it.each(["", " \n\t"])(
    "accepts successful empty sandbox policy output (#9833)",
    async (stdout) => {
      mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
        args.join(" ") === "policy get -g gateway-a --full --output json test-sandbox"
          ? { ...successResult(), stdout }
          : defaultCommandResult(args),
      );
      await expect(actionApply("default", minimalBlueprint())).resolves.toBeUndefined();
    },
  );

  it("records global authority before refusing missing external requirements (#9833)", async () => {
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
      args.join(" ") === "policy list -g gateway-a --global --limit 1"
        ? globalPolicyHistoryResult()
        : args.join(" ") === "policy get -g gateway-a --global --full --output json"
          ? globalPolicyAuthorityResult()
          : defaultCommandResult(args),
    );

    await expect(actionApply("default", blueprint())).rejects.toThrow(
      /missing entries "nim_service"/,
    );

    const plan = [...store.entries()].find(([key]) => key.endsWith("/plan.json"))?.[1];
    expect(JSON.parse(plan?.content ?? "{}").policy_authority).toEqual({
      authority: "externally-managed",
      scope: "global",
    });
    const commands = mockExeca.mock.calls.map(([, args]) => args.join(" "));
    expect(commands.some((command) => command.startsWith("sandbox create "))).toBe(false);
    expect(commands.some((command) => command.startsWith("provider create "))).toBe(false);
  });

  it("does not report completion when authority changes after policy mutation (#9833)", async () => {
    let policySetCompleted = false;
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) => {
      switch (args.join(" ")) {
        case "policy get -g gateway-a --full --output json test-sandbox":
          return sandboxPolicyAuthorityResult(
            "test-sandbox",
            policySetCompleted ? "externally-managed" : "nemoclaw-managed",
          );
        case "policy get -g gateway-a --base test-sandbox":
          return { exitCode: 0, stdout: policyOutput(BASE_POLICY), stderr: "" };
        default:
          policySetCompleted ||= args[0] === "policy" && args[1] === "set";
          return defaultCommandResult(args);
      }
    });
    const error = await actionApply("default", blueprint()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BlueprintPolicyAuthorityRefusalError);
    expect((error as Error).message).toMatch(/authority changed/);
    expect(policySetCalls()).toHaveLength(1);
    expect(vi.mocked(process.stdout.write).mock.calls.flat().join("")).not.toContain(
      "Apply complete",
    );
    const commands = mockExeca.mock.calls.map(([, args]) => args.join(" "));
    expect(commands).toContain("sandbox stop -g gateway-a test-sandbox");
    expect(commands).toContain("sandbox remove -g gateway-a test-sandbox");
    expect(commands).toContain("provider delete -g gateway-a my-provider");
    expect(commands.indexOf("sandbox stop -g gateway-a test-sandbox")).toBeLessThan(
      commands.indexOf("sandbox remove -g gateway-a test-sandbox"),
    );
    expect(commands.indexOf("sandbox remove -g gateway-a test-sandbox")).toBeLessThan(
      commands.indexOf("provider delete -g gateway-a my-provider"),
    );
    const plan = [...store.entries()].find(([key]) => key.endsWith("/plan.json"))?.[1];
    expect(JSON.parse(plan?.content ?? "{}")).toMatchObject({
      sandbox_created_by_apply: false,
      inference_provider_created_by_apply: false,
    });
  });
});
