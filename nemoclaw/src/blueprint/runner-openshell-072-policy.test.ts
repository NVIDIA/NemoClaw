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
  globalPolicySupersededResult,
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
const { actionApply, actionRollback } = await import("./runner.js");

type CommandResult = { exitCode: number; stdout: string; stderr: string };
type QueuedCommandResult = CommandResult | (() => CommandResult);

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

function inferenceRouteOutput(provider: string, model: string, timeoutSeconds: number): string {
  return [
    "Gateway inference:",
    "",
    `  Provider: ${provider}`,
    `  Model: ${model}`,
    "  Version: 1",
    `  Timeout: ${String(timeoutSeconds)}s`,
    "",
  ].join("\n");
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

function commandResponseQueue(overrides: Array<[string, QueuedCommandResult[]]>): void {
  const responses = new Map(overrides);
  mockExeca.mockImplementation(async (_cmd: string, args: string[]) => {
    const command = args.join(" ");
    const queued = responses.get(command)?.shift();
    return typeof queued === "function" ? queued() : (queued ?? defaultCommandResult(args));
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

  it("treats a superseded latest global revision as no active global policy (#9833)", async () => {
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
      args.join(" ") === "policy list -g gateway-a --global --limit 1"
        ? globalPolicyHistoryResult()
        : args.join(" ") === "policy get -g gateway-a --global --full --output json"
          ? globalPolicySupersededResult()
          : defaultCommandResult(args),
    );

    await expect(actionApply("default", minimalBlueprint())).resolves.toBeUndefined();

    const commands = mockExeca.mock.calls.map(([, args]) => args.join(" "));
    expect(commands).toContain("policy get -g gateway-a --global --full --output json");
    expect(commands.some((command) => command.startsWith("sandbox create "))).toBe(true);
  });

  it.each([
    ["empty", { exitCode: 0, stdout: "", stderr: "" }],
    ["malformed", { exitCode: 0, stdout: "{", stderr: "" }],
    ["a JSON array", { exitCode: 0, stdout: "[]", stderr: "" }],
    [
      "an unsupported status",
      {
        exitCode: 0,
        stdout: JSON.stringify({
          scope: "global",
          status: "effective",
          policy_source: "global",
          policy: {},
        }),
        stderr: "",
      },
    ],
    [
      "a missing policy document",
      {
        exitCode: 0,
        stdout: JSON.stringify({
          scope: "global",
          status: "loaded",
          policy_source: "global",
        }),
        stderr: "",
      },
    ],
  ])(
    "fails closed when global policy history exists but latest metadata is %s (#9833)",
    async (_label, result) => {
      mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
        args.join(" ") === "policy list -g gateway-a --global --limit 1"
          ? globalPolicyHistoryResult()
          : args.join(" ") === "policy get -g gateway-a --global --full --output json"
            ? result
            : defaultCommandResult(args),
      );

      await expect(actionApply("default", minimalBlueprint())).rejects.toThrow(
        /global policy authority metadata/,
      );
      expect(
        mockExeca.mock.calls.some(([, args]) => args[0] === "sandbox" && args[1] === "create"),
      ).toBe(false);
    },
  );

  it("fails closed when global policy history cannot be inspected (#9833)", async () => {
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
      args.join(" ") === "policy list -g gateway-a --global --limit 1"
        ? { exitCode: 1, stdout: "", stderr: "permission denied" }
        : defaultCommandResult(args),
    );

    await expect(actionApply("default", minimalBlueprint())).rejects.toThrow(
      /global policy authority inspection failed/,
    );
    expect(mockExeca).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the global policy history command cannot start (#9833)", async () => {
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
      args.join(" ") === "policy list -g gateway-a --global --limit 1"
        ? Promise.reject(new Error("spawn failed"))
        : defaultCommandResult(args),
    );

    await expect(actionApply("default", minimalBlueprint())).rejects.toThrow(
      /global policy authority inspection failed/,
    );
    expect(mockExeca).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["empty", successResult()],
    [
      "missing its policy document",
      {
        exitCode: 0,
        stdout: JSON.stringify({
          scope: "sandbox",
          sandbox: "test-sandbox",
          status: "effective",
          policy_source: "sandbox",
        }),
        stderr: "",
      },
    ],
  ])(
    "fails closed when sandbox policy authority metadata is %s (#9833)",
    async (_label, result) => {
      mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
        args.join(" ") === "policy get -g gateway-a --full --output json test-sandbox"
          ? result
          : defaultCommandResult(args),
      );

      await expect(actionApply("default", minimalBlueprint())).rejects.toThrow(
        /sandbox policy authority metadata/,
      );
      expect(
        mockExeca.mock.calls.some(([, args]) => args[0] === "provider" && args[1] === "create"),
      ).toBe(false);
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

  it("rejects missing external entries on a reused sandbox before provider mutation (#9833)", async () => {
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
      args.join(" ") ===
      "sandbox create -g gateway-a --from openclaw --name test-sandbox --forward 18789"
        ? { exitCode: 1, stdout: "", stderr: "already exists" }
        : args.join(" ") === "policy get -g gateway-a --full --output json test-sandbox"
          ? sandboxPolicyAuthorityResult("test-sandbox", "externally-managed")
          : defaultCommandResult(args),
    );

    await expect(actionApply("default", blueprint())).rejects.toThrow(
      /missing entries "nim_service"/,
    );
    const plan = [...store.entries()].find(([key]) => key.endsWith("/plan.json"))?.[1];
    expect(JSON.parse(plan?.content ?? "{}").policy_authority).toEqual({
      authority: "externally-managed",
      scope: "sandbox",
      sandbox_name: "test-sandbox",
    });
    expect(
      mockExeca.mock.calls.some(([, args]) => args[0] === "provider" && args[1] === "create"),
    ).toBe(false);
    expect(policySetCalls()).toEqual([]);
  });

  it.each([
    ["provider", 2, false],
    ["inference route", 3, true],
  ])(
    "rechecks sandbox authority immediately before %s mutation (#9833)",
    async (_edge, driftAtInspection, providerCreated) => {
      let sandboxInspections = 0;
      mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
        args.join(" ") === "policy get -g gateway-a --full --output json test-sandbox"
          ? sandboxPolicyAuthorityResult(
              "test-sandbox",
              (sandboxInspections += 1) < driftAtInspection
                ? "nemoclaw-managed"
                : "externally-managed",
            )
          : args.join(" ") === "policy get -g gateway-a --base test-sandbox"
            ? { exitCode: 0, stdout: policyOutput(BASE_POLICY), stderr: "" }
            : defaultCommandResult(args),
      );

      await expect(actionApply("default", blueprint())).rejects.toThrow(/authority changed/);
      const commands = mockExeca.mock.calls.map(([, args]) => args.join(" "));
      expect(sandboxInspections).toBe(driftAtInspection);
      expect(
        commands.includes(
          "provider create -g gateway-a --name my-provider --type openai --config OPENAI_BASE_URL=https://api.example.com/v1",
        ),
      ).toBe(providerCreated);
      expect(commands).not.toContain(
        "inference set -g gateway-a --provider my-provider --model gpt-4",
      );
      expect(commands).toContain("sandbox stop -g gateway-a test-sandbox");
      expect(commands).toContain("sandbox remove -g gateway-a test-sandbox");
      expect(commands.includes("provider delete -g gateway-a my-provider")).toBe(providerCreated);
      expect(policySetCalls()).toEqual([]);
    },
  );

  it("restores the recorded gateway route after ambient gateway selection changes at final refusal (#9833)", async () => {
    commandResponseQueue([
      [
        "sandbox create -g gateway-a --from openclaw --name test-sandbox --forward 18789",
        [{ exitCode: 1, stdout: "", stderr: "already exists" }],
      ],
      [
        "policy get -g gateway-a --full --output json test-sandbox",
        [
          sandboxPolicyAuthorityResult("test-sandbox"),
          sandboxPolicyAuthorityResult("test-sandbox"),
          sandboxPolicyAuthorityResult("test-sandbox"),
          sandboxPolicyAuthorityResult("test-sandbox", "externally-managed"),
        ],
      ],
      [
        "status",
        [
          () => {
            vi.stubEnv("OPENSHELL_GATEWAY", "gateway-b");
            return gatewayStatusResult("gateway-a");
          },
        ],
      ],
      [
        "inference get -g gateway-a",
        [
          inferenceRouteOutput("prior-provider", "prior-model", 45),
          inferenceRouteOutput("prior-provider", "prior-model", 45),
          inferenceRouteOutput("my-provider", "gpt-4", 180),
          inferenceRouteOutput("my-provider", "gpt-4", 180),
          inferenceRouteOutput("prior-provider", "prior-model", 45),
        ].map((stdout) => ({ exitCode: 0, stdout, stderr: "" })),
      ],
    ]);

    const error = await actionApply("default", minimalBlueprint()).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(BlueprintPolicyAuthorityRefusalError);
    expect((error as Error).message).toMatch(/authority changed/);
    const commands = mockExeca.mock.calls.map(([, args]) => args.join(" "));
    const replacement = "inference set -g gateway-a --provider my-provider --model gpt-4";
    const restoration =
      "inference set -g gateway-a --provider prior-provider --model prior-model --timeout 45";
    expect(commands).toContain(replacement);
    expect(commands).toContain(
      "provider create -g gateway-a --name my-provider --type openai --config OPENAI_BASE_URL=https://api.example.com/v1",
    );
    expect(commands).not.toContain(
      "provider create --name my-provider --type openai --config OPENAI_BASE_URL=https://api.example.com/v1",
    );
    expect(commands).toContain(restoration);
    expect(commands).toContain("provider delete -g gateway-a my-provider");
    expect(commands.indexOf(restoration)).toBeLessThan(
      commands.indexOf("provider delete -g gateway-a my-provider"),
    );
    expect(
      commands
        .filter((command) => /^(?:policy|sandbox|provider|inference)\b/u.test(command))
        .every((command) => command.includes("-g gateway-a")),
    ).toBe(true);
    expect(commands.every((command) => !command.includes("gateway-b"))).toBe(true);
    expect(commands).not.toContain("sandbox remove -g gateway-a test-sandbox");
    const plan = [...store.entries()].find(([key]) => key.endsWith("/plan.json"))?.[1];
    expect(JSON.parse(plan?.content ?? "{}")).toMatchObject({
      sandbox_created_by_apply: false,
      inference_provider_created_by_apply: false,
      provider_gateway: "gateway-a",
    });
    expect(JSON.parse(plan?.content ?? "{}")).not.toHaveProperty("inference_route_recovery");
  });

  it("captures the gateway before policy and fresh sandbox operations (#9833)", async () => {
    commandResponseQueue([
      [
        "status",
        [
          () => {
            vi.stubEnv("OPENSHELL_GATEWAY", "gateway-b");
            return gatewayStatusResult("gateway-a");
          },
        ],
      ],
    ]);

    await actionApply("default", minimalBlueprint());
    const commands = mockExeca.mock.calls.map(([, args]) => args.join(" "));
    expect(commands.slice(0, 2)).toEqual(["status", "policy list -g gateway-a --global --limit 1"]);
    expect(commands).toContain(
      "sandbox create -g gateway-a --from openclaw --name test-sandbox --forward 18789",
    );
    expect(commands.every((command) => !command.includes("gateway-b"))).toBe(true);
  });

  it("flushes each temporary plan before rename and its parent after rename (#9833)", async () => {
    await actionApply("default", minimalBlueprint());
    const planPath = [...store.keys()].find((path) => path.endsWith("/plan.json"))!;
    const temporaryPath = `${planPath}.${String(process.pid)}.tmp`;
    const parentPath = planPath.slice(0, planPath.lastIndexOf("/"));
    expect(mockOpenSync).toHaveBeenNthCalledWith(1, temporaryPath, "r");
    expect(mockOpenSync).toHaveBeenNthCalledWith(2, parentPath, "r");
    expect(mockWriteFileSync.mock.invocationCallOrder[0]).toBeLessThan(
      mockFsyncSync.mock.invocationCallOrder[0]!,
    );
    expect(mockFsyncSync.mock.invocationCallOrder[0]).toBeLessThan(
      mockRenameSync.mock.invocationCallOrder[0]!,
    );
    expect(mockRenameSync.mock.invocationCallOrder[0]).toBeLessThan(
      mockFsyncSync.mock.invocationCallOrder[1]!,
    );
    expect(store.has(temporaryPath)).toBe(false);
  });

  it("removes the temporary plan when its pre-rename flush fails (#9833)", async () => {
    mockFsyncSync.mockImplementationOnce(() => {
      throw new Error("temporary plan sync denied");
    });
    await expect(actionApply("default", minimalBlueprint())).rejects.toThrow(
      /temporary plan sync denied/u,
    );
    expect(mockRenameSync).not.toHaveBeenCalled();
    expect([...store.keys()].some((path) => path.endsWith(".tmp"))).toBe(false);
    expect(mockExeca.mock.calls.some(([, args]) => args[0] === "sandbox")).toBe(false);
  });

  it("clears and verifies a fresh unconfigured route before rollback deletes its provider (#9833)", async () => {
    inferenceRouteResult = createInferenceRouteResult("gateway-a", null);
    commandResponseQueue([]);

    await actionApply("default", minimalBlueprint());
    const planEntry = [...store.entries()].find(([path]) => path.endsWith("/plan.json"))?.[1];
    const plan = JSON.parse(planEntry?.content ?? "{}");
    expect(plan).toMatchObject({
      sandbox_created_by_apply: true,
      inference_provider_created_by_apply: true,
      provider_gateway: "gateway-a",
      inference_route_recovery: {
        gateway: "gateway-a",
        previous_route: { state: "unconfigured" },
        replacement_route: { state: "configured", provider: "my-provider", model: "gpt-4" },
      },
    });

    mockExeca.mockClear();
    await actionRollback(plan.run_id);
    const commands = mockExeca.mock.calls.map(([, args]) => args.join(" "));
    const routeDelete = "inference delete -g gateway-a";
    const providerDelete = "provider delete -g gateway-a my-provider";
    expect(commands).toContain(routeDelete);
    expect(commands).toContain(providerDelete);
    expect(commands.filter((command) => command === "inference get -g gateway-a")).toHaveLength(2);
    expect(commands.indexOf(routeDelete)).toBeLessThan(commands.indexOf(providerDelete));
  });

  it("restores a successful reused-sandbox route before deleting its created provider (#9833)", async () => {
    commandResponseQueue([
      [
        "sandbox create -g gateway-a --from openclaw --name test-sandbox --forward 18789",
        [{ exitCode: 1, stdout: "", stderr: "already exists" }],
      ],
    ]);
    await actionApply("default", minimalBlueprint());
    const planEntry = [...store.entries()].find(([path]) => path.endsWith("/plan.json"))?.[1];
    const plan = JSON.parse(planEntry?.content ?? "{}");
    expect(plan).toMatchObject({
      sandbox_created_by_apply: false,
      inference_provider_created_by_apply: true,
      inference_route_recovery: { gateway: "gateway-a" },
    });

    mockExeca.mockClear();
    await actionRollback(plan.run_id);
    const commands = mockExeca.mock.calls.map(([, args]) => args.join(" "));
    const restore =
      "inference set -g gateway-a --provider prior-provider --model prior-model --timeout 45";
    const providerDelete = "provider delete -g gateway-a my-provider";
    expect(commands).toContain(restore);
    expect(commands.indexOf(restore)).toBeLessThan(commands.indexOf(providerDelete));
    expect(commands).not.toContain("sandbox remove -g gateway-a test-sandbox");
  });

  it.each([
    [
      "write",
      () =>
        mockWriteFileSync.mockImplementationOnce(() => {
          throw new Error("final plan write denied");
        }),
      /final plan write denied/u,
    ],
    [
      "directory flush",
      () =>
        mockFsyncSync
          .mockImplementationOnce(() => undefined)
          .mockImplementationOnce(() => {
            throw new Error("final plan directory sync denied");
          }),
      /final plan directory sync denied/u,
    ],
  ])("restores the exact route before deleting a provider when the final plan %s fails (#9833)", async (_case, injectFailure, expectedError) => {
    commandResponseQueue([
      [
        "policy get -g gateway-a --full --output json test-sandbox",
        [
          sandboxPolicyAuthorityResult("test-sandbox"),
          sandboxPolicyAuthorityResult("test-sandbox"),
          sandboxPolicyAuthorityResult("test-sandbox"),
          () => {
            injectFailure();
            return sandboxPolicyAuthorityResult("test-sandbox");
          },
        ],
      ],
      [
        "inference get -g gateway-a",
        [
          inferenceRouteOutput("prior-provider", "prior-model", 45),
          inferenceRouteOutput("prior-provider", "prior-model", 45),
          inferenceRouteOutput("my-provider", "gpt-4", 180),
          inferenceRouteOutput("my-provider", "gpt-4", 180),
          inferenceRouteOutput("prior-provider", "prior-model", 45),
        ].map((stdout) => ({ exitCode: 0, stdout, stderr: "" })),
      ],
    ]);

    await expect(actionApply("default", minimalBlueprint())).rejects.toThrow(expectedError);

    const commands = mockExeca.mock.calls.map(([, args]) => args.join(" "));
    const restoration =
      "inference set -g gateway-a --provider prior-provider --model prior-model --timeout 45";
    expect(commands).toContain(
      "sandbox create -g gateway-a --from openclaw --name test-sandbox --forward 18789",
    );
    expect(commands).toContain(restoration);
    expect(commands).toContain("sandbox remove -g gateway-a test-sandbox");
    expect(commands.indexOf(restoration)).toBeLessThan(
      commands.indexOf("provider delete -g gateway-a my-provider"),
    );
    const plan = [...store.entries()].find(([key]) => key.endsWith("/plan.json"))?.[1];
    expect(JSON.parse(plan?.content ?? "{}")).toMatchObject({
      sandbox_created_by_apply: false,
      inference_provider_created_by_apply: false,
      provider_gateway: "gateway-a",
    });
    expect(JSON.parse(plan?.content ?? "{}")).not.toHaveProperty("inference_route_recovery");
    expect([...store.keys()].some((path) => path.endsWith(".tmp"))).toBe(false);
  });

  it("preserves durable recovery when final and recovery plan renames fail (#9833)", async () => {
    commandResponseQueue([
      [
        "sandbox create -g gateway-a --from openclaw --name test-sandbox --forward 18789",
        [{ exitCode: 1, stdout: "", stderr: "already exists" }],
      ],
      [
        "policy get -g gateway-a --full --output json test-sandbox",
        [
          sandboxPolicyAuthorityResult("test-sandbox"),
          sandboxPolicyAuthorityResult("test-sandbox"),
          sandboxPolicyAuthorityResult("test-sandbox"),
          () => {
            mockRenameSync
              .mockImplementationOnce(() => {
                throw new Error("final plan rename denied");
              })
              .mockImplementationOnce(() => {
                throw new Error("recovery plan rename denied");
              });
            return sandboxPolicyAuthorityResult("test-sandbox");
          },
        ],
      ],
      [
        "inference get -g gateway-a",
        [
          inferenceRouteOutput("prior-provider", "prior-model", 45),
          inferenceRouteOutput("prior-provider", "prior-model", 45),
          inferenceRouteOutput("my-provider", "gpt-4", 180),
          inferenceRouteOutput("my-provider", "gpt-4", 180),
        ].map((stdout) => ({ exitCode: 0, stdout, stderr: "" })),
      ],
      [
        "inference set -g gateway-a --provider prior-provider --model prior-model --timeout 45",
        [{ exitCode: 1, stdout: "", stderr: "API_TOKEN=route-secret restore denied" }],
      ],
    ]);

    const error = await actionApply("default", minimalBlueprint()).catch(
      (caught: unknown) => caught,
    );

    expect((error as Error).message).toMatch(
      /final plan rename denied[\s\S]*cleanup failed[\s\S]*recovery plan rename denied[\s\S]*route recovery remains required/u,
    );
    expect((error as Error).message).toContain("API_TOKEN=<REDACTED>");
    expect((error as Error).message).not.toContain("route-secret");
    const commands = mockExeca.mock.calls.map(([, args]) => args.join(" "));
    expect(commands).not.toContain("provider delete -g gateway-a my-provider");
    const plan = [...store.entries()].find(([key]) => key.endsWith("/plan.json"))?.[1];
    expect(JSON.parse(plan?.content ?? "{}")).toMatchObject({
      sandbox_created_by_apply: false,
      inference_provider_created_by_apply: true,
      provider_gateway: "gateway-a",
      inference_route_recovery: {
        gateway: "gateway-a",
        previous_route: {
          state: "configured",
          provider: "prior-provider",
          model: "prior-model",
          timeout_seconds: 45,
        },
      },
    });
  });

  it("preserves a fresh provider and unconfigured-route receipt when route deletion fails (#9833)", async () => {
    inferenceRouteResult = createInferenceRouteResult("gateway-a", null);
    commandResponseQueue([
      [
        "policy get -g gateway-a --full --output json test-sandbox",
        [
          sandboxPolicyAuthorityResult("test-sandbox"),
          sandboxPolicyAuthorityResult("test-sandbox"),
          sandboxPolicyAuthorityResult("test-sandbox"),
          sandboxPolicyAuthorityResult("test-sandbox", "externally-managed"),
        ],
      ],
      [
        "inference delete -g gateway-a",
        [{ exitCode: 1, stdout: "", stderr: "API_TOKEN=route-secret delete denied" }],
      ],
    ]);

    const error = await actionApply("default", minimalBlueprint()).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(BlueprintPolicyAuthorityRefusalError);
    expect((error as Error).message).toMatch(
      /authority changed[\s\S]*cleanup failed[\s\S]*route recovery remains required/,
    );
    expect((error as Error).message).toContain("API_TOKEN=<REDACTED>");
    expect((error as Error).message).not.toContain("route-secret");
    const commands = mockExeca.mock.calls.map(([, args]) => args.join(" "));
    expect(commands).not.toContain("provider delete -g gateway-a my-provider");
    expect(commands).toContain("sandbox remove -g gateway-a test-sandbox");
    const plan = [...store.entries()].find(([key]) => key.endsWith("/plan.json"))?.[1];
    expect(JSON.parse(plan?.content ?? "{}")).toMatchObject({
      sandbox_created_by_apply: false,
      inference_provider_created_by_apply: true,
      provider_gateway: "gateway-a",
      inference_route_recovery: {
        gateway: "gateway-a",
        previous_route: { state: "unconfigured" },
        replacement_route: {
          state: "configured",
          provider: "my-provider",
          model: "gpt-4",
          timeout_seconds: 180,
        },
      },
    });
  });

  it("retains recovery evidence when the replacement route has timeout-only drift (#9833)", async () => {
    commandResponseQueue([
      [
        "sandbox create -g gateway-a --from openclaw --name test-sandbox --forward 18789",
        [{ exitCode: 1, stdout: "", stderr: "already exists" }],
      ],
      [
        "policy get -g gateway-a --full --output json test-sandbox",
        [
          sandboxPolicyAuthorityResult("test-sandbox"),
          sandboxPolicyAuthorityResult("test-sandbox"),
          sandboxPolicyAuthorityResult("test-sandbox"),
          sandboxPolicyAuthorityResult("test-sandbox", "externally-managed"),
        ],
      ],
      [
        "inference get -g gateway-a",
        [
          inferenceRouteOutput("prior-provider", "prior-model", 45),
          inferenceRouteOutput("prior-provider", "prior-model", 45),
          inferenceRouteOutput("my-provider", "gpt-4", 180),
          inferenceRouteOutput("my-provider", "gpt-4", 181),
        ].map((stdout) => ({ exitCode: 0, stdout, stderr: "" })),
      ],
    ]);

    const error = await actionApply("default", minimalBlueprint()).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(BlueprintPolicyAuthorityRefusalError);
    expect((error as Error).message).toMatch(
      /authority changed[\s\S]*cleanup failed[\s\S]*active route no longer matches/u,
    );
    const commands = mockExeca.mock.calls.map(([, args]) => args.join(" "));
    expect(commands).not.toContain(
      "inference set -g gateway-a --provider prior-provider --model prior-model --timeout 45",
    );
    expect(commands).not.toContain("provider delete -g gateway-a my-provider");
    const plan = [...store.entries()].find(([key]) => key.endsWith("/plan.json"))?.[1];
    expect(JSON.parse(plan?.content ?? "{}")).toMatchObject({
      inference_provider_created_by_apply: true,
      inference_route_recovery: {
        gateway: "gateway-a",
        replacement_route: {
          state: "configured",
          provider: "my-provider",
          model: "gpt-4",
          timeout_seconds: 180,
        },
      },
    });
  });

  it("refuses a configured reused route without a timeout before provider mutation (#9833)", async () => {
    commandResponseQueue([
      [
        "sandbox create -g gateway-a --from openclaw --name test-sandbox --forward 18789",
        [{ exitCode: 1, stdout: "", stderr: "already exists" }],
      ],
      [
        "inference get -g gateway-a",
        [
          {
            exitCode: 0,
            stdout: "Gateway inference:\n\n  Provider: prior-provider\n  Model: prior-model\n",
            stderr: "",
          },
        ],
      ],
    ]);

    await expect(actionApply("default", minimalBlueprint())).rejects.toThrow(
      /prior timeout is not a finite integer/u,
    );
    const commands = mockExeca.mock.calls.map(([, args]) => args.join(" "));
    expect(commands).not.toContain(
      "provider create -g gateway-a --name my-provider --type openai --config OPENAI_BASE_URL=https://api.example.com/v1",
    );
    expect(commands).not.toContain(
      "inference set -g gateway-a --provider my-provider --model gpt-4",
    );
    expect(commands).not.toContain("provider delete -g gateway-a my-provider");
  });

  it.each([
    ["fails", { exitCode: 1, stdout: "", stderr: "status denied" }, /Failed to inspect/u],
    ["is ambiguous", successResult(), /Failed to prove/u],
  ])(
    "fails closed before reused provider mutation when gateway status %s (#9833)",
    async (_case, status, error) => {
      commandResponseQueue([
        [
          "sandbox create -g gateway-a --from openclaw --name test-sandbox --forward 18789",
          [{ exitCode: 1, stdout: "", stderr: "already exists" }],
        ],
        ["status", [status]],
      ]);

      await expect(actionApply("default", minimalBlueprint())).rejects.toThrow(error);
      expect(mockExeca.mock.calls.map(([, args]) => args.join(" "))).not.toContain(
        "provider create -g gateway-a --name my-provider --type openai --config OPENAI_BASE_URL=https://api.example.com/v1",
      );
    },
  );

  it("fails closed when a reused route cannot be parsed before provider mutation (#9833)", async () => {
    commandResponseQueue([
      [
        "sandbox create -g gateway-a --from openclaw --name test-sandbox --forward 18789",
        [{ exitCode: 1, stdout: "", stderr: "already exists" }],
      ],
      ["inference get -g gateway-a", [{ exitCode: 0, stdout: "unknown route", stderr: "" }]],
    ]);

    await expect(actionApply("default", minimalBlueprint())).rejects.toThrow(
      /Failed to parse the active inference route/u,
    );
    expect(mockExeca.mock.calls.map(([, args]) => args.join(" "))).not.toContain(
      "provider create -g gateway-a --name my-provider --type openai --config OPENAI_BASE_URL=https://api.example.com/v1",
    );
  });

  it("rejects an unbound route recovery receipt before rollback mutation (#9833)", async () => {
    const stateDir = `${FAKE_HOME}/.nemoclaw/state/runs/unbound-route-recovery`;
    store.set(stateDir, { type: "dir" });
    store.set(`${stateDir}/plan.json`, {
      type: "file",
      content: JSON.stringify({
        sandbox_name: "test-sandbox",
        inference_provider_created_by_apply: true,
        inference: { provider_name: "my-provider" },
        inference_route_recovery: {
          previous_route: {
            state: "configured",
            provider: "prior-provider",
            model: "prior-model",
            timeout_seconds: 45,
          },
          replacement_route: {
            state: "configured",
            provider: "my-provider",
            model: "gpt-4",
            timeout_seconds: 180,
          },
        },
      }),
    });

    await expect(actionRollback("unbound-route-recovery")).rejects.toThrow(
      /inference route recovery receipt is invalid/u,
    );
    expect(mockExeca).not.toHaveBeenCalled();
    expect(store.get(`${stateDir}/rolled_back`)).toBeUndefined();
  });

  it.each([
    [
      "configured without a timeout",
      { state: "configured", provider: "prior-provider", model: "prior-model" },
    ],
  ])(
    "rejects a gateway-bound %s route receipt before rollback mutation (#9833)",
    async (_case, previousRoute) => {
      const stateDir = `${FAKE_HOME}/.nemoclaw/state/runs/invalid-prior-route-recovery`;
      store.set(stateDir, { type: "dir" });
      store.set(`${stateDir}/plan.json`, {
        type: "file",
        content: JSON.stringify({
          sandbox_name: "test-sandbox",
          inference_provider_created_by_apply: true,
          provider_gateway: "gateway-a",
          inference: { provider_name: "my-provider" },
          inference_route_recovery: {
            gateway: "gateway-a",
            previous_route: previousRoute,
            replacement_route: {
              state: "configured",
              provider: "my-provider",
              model: "gpt-4",
              timeout_seconds: 180,
            },
          },
        }),
      });

      await expect(actionRollback("invalid-prior-route-recovery")).rejects.toThrow(
        /inference route recovery receipt is invalid/u,
      );
      expect(mockExeca).not.toHaveBeenCalled();
      expect(store.get(`${stateDir}/rolled_back`)).toBeUndefined();
    },
  );

  it.each([
    ["sandbox ownership", { sandbox_created_by_apply: true }],
    [
      "provider ownership",
      {
        inference_provider_created_by_apply: true,
        inference: { provider_name: "my-provider" },
      },
    ],
  ])("rejects unbound legacy %s before destructive rollback (#9833)", async (_case, ownership) => {
    const stateDir = `${FAKE_HOME}/.nemoclaw/state/runs/unbound-ownership`;
    store.set(stateDir, { type: "dir" });
    store.set(`${stateDir}/plan.json`, {
      type: "file",
      content: JSON.stringify({
        sandbox_name: "existing-sandbox",
        ...ownership,
      }),
    });

    await expect(actionRollback("unbound-ownership")).rejects.toThrow(
      /provider gateway receipt is required for destructive rollback/u,
    );
    expect(mockExeca).not.toHaveBeenCalled();
    expect(store.get(`${stateDir}/rolled_back`)).toBeUndefined();
  });

  it.each([
    ["invalid", { provider_gateway: "../gateway" }, /provider gateway receipt is invalid/u],
    [
      "conflicting",
      {
        provider_gateway: "gateway-b",
        inference_route_recovery: {
          gateway: "gateway-a",
          previous_route: {
            state: "configured",
            provider: "prior-provider",
            model: "prior-model",
            timeout_seconds: 45,
          },
          replacement_route: {
            state: "configured",
            provider: "my-provider",
            model: "gpt-4",
            timeout_seconds: 180,
          },
        },
      },
      /provider gateway receipt conflicts with route recovery receipt/u,
    ],
  ])(
    "rejects %s provider gateway recovery metadata before mutation (#9833)",
    async (_case, metadata, error) => {
      const stateDir = `${FAKE_HOME}/.nemoclaw/state/runs/provider-gateway-metadata`;
      store.set(stateDir, { type: "dir" });
      store.set(`${stateDir}/plan.json`, {
        type: "file",
        content: JSON.stringify({ sandbox_name: "existing-sandbox", ...metadata }),
      });

      await expect(actionRollback("provider-gateway-metadata")).rejects.toThrow(error);
      expect(mockExeca).not.toHaveBeenCalled();
      expect(store.get(`${stateDir}/rolled_back`)).toBeUndefined();
    },
  );

  it("keeps gateway-bound provider cleanup retryable when deletion fails (#9833)", async () => {
    const stateDir = `${FAKE_HOME}/.nemoclaw/state/runs/failed-provider-removal`;
    store.set(stateDir, { type: "dir" });
    store.set(`${stateDir}/plan.json`, {
      type: "file",
      content: JSON.stringify({
        sandbox_name: "existing-sandbox",
        inference_provider_created_by_apply: true,
        provider_gateway: "gateway-a",
        inference: { provider_name: "my-provider" },
      }),
    });
    commandResponseQueue([
      ["provider delete -g gateway-a my-provider", [{ exitCode: 1, stdout: "", stderr: "denied" }]],
    ]);

    await expect(actionRollback("failed-provider-removal")).rejects.toThrow(
      /Failed to remove owned inference provider 'my-provider': denied/u,
    );
    expect(store.get(`${stateDir}/rolled_back`)).toBeUndefined();
  });

  it("rejects an invalid owned inference provider receipt before mutation (#9833)", async () => {
    const stateDir = `${FAKE_HOME}/.nemoclaw/state/runs/invalid-provider`;
    store.set(stateDir, { type: "dir" });
    store.set(`${stateDir}/plan.json`, {
      type: "file",
      content: JSON.stringify({
        sandbox_name: "existing-sandbox",
        inference_provider_created_by_apply: true,
        inference: { provider_name: "../../other" },
      }),
    });

    await expect(actionRollback("invalid-provider")).rejects.toThrow(
      /Invalid rollback inference provider name/u,
    );
    expect(mockExeca).not.toHaveBeenCalled();
    expect(store.get(`${stateDir}/rolled_back`)).toBeUndefined();
  });

  it("restores a gateway-bound route receipt before retrying provider cleanup (#9833)", async () => {
    const stateDir = `${FAKE_HOME}/.nemoclaw/state/runs/route-recovery-retry`;
    store.set(stateDir, { type: "dir" });
    store.set(`${stateDir}/plan.json`, {
      type: "file",
      content: JSON.stringify({
        sandbox_name: "existing-sandbox",
        inference_provider_created_by_apply: true,
        provider_gateway: "gateway-a",
        inference: { provider_name: "my-provider", model: "gpt-4" },
        inference_route_recovery: {
          gateway: "gateway-a",
          previous_route: {
            state: "configured",
            provider: "prior-provider",
            model: "prior-model",
            timeout_seconds: 45,
          },
          replacement_route: {
            state: "configured",
            provider: "my-provider",
            model: "gpt-4",
            timeout_seconds: 180,
          },
        },
      }),
    });
    commandResponseQueue([
      [
        "inference get -g gateway-a",
        [
          inferenceRouteOutput("my-provider", "gpt-4", 180),
          inferenceRouteOutput("prior-provider", "prior-model", 45),
        ].map((stdout) => ({ exitCode: 0, stdout, stderr: "" })),
      ],
    ]);

    await actionRollback("route-recovery-retry");

    const commands = mockExeca.mock.calls.map(([, args]) => args.join(" "));
    const restoration =
      "inference set -g gateway-a --provider prior-provider --model prior-model --timeout 45";
    expect(commands).toContain(restoration);
    expect(commands).toContain("provider delete -g gateway-a my-provider");
    expect(commands.indexOf(restoration)).toBeLessThan(
      commands.indexOf("provider delete -g gateway-a my-provider"),
    );
    expect(commands).not.toContain("sandbox remove existing-sandbox");
    expect(store.get(`${stateDir}/rolled_back`)?.content).toBeDefined();
  });

  it("keeps recovery retryable when exact route restoration cannot be verified (#9833)", async () => {
    const stateDir = `${FAKE_HOME}/.nemoclaw/state/runs/unverified-route-recovery`;
    store.set(stateDir, { type: "dir" });
    store.set(`${stateDir}/plan.json`, {
      type: "file",
      content: JSON.stringify({
        sandbox_name: "existing-sandbox",
        provider_gateway: "gateway-a",
        inference_route_recovery: {
          gateway: "gateway-a",
          previous_route: {
            state: "configured",
            provider: "prior-provider",
            model: "prior-model",
            timeout_seconds: 45,
          },
          replacement_route: {
            state: "configured",
            provider: "my-provider",
            model: "gpt-4",
            timeout_seconds: 180,
          },
        },
      }),
    });
    commandResponseQueue([
      [
        "inference get -g gateway-a",
        Array.from({ length: 2 }, () => ({
          exitCode: 0,
          stdout: inferenceRouteOutput("my-provider", "gpt-4", 180),
          stderr: "",
        })),
      ],
    ]);

    await expect(actionRollback("unverified-route-recovery")).rejects.toThrow(
      /Failed to verify the restored inference route/u,
    );
    expect(store.get(`${stateDir}/rolled_back`)).toBeUndefined();
  });

  it("does not report completion when authority changes during the final policy command (#9833)", async () => {
    let sandboxInspections = 0;
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
      args.join(" ") === "policy get -g gateway-a --full --output json test-sandbox"
        ? sandboxPolicyAuthorityResult(
            "test-sandbox",
            (sandboxInspections += 1) < 6 ? "nemoclaw-managed" : "externally-managed",
          )
        : args.join(" ") === "policy get -g gateway-a --base test-sandbox"
          ? { exitCode: 0, stdout: policyOutput(BASE_POLICY), stderr: "" }
          : defaultCommandResult(args),
    );

    const error = await actionApply("default", blueprint()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BlueprintPolicyAuthorityRefusalError);
    expect((error as Error).message).toMatch(/authority changed/);
    expect(policySetCalls()).toHaveLength(1);
    expect(sandboxInspections).toBe(6);
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

  it.each([
    [
      "sandbox removal fails",
      "sandbox remove -g gateway-a test-sandbox",
      "sandbox remove denied",
      false,
      false,
      true,
    ],
    [
      "sandbox removal cannot start",
      "sandbox remove -g gateway-a test-sandbox",
      "sandbox remove spawn failed",
      true,
      false,
      true,
    ],
    [
      "inference provider deletion fails",
      "provider delete -g gateway-a my-provider",
      "provider delete denied",
      false,
      true,
      false,
    ],
    [
      "inference provider deletion cannot start",
      "provider delete -g gateway-a my-provider",
      "provider delete spawn failed",
      true,
      true,
      false,
    ],
  ])(
    "preserves the authority refusal when %s during compensation (#9833)",
    async (
      _failure,
      failedCommand,
      cleanupError,
      commandThrows,
      providerDeleteAttempted,
      sandboxOwned,
    ) => {
      let sandboxInspections = 0;
      mockExeca.mockImplementation(async (_cmd: string, args: string[]) => {
        const command = args.join(" ");
        return command === failedCommand
          ? commandThrows
            ? Promise.reject(new Error(cleanupError))
            : { exitCode: 1, stdout: "", stderr: cleanupError }
          : command === "policy get -g gateway-a --full --output json test-sandbox"
            ? sandboxPolicyAuthorityResult(
                "test-sandbox",
                (sandboxInspections += 1) < 6 ? "nemoclaw-managed" : "externally-managed",
              )
            : args.join(" ") === "policy get -g gateway-a --base test-sandbox"
              ? { exitCode: 0, stdout: policyOutput(BASE_POLICY), stderr: "" }
              : defaultCommandResult(args);
      });

      const error = await actionApply("default", blueprint()).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(BlueprintPolicyAuthorityRefusalError);
      expect((error as Error).message).toMatch(
        new RegExp(`authority changed[\\s\\S]*cleanup failed[\\s\\S]*${cleanupError}`, "u"),
      );

      const commands = mockExeca.mock.calls.map(([, args]) => args.join(" "));
      expect(commands).toContain("sandbox stop -g gateway-a test-sandbox");
      expect(commands).toContain("sandbox remove -g gateway-a test-sandbox");
      expect(commands.includes("provider delete -g gateway-a my-provider")).toBe(
        providerDeleteAttempted,
      );
      const plan = [...store.entries()].find(([key]) => key.endsWith("/plan.json"))?.[1];
      expect(JSON.parse(plan?.content ?? "{}")).toMatchObject({
        sandbox_created_by_apply: sandboxOwned,
        inference_provider_created_by_apply: true,
      });
    },
  );
});
