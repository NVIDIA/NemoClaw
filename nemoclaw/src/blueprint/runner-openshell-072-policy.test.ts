// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
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
  throwOnCall,
} from "./runner-mock-fixtures.js";
import {
  createMutableSandboxPolicyResult,
  gatewayInfoResult,
  gatewayStatusResult,
  globalPolicyAuthorityResult,
  minimalBlueprint,
  sandboxIdentityResult,
  sandboxPolicyAuthorityResult,
  sequentialCommandResult,
  TEST_SANDBOX_POLICY,
  TEST_SANDBOX_POLICY_PATH,
} from "./runner-test-fixtures.js";

const { store } = createRunnerFsStore();
const mockExeca = vi.fn();
const stdoutCapture = createStdoutCapture();

vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
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
    closeSync: memory.closeSync,
    fsyncSync: memory.fsyncSync,
    mkdirSync: memory.mkdirSync,
    openSync: memory.openSync,
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
const { fsyncSync } = await import("node:fs");
const mockedFsyncSync = vi.mocked(fsyncSync);

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

const readMergedPolicy = (): Record<string, unknown> => {
  const merged = [...store.entries()].find(([path]) => path.endsWith("/merged-policy.yaml"));
  return YAML.parse(merged?.[1].content ?? TEST_SANDBOX_POLICY);
};
let defaultCommandResult = createMutableSandboxPolicyResult(readMergedPolicy);

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
    defaultCommandResult = createMutableSandboxPolicyResult(readMergedPolicy);
    store.set(TEST_SANDBOX_POLICY_PATH, { type: "file", content: TEST_SANDBOX_POLICY });
    vi.stubEnv("OPENSHELL_SANDBOX_POLICY", TEST_SANDBOX_POLICY_PATH);
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
    vi.unstubAllEnvs();
  });

  it("preserves MCP, JSON-RPC, and unknown mapping sections without provider entries", async () => {
    await actionApply("default", blueprint());

    expect(mockExeca).toHaveBeenCalledWith(
      "openshell",
      ["policy", "get", "-g", "test-gateway", "--base", "test-sandbox"],
      expect.objectContaining({ maxBuffer: 1024 * 1024, reject: false, timeout: 30_000 }),
    );
    expect(mockExeca).toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "get", "-g", "test-gateway", "test-sandbox"],
      expect.objectContaining({ maxBuffer: 1024 * 1024, reject: false, timeout: 30_000 }),
    );
    expect(mockExeca).toHaveBeenCalledWith(
      "openshell",
      ["gateway", "info", "-g", "test-gateway"],
      expect.objectContaining({ maxBuffer: 1024 * 1024, reject: false, timeout: 30_000 }),
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
      policy_authority: {
        policy_creation_receipt: {
          policyHash: "sha256:updated-policy",
          policyVersion: 2,
        },
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
    expect((error as Error).message).toBe("OpenShell policy receipt inspection failed.");
    expect((error as Error).message).not.toContain("MY_API_KEY");
    expect((error as Error).message).not.toContain("super-secret");
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

  it("keeps a verified global policy read-only before blueprint effects (#9833)", async () => {
    const bp = blueprint();
    const additions = bp.components!.policy!.additions!;
    vi.stubEnv("OPENSHELL_SANDBOX_POLICY", "/tmp/caller-policy.yaml");
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
      args.join(" ") === "status"
        ? gatewayStatusResult("recorded-gateway")
        : args.join(" ") === "gateway info -g recorded-gateway"
          ? gatewayInfoResult()
          : args.join(" ") === "policy list -g recorded-gateway --global --limit 1"
            ? { exitCode: 0, stdout: "VERSION STATUS\n1 loaded\n", stderr: "" }
            : args.join(" ") === "policy get -g recorded-gateway --global --full --output json"
              ? globalPolicyAuthorityResult(additions)
              : args.join(" ") === "sandbox get -g recorded-gateway test-sandbox"
                ? sandboxIdentityResult("test-sandbox")
                : args.join(" ") ===
                    "policy get -g recorded-gateway --full --output json test-sandbox"
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
        : args.join(" ") === "gateway info -g test-gateway"
          ? gatewayInfoResult()
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
        : args.join(" ") === "gateway info -g test-gateway"
          ? gatewayInfoResult()
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

  it("fails closed when global metadata does not name its policy source (#9833)", async () => {
    const globalResult = globalPolicyAuthorityResult();
    const metadata = JSON.parse(globalResult.stdout) as Record<string, unknown>;
    delete metadata.policy_source;
    const results = new Map([
      ["status", gatewayStatusResult()],
      ["gateway info -g test-gateway", gatewayInfoResult()],
      [
        "policy list -g test-gateway --global --limit 1",
        { exitCode: 0, stdout: "VERSION STATUS\n1 loaded\n", stderr: "" },
      ],
      [
        "policy get -g test-gateway --global --full --output json",
        { ...globalResult, stdout: JSON.stringify(metadata) },
      ],
    ]);
    mockExeca.mockImplementation(
      async (_cmd: string, args: string[]) =>
        results.get(args.join(" ")) ?? { exitCode: 0, stdout: "", stderr: "" },
    );

    await expect(actionApply("default", minimalBlueprint())).rejects.toThrow(
      /invalid global policy authority metadata/u,
    );
    expect(
      mockExeca.mock.calls.some(
        (call) => Array.isArray(call[1]) && call[1][0] === "sandbox" && call[1][1] === "create",
      ),
    ).toBe(false);
  });

  it.each([
    [
      "a failed status read",
      (args: string[]) =>
        args.join(" ") === "status"
          ? { exitCode: 1, stdout: "", stderr: "gateway unavailable" }
          : defaultCommandResult(args),
      /Failed to inspect the active OpenShell gateway/u,
    ],
    [
      "a disconnected status",
      (args: string[]) =>
        args.join(" ") === "status"
          ? { exitCode: 0, stdout: "Status: Disconnected\nGateway: test-gateway\n", stderr: "" }
          : defaultCommandResult(args),
      /Failed to prove the active OpenShell gateway identity/u,
    ],
    [
      "a missing gateway endpoint",
      (args: string[]) =>
        args.join(" ") === "gateway info -g test-gateway"
          ? { exitCode: 0, stdout: "Gateway ready\n", stderr: "" }
          : defaultCommandResult(args),
      /did not report one gateway endpoint/u,
    ],
    [
      "an invalid gateway endpoint",
      (args: string[]) =>
        args.join(" ") === "gateway info -g test-gateway"
          ? { exitCode: 0, stdout: "Gateway endpoint: not-a-url\n", stderr: "" }
          : defaultCommandResult(args),
      /reported an invalid gateway endpoint/u,
    ],
    [
      "an unsupported gateway endpoint protocol",
      (args: string[]) =>
        args.join(" ") === "gateway info -g test-gateway"
          ? { exitCode: 0, stdout: "Gateway endpoint: ftp:\/\/127.0.0.1:8080\n", stderr: "" }
          : defaultCommandResult(args),
      /unsupported gateway endpoint protocol/u,
    ],
    [
      "an invalid gateway endpoint port",
      (args: string[]) =>
        args.join(" ") === "gateway info -g test-gateway"
          ? { exitCode: 0, stdout: "Gateway endpoint: http:\/\/127.0.0.1:0\n", stderr: "" }
          : defaultCommandResult(args),
      /reported an invalid gateway port/u,
    ],
    [
      "a non-loopback gateway endpoint",
      (args: string[]) =>
        args.join(" ") === "gateway info -g test-gateway"
          ? { exitCode: 0, stdout: "Gateway endpoint: http:\/\/192.0.2.10:8080\n", stderr: "" }
          : defaultCommandResult(args),
      /reported an unsupported local gateway endpoint/u,
    ],
  ])("stops before effects for %s (#9833)", async (_caseName, result, expected) => {
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) => result(args));

    await expect(actionApply("default", minimalBlueprint())).rejects.toThrow(expected);
    expect(
      mockExeca.mock.calls.some(
        (call) => Array.isArray(call[1]) && call[1][0] === "sandbox" && call[1][1] === "create",
      ),
    ).toBe(false);
  });

  it("redacts a thrown gateway receipt inspection before effects (#9833)", async () => {
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
      args.join(" ") === "gateway info -g test-gateway"
        ? Promise.reject(new Error("GATEWAY_TOKEN=must-not-appear"))
        : defaultCommandResult(args),
    );

    await expect(actionApply("default", minimalBlueprint())).rejects.toThrow(
      "OpenShell gateway receipt inspection failed.",
    );
    expect(
      mockExeca.mock.calls.some(
        (call) => Array.isArray(call[1]) && call[1][0] === "sandbox" && call[1][1] === "create",
      ),
    ).toBe(false);
  });

  it.each([
    [
      "throws",
      async () => {
        throw new Error("POLICY_TOKEN=must-not-appear");
      },
    ],
    [
      "returns a failure",
      async () => ({ exitCode: 1, stdout: "", stderr: "POLICY_TOKEN=must-not-appear" }),
    ],
  ])("redacts a global authority command that %s (#9833)", async (_caseName, result) => {
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
      args.join(" ") === "policy list -g test-gateway --global --limit 1"
        ? result()
        : defaultCommandResult(args),
    );

    const error = await actionApply("default", minimalBlueprint()).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "OpenShell global policy authority inspection failed. Policy-dependent operations must stop.",
    );
    expect((error as Error).message).not.toContain("must-not-appear");
  });

  it.each([
    ["empty", "", /empty global policy authority metadata/u],
    [
      "invalid identity",
      JSON.stringify({
        scope: "global",
        status: "loaded",
        policy_source: "global",
        hash: "",
        active_version: 0,
        policy: {},
      }),
      /invalid global policy authority metadata/u,
    ],
    [
      "non-mapping policy",
      JSON.stringify({
        scope: "global",
        status: "loaded",
        policy_source: "global",
        hash: "sha256:global-policy",
        active_version: 1,
        policy: [],
      }),
      /invalid global policy authority metadata/u,
    ],
  ])("fails closed on %s active global metadata (#9833)", async (_caseName, stdout, expected) => {
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
      args.join(" ") === "policy list -g test-gateway --global --limit 1"
        ? { exitCode: 0, stdout: "VERSION STATUS\n1 loaded\n", stderr: "" }
        : args.join(" ") === "policy get -g test-gateway --global --full --output json"
          ? { exitCode: 0, stdout, stderr: "" }
          : defaultCommandResult(args),
    );

    await expect(actionApply("default", minimalBlueprint())).rejects.toThrow(expected);
    expect(
      mockExeca.mock.calls.some(
        (call) => Array.isArray(call[1]) && call[1][0] === "sandbox" && call[1][1] === "create",
      ),
    ).toBe(false);
  });

  it("treats a superseded global revision as absent and supplies the managed policy (#9833)", async () => {
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
      args.join(" ") === "policy list -g test-gateway --global --limit 1"
        ? { exitCode: 0, stdout: "VERSION STATUS\n1 superseded\n", stderr: "" }
        : args.join(" ") === "policy get -g test-gateway --global --full --output json"
          ? {
              exitCode: 0,
              stdout: JSON.stringify({
                scope: "global",
                status: "superseded",
                policy_source: "global",
              }),
              stderr: "",
            }
          : defaultCommandResult(args),
    );

    await actionApply("default", minimalBlueprint());

    expect(mockExeca).toHaveBeenCalledWith(
      "openshell",
      expect.arrayContaining(["sandbox", "create", "--policy", TEST_SANDBOX_POLICY_PATH]),
      expect.anything(),
    );
  });

  it.each([
    ["cannot be read", "/tmp/missing-policy.yaml", () => {}, /could not be read/u],
    [
      "is invalid",
      TEST_SANDBOX_POLICY_PATH,
      () => store.set(TEST_SANDBOX_POLICY_PATH, { type: "file", content: "version: [" }),
      /is invalid/u,
    ],
  ])(
    "stops before create when the configured policy %s (#9833)",
    async (_caseName, path, prepare, expected) => {
      vi.stubEnv("OPENSHELL_SANDBOX_POLICY", path);
      prepare();

      await expect(actionApply("default", minimalBlueprint())).rejects.toThrow(expected);
      expect(
        mockExeca.mock.calls.some(
          (call) => Array.isArray(call[1]) && call[1][0] === "sandbox" && call[1][1] === "create",
        ),
      ).toBe(false);
    },
  );

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

  function policyCreationReceipt(overrides: Record<string, unknown> = {}) {
    return {
      schemaVersion: 1,
      origin: "sandbox-create",
      gatewayName: "test-gateway",
      gatewayPort: 8080,
      sandboxName: "test-sandbox",
      lifecycleGeneration: FIXED_RUN_UUID,
      sandboxIdentityFingerprint: createHash("sha256").update("sandbox-id-1").digest("hex"),
      policyHash: "sha256:test-policy",
      policyVersion: 1,
      ...overrides,
    };
  }

  function targetPolicy(additions = blueprint().components!.policy!.additions!) {
    return { version: 1, network_policies: additions };
  }

  function targetPolicyDigest(policy: Record<string, unknown>): string {
    const stable = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(stable)
        : value !== null && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value as Record<string, unknown>)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, child]) => [key, stable(child)]),
            )
          : value;
    return createHash("sha256")
      .update(JSON.stringify(stable(policy)))
      .digest("hex");
  }

  function managedPolicyAuthority() {
    return {
      authority: "nemoclaw-managed",
      gateway: "test-gateway",
      gateway_host: "127.0.0.1",
      gateway_port: 8080,
      scope: "sandbox",
      sandbox_name: "test-sandbox",
      policy_creation_receipt: policyCreationReceipt(),
    };
  }

  function validReconciliationPlan() {
    const policy = targetPolicy();
    return {
      run_id: "reconcile-run",
      sandbox_name: "test-sandbox",
      sandbox_created_by_apply: true,
      policy_additions: blueprint().components!.policy!.additions!,
      policy_authority: managedPolicyAuthority(),
      policy_transition: {
        status: "incomplete",
        sandbox_name: "test-sandbox",
        gateway: "test-gateway",
        gateway_host: "127.0.0.1",
        gateway_port: 8080,
        expected_authority: "nemoclaw-managed",
        policy_addition_names: ["nim_service"],
        target_policy_digest: targetPolicyDigest(policy),
      },
    };
  }

  it("records ownership only for an explicit policy create on the exact gateway (#9833)", async () => {
    await actionApply("default", minimalBlueprint());

    expect(mockExeca).toHaveBeenCalledWith(
      "openshell",
      [
        "sandbox",
        "create",
        "-g",
        "test-gateway",
        "--from",
        "openclaw",
        "--name",
        "test-sandbox",
        "--policy",
        TEST_SANDBOX_POLICY_PATH,
        "--forward",
        "18789",
      ],
      expect.objectContaining({
        reject: false,
        env: expect.not.objectContaining({ OPENSHELL_SANDBOX_POLICY: expect.anything() }),
      }),
    );
    const planEntry = [...store.entries()].find(([path]) => path.endsWith("/plan.json"));
    const plan = JSON.parse(planEntry?.[1].content ?? "{}");
    expect(plan).toMatchObject({
      sandbox_created_by_apply: true,
      policy_authority: {
        authority: "nemoclaw-managed",
        gateway: "test-gateway",
        gateway_host: "127.0.0.1",
        gateway_port: 8080,
        sandbox_name: "test-sandbox",
        policy_creation_receipt: {
          origin: "sandbox-create",
          gatewayName: "test-gateway",
          gatewayPort: 8080,
          sandboxName: "test-sandbox",
          policyHash: "sha256:test-policy",
          policyVersion: 1,
        },
      },
    });
    expect(plan).not.toHaveProperty("policy_creation_transition");
    expect(JSON.stringify(plan.policy_authority)).not.toContain(TEST_SANDBOX_POLICY_PATH);
    expect(JSON.stringify(plan.policy_authority)).not.toContain("network_policies");
  });

  it("stops before create when no configured policy or verified global policy exists (#9833)", async () => {
    vi.stubEnv("OPENSHELL_SANDBOX_POLICY", "");

    await expect(actionApply("default", minimalBlueprint())).rejects.toThrow(
      /configured NemoClaw sandbox policy is required/u,
    );
    expect(
      mockExeca.mock.calls.some(
        (call) => Array.isArray(call[1]) && call[1][0] === "sandbox" && call[1][1] === "create",
      ),
    ).toBe(false);
  });

  it("does not mint ownership when sandbox create reports already exists (#9833)", async () => {
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
      args[0] === "sandbox" && args[1] === "create"
        ? { exitCode: 1, stdout: "", stderr: "sandbox already exists" }
        : defaultCommandResult(args),
    );

    await expect(actionApply("default", minimalBlueprint())).rejects.toThrow(
      /already exists.*cannot establish NemoClaw policy ownership/u,
    );
    const planEntry = [...store.entries()].find(([path]) => path.endsWith("/plan.json"));
    const plan = JSON.parse(planEntry?.[1].content ?? "{}");
    expect(plan).toMatchObject({
      sandbox_created_by_apply: false,
      policy_creation_transition: {
        status: "incomplete",
        gateway: "test-gateway",
        gateway_host: "127.0.0.1",
        gateway_port: 8080,
        sandbox_name: "test-sandbox",
      },
    });
    expect(plan).not.toHaveProperty("policy_authority");
    expect(policySetCalls()).toEqual([]);
    expect(
      mockExeca.mock.calls.some((call) => Array.isArray(call[1]) && call[1][0] === "provider"),
    ).toBe(false);
  });

  it("refuses conflicting sandbox identity fields before provider effects (#9833)", async () => {
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
      args.join(" ") === "sandbox get -g test-gateway test-sandbox"
        ? {
            exitCode: 0,
            stdout: "Name: test-sandbox\nId: sandbox-id\nId: replacement-id\nPhase: Ready\n",
            stderr: "",
          }
        : defaultCommandResult(args),
    );

    await expect(actionApply("default", minimalBlueprint())).rejects.toThrow(
      /did not prove the immutable identity/u,
    );
    expect(
      mockExeca.mock.calls.some((call) => Array.isArray(call[1]) && call[1][0] === "provider"),
    ).toBe(false);
  });

  it("stops before provider effects when the live sandbox identity changes (#9833)", async () => {
    const identityResult = sequentialCommandResult("sandbox get -g test-gateway test-sandbox", [
      sandboxIdentityResult("test-sandbox"),
      sandboxIdentityResult("test-sandbox", "replacement-id"),
    ]);
    mockExeca.mockImplementation(
      async (_cmd: string, args: string[]) => identityResult(args) ?? defaultCommandResult(args),
    );

    await expect(actionApply("default", minimalBlueprint())).rejects.toThrow(
      /receipt does not match the live sandbox policy/u,
    );
    expect(
      mockExeca.mock.calls.some((call) => Array.isArray(call[1]) && call[1][0] === "provider"),
    ).toBe(false);
    const planEntry = [...store.entries()].find(([path]) => path.endsWith("/plan.json"));
    expect(JSON.parse(planEntry?.[1].content ?? "{}")).toMatchObject({
      sandbox_created_by_apply: true,
      policy_authority: { authority: "nemoclaw-managed" },
    });
  });

  it("stops before provider effects when the gateway binding changes (#9833)", async () => {
    const gatewayResult = sequentialCommandResult("gateway info -g test-gateway", [
      gatewayInfoResult(),
      gatewayInfoResult(),
      gatewayInfoResult(9090),
    ]);
    mockExeca.mockImplementation(
      async (_cmd: string, args: string[]) => gatewayResult(args) ?? defaultCommandResult(args),
    );

    await expect(actionApply("default", minimalBlueprint())).rejects.toThrow(
      /gateway endpoint no longer matches the durable policy receipt/u,
    );
    expect(
      mockExeca.mock.calls.some((call) => Array.isArray(call[1]) && call[1][0] === "provider"),
    ).toBe(false);
  });

  it("rejects a non-loopback gateway substitution on the receipt port (#9833)", async () => {
    const gatewayResult = sequentialCommandResult("gateway info -g test-gateway", [
      gatewayInfoResult(),
      gatewayInfoResult(),
      gatewayInfoResult(8080, "gateway.example.com"),
    ]);
    mockExeca.mockImplementation(
      async (_cmd: string, args: string[]) => gatewayResult(args) ?? defaultCommandResult(args),
    );

    await expect(actionApply("default", minimalBlueprint())).rejects.toThrow(
      /unsupported local gateway endpoint/u,
    );
    expect(
      mockExeca.mock.calls.some(
        (call) => Array.isArray(call[1]) && call[1][0] === "provider" && call[1][1] === "create",
      ),
    ).toBe(false);
  });

  it("stops before provider effects when the live policy identity changes (#9833)", async () => {
    const policyResult = sequentialCommandResult(
      "policy get -g test-gateway --full --output json test-sandbox",
      [
        sandboxPolicyAuthorityResult(
          "test-sandbox",
          "nemoclaw-managed",
          {},
          { version: 1, network_policies: {} },
        ),
        sandboxPolicyAuthorityResult(
          "test-sandbox",
          "nemoclaw-managed",
          {},
          { version: 1, network_policies: {} },
          "sha256:replacement-policy",
        ),
      ],
    );
    mockExeca.mockImplementation(
      async (_cmd: string, args: string[]) => policyResult(args) ?? defaultCommandResult(args),
    );

    await expect(actionApply("default", minimalBlueprint())).rejects.toThrow(
      /receipt does not match the live sandbox policy/u,
    );
    expect(
      mockExeca.mock.calls.some((call) => Array.isArray(call[1]) && call[1][0] === "provider"),
    ).toBe(false);
  });

  it("rejects a created sandbox whose effective policy was not supplied by NemoClaw (#9833)", async () => {
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
      args.join(" ") === "policy get -g test-gateway --full --output json test-sandbox"
        ? sandboxPolicyAuthorityResult("test-sandbox", "externally-managed")
        : defaultCommandResult(args),
    );

    await expect(actionApply("default", minimalBlueprint())).rejects.toThrow(
      /did not prove the exact policy supplied by this NemoClaw create transaction/u,
    );
    expect(
      mockExeca.mock.calls.some(
        (call) => Array.isArray(call[1]) && call[1][0] === "provider" && call[1][1] === "create",
      ),
    ).toBe(false);
  });

  it("rejects managed receipt reuse after the policy becomes global (#9833)", async () => {
    const policyResult = sequentialCommandResult(
      "policy get -g test-gateway --full --output json test-sandbox",
      [
        sandboxPolicyAuthorityResult("test-sandbox"),
        sandboxPolicyAuthorityResult("test-sandbox", "externally-managed"),
      ],
    );
    mockExeca.mockImplementation(
      async (_cmd: string, args: string[]) => policyResult(args) ?? defaultCommandResult(args),
    );

    await expect(actionApply("default", minimalBlueprint())).rejects.toThrow(
      /live sandbox policy is no longer sandbox-scoped/u,
    );
    expect(
      mockExeca.mock.calls.some(
        (call) => Array.isArray(call[1]) && call[1][0] === "provider" && call[1][1] === "create",
      ),
    ).toBe(false);
  });

  it("rejects a verified external boundary after its gateway binding changes (#9833)", async () => {
    const additions = blueprint().components!.policy!.additions!;
    const gatewayResult = sequentialCommandResult("gateway info -g test-gateway", [
      gatewayInfoResult(),
      gatewayInfoResult(),
      gatewayInfoResult(9090),
    ]);
    mockExeca.mockImplementation(
      async (_cmd: string, args: string[]) =>
        gatewayResult(args) ??
        (args.join(" ") === "policy list -g test-gateway --global --limit 1"
          ? { exitCode: 0, stdout: "VERSION STATUS\n1 loaded\n", stderr: "" }
          : args.join(" ") === "policy get -g test-gateway --global --full --output json"
            ? globalPolicyAuthorityResult(additions)
            : args.join(" ") === "policy get -g test-gateway --full --output json test-sandbox"
              ? sandboxPolicyAuthorityResult("test-sandbox", "externally-managed", additions)
              : defaultCommandResult(args)),
    );

    await expect(actionApply("default", blueprint())).rejects.toThrow(
      /verified external policy boundary no longer matches/u,
    );
    expect(policySetCalls()).toEqual([]);
  });

  it("reports incomplete creation when receipt directory durability fails (#9833)", async () => {
    mockedFsyncSync.mockImplementation(
      throwOnCall(6, new Error("simulated receipt directory fsync failure")),
    );

    await expect(actionApply("default", minimalBlueprint())).rejects.toThrow(
      /simulated receipt directory fsync failure/u,
    );
    expect(stdoutCapture.text()).not.toContain("Apply complete");
    const planEntry = [...store.entries()].find(([path]) => path.endsWith("/plan.json"));
    const plan = JSON.parse(planEntry?.[1].content ?? "{}");
    expect(plan).toMatchObject({
      sandbox_created_by_apply: true,
      policy_creation_transition: { status: "incomplete" },
    });
    expect(plan).not.toHaveProperty("policy_authority");
  });

  it("reports incomplete mutation when receipt rotation durability fails (#9833)", async () => {
    mockedFsyncSync.mockImplementation(
      throwOnCall(14, new Error("simulated rotated receipt directory fsync failure")),
    );

    await expect(actionApply("default", blueprint())).rejects.toThrow(
      /simulated rotated receipt directory fsync failure/u,
    );
    expect(stdoutCapture.text()).not.toContain("Apply complete");
    const planEntry = [...store.entries()].find(([path]) => path.endsWith("/plan.json"));
    expect(JSON.parse(planEntry?.[1].content ?? "{}")).toMatchObject({
      policy_authority: {
        policy_creation_receipt: {
          policyHash: "sha256:updated-policy",
          policyVersion: 2,
        },
      },
      policy_transition: { status: "incomplete" },
    });
  });

  it("keeps the policy transition incomplete when policy set fails (#9833)", async () => {
    const diagnostic = `POLICY_TOKEN=super-secret ${"policy details ".repeat(80)}`;
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
      args[0] === "policy" && args[1] === "set"
        ? { exitCode: 1, stdout: "", stderr: diagnostic }
        : args.join(" ") === "policy get -g test-gateway --base test-sandbox"
          ? { exitCode: 0, stdout: policyOutput(TEST_SANDBOX_POLICY), stderr: "" }
          : defaultCommandResult(args),
    );

    const error = await actionApply("default", blueprint()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Failed to apply policy additions");
    expect((error as Error).message).toContain("POLICY_TOKEN=<REDACTED>");
    expect((error as Error).message).not.toContain("super-secret");
    const planEntry = [...store.entries()].find(([path]) => path.endsWith("/plan.json"));
    const plan = JSON.parse(planEntry?.[1].content ?? "{}");
    expect(plan).toMatchObject({
      policy_transition: {
        status: "pending",
        gateway: "test-gateway",
        gateway_host: "127.0.0.1",
        gateway_port: 8080,
        policy_addition_names: ["nim_service"],
      },
    });
  });

  it.each([
    ["a non-object plan", []],
    ["a missing authority receipt", { ...validReconciliationPlan(), policy_authority: undefined }],
    [
      "an external authority receipt",
      {
        ...validReconciliationPlan(),
        policy_authority: {
          authority: "externally-managed",
          gateway: "test-gateway",
          gateway_host: "127.0.0.1",
          gateway_port: 8080,
          scope: "global",
        },
      },
    ],
    [
      "an invalid transition receipt",
      { ...validReconciliationPlan(), policy_transition: undefined },
    ],
    [
      "a transition for another sandbox",
      {
        ...validReconciliationPlan(),
        policy_transition: {
          ...validReconciliationPlan().policy_transition,
          sandbox_name: "replacement-sandbox",
        },
      },
    ],
    [
      "a transition for another gateway",
      {
        ...validReconciliationPlan(),
        policy_transition: {
          ...validReconciliationPlan().policy_transition,
          gateway: "replacement-gateway",
        },
      },
    ],
    ["invalid policy additions", { ...validReconciliationPlan(), policy_additions: [] }],
    ["mismatched policy additions", { ...validReconciliationPlan(), policy_additions: {} }],
    [
      "a policy target with a mismatched digest",
      {
        ...validReconciliationPlan(),
        policy_transition: {
          ...validReconciliationPlan().policy_transition,
          target_policy_digest: "a".repeat(64),
        },
      },
    ],
  ])("refuses reconciliation from %s (#9833)", async (caseName, plan) => {
    const runId = `invalid-reconciliation-${caseName.replaceAll(" ", "-")}`;
    const stateDir = `${FAKE_HOME}/.nemoclaw/state/runs/${runId}`;
    store.set(stateDir, { type: "dir" });
    store.set(`${stateDir}/plan.json`, { type: "file", content: JSON.stringify(plan) });
    store.set(`${stateDir}/merged-policy.yaml`, {
      type: "file",
      content: YAML.stringify(targetPolicy()),
    });

    await expect(actionReconcile(runId)).rejects.toThrow(
      new RegExp(`Cannot read reconciliation plan for run ${runId}`),
    );
    expect(mockExeca).not.toHaveBeenCalled();
  });

  it("reconciles only the exact intended policy and rotates the receipt (#9833)", async () => {
    const runId = "incomplete-transition";
    const stateDir = `${FAKE_HOME}/.nemoclaw/state/runs/${runId}`;
    const policy = targetPolicy();
    store.set(stateDir, { type: "dir" });
    store.set(`${stateDir}/merged-policy.yaml`, {
      type: "file",
      content: YAML.stringify(policy),
    });
    store.set(`${stateDir}/plan.json`, {
      type: "file",
      content: JSON.stringify({
        run_id: runId,
        sandbox_name: "test-sandbox",
        sandbox_created_by_apply: true,
        inference_provider_created_by_apply: false,
        policy_additions: blueprint().components!.policy!.additions!,
        policy_authority: managedPolicyAuthority(),
        policy_transition: {
          status: "incomplete",
          sandbox_name: "test-sandbox",
          gateway: "test-gateway",
          gateway_host: "127.0.0.1",
          gateway_port: 8080,
          expected_authority: "nemoclaw-managed",
          policy_addition_names: ["nim_service"],
          target_policy_digest: targetPolicyDigest(policy),
        },
      }),
    });
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
      args.join(" ") === "policy get -g test-gateway --full --output json test-sandbox"
        ? sandboxPolicyAuthorityResult(
            "test-sandbox",
            "nemoclaw-managed",
            policy.network_policies,
            policy,
          )
        : defaultCommandResult(args),
    );

    await main(["reconcile", "--run-id", runId]);
    expect(JSON.parse(store.get(`${stateDir}/plan.json`)?.content ?? "{}")).toMatchObject({
      policy_authority: {
        policy_creation_receipt: {
          policyHash: "sha256:test-policy",
          policyVersion: 1,
        },
      },
      policy_transition: { status: "complete" },
    });
  });

  it("refuses reconcile when the durable target does not match live policy (#9833)", async () => {
    const runId = "mismatched-transition";
    const stateDir = `${FAKE_HOME}/.nemoclaw/state/runs/${runId}`;
    const policy = targetPolicy();
    store.set(stateDir, { type: "dir" });
    store.set(`${stateDir}/merged-policy.yaml`, {
      type: "file",
      content: YAML.stringify(policy),
    });
    store.set(`${stateDir}/plan.json`, {
      type: "file",
      content: JSON.stringify({
        run_id: runId,
        sandbox_name: "test-sandbox",
        sandbox_created_by_apply: true,
        policy_additions: blueprint().components!.policy!.additions!,
        policy_authority: managedPolicyAuthority(),
        policy_transition: {
          status: "incomplete",
          sandbox_name: "test-sandbox",
          gateway: "test-gateway",
          gateway_host: "127.0.0.1",
          gateway_port: 8080,
          expected_authority: "nemoclaw-managed",
          policy_addition_names: ["nim_service"],
          target_policy_digest: targetPolicyDigest(policy),
        },
      }),
    });

    await expect(actionReconcile(runId)).rejects.toThrow(/exact intended policy/u);
    expect(JSON.parse(store.get(`${stateDir}/plan.json`)?.content ?? "{}")).toMatchObject({
      policy_transition: { status: "incomplete" },
    });
  });

  it("rejects an invalid persisted policy creation transition (#9833)", async () => {
    const runId = "invalid-creation";
    const stateDir = `${FAKE_HOME}/.nemoclaw/state/runs/${runId}`;
    store.set(stateDir, { type: "dir" });
    store.set(`${stateDir}/plan.json`, {
      type: "file",
      content: JSON.stringify({
        run_id: runId,
        sandbox_name: "test-sandbox",
        policy_creation_transition: {
          status: "complete",
          gateway: "test-gateway",
          gateway_host: "127.0.0.1",
          gateway_port: 8080,
          sandbox_name: "test-sandbox",
          lifecycle_generation: FIXED_RUN_UUID,
        },
      }),
    });

    stdoutCapture.reset();
    actionStatus(runId);
    expect(stdoutCapture.jsonOutput()).toMatchObject({
      run_id: runId,
      status: "unknown",
      receipt_error_kind: "invalid",
    });
    await expect(actionRollback(runId)).rejects.toThrow(/policy creation transition is invalid/u);
    expect(mockExeca).not.toHaveBeenCalled();
  });

  it("reports a non-object run receipt as invalid (#9833)", () => {
    const runId = "non-object-receipt";
    const stateDir = `${FAKE_HOME}/.nemoclaw/state/runs/${runId}`;
    store.set(stateDir, { type: "dir" });
    store.set(`${stateDir}/plan.json`, { type: "file", content: "[]" });

    stdoutCapture.reset();
    actionStatus(runId);

    expect(stdoutCapture.jsonOutput()).toMatchObject({
      run_id: runId,
      status: "unknown",
      receipt_error_kind: "invalid",
    });
  });

  it("reports a pending policy creation checkpoint without granting authority (#9833)", () => {
    const runId = "pending-policy-creation";
    const stateDir = `${FAKE_HOME}/.nemoclaw/state/runs/${runId}`;
    store.set(stateDir, { type: "dir" });
    store.set(`${stateDir}/plan.json`, {
      type: "file",
      content: JSON.stringify({
        run_id: runId,
        policy_creation_transition: {
          status: "pending",
          gateway: "test-gateway",
          gateway_host: "127.0.0.1",
          gateway_port: 8080,
          sandbox_name: "test-sandbox",
          lifecycle_generation: FIXED_RUN_UUID,
        },
      }),
    });

    stdoutCapture.reset();
    actionStatus(runId);

    expect(stdoutCapture.jsonOutput()).toMatchObject({
      run_id: runId,
      policy_creation_transition: { status: "pending" },
    });
    expect(stdoutCapture.jsonOutput()).not.toHaveProperty("policy_authority");
  });

  it("reports an invalid policy transition receipt without exposing it (#9833)", () => {
    const runId = "invalid-policy-transition";
    const stateDir = `${FAKE_HOME}/.nemoclaw/state/runs/${runId}`;
    store.set(stateDir, { type: "dir" });
    store.set(`${stateDir}/plan.json`, {
      type: "file",
      content: JSON.stringify({
        run_id: runId,
        policy_transition: { status: "pending" },
      }),
    });

    stdoutCapture.reset();
    actionStatus(runId);

    expect(stdoutCapture.jsonOutput()).toMatchObject({
      run_id: runId,
      status: "unknown",
      receipt_error_kind: "invalid",
    });
  });

  it("reports the exact recovery action for an incomplete policy transition (#9833)", () => {
    const runId = "incomplete-policy-transition";
    const stateDir = `${FAKE_HOME}/.nemoclaw/state/runs/${runId}`;
    store.set(stateDir, { type: "dir" });
    store.set(`${stateDir}/plan.json`, {
      type: "file",
      content: JSON.stringify({ ...validReconciliationPlan(), run_id: runId }),
    });

    stdoutCapture.reset();
    actionStatus(runId);

    expect(stdoutCapture.jsonOutput()).toMatchObject({
      run_id: runId,
      policy_transition: {
        status: "incomplete",
        reconciliation_required: true,
        reconciliation_action: expect.stringContaining("reconcile"),
      },
    });
  });

  it("rejects a malformed managed receipt before rollback mutation (#9833)", async () => {
    const runId = "malformed-receipt";
    const stateDir = `${FAKE_HOME}/.nemoclaw/state/runs/${runId}`;
    store.set(stateDir, { type: "dir" });
    store.set(`${stateDir}/plan.json`, {
      type: "file",
      content: JSON.stringify({
        run_id: runId,
        sandbox_name: "test-sandbox",
        sandbox_created_by_apply: true,
        policy_authority: {
          ...managedPolicyAuthority(),
          policy_creation_receipt: { status: "pending" },
        },
      }),
    });

    await expect(actionRollback(runId)).rejects.toThrow(/policy authority receipt is invalid/u);
    expect(mockExeca).not.toHaveBeenCalled();
  });

  it("rejects a receipt whose wrapper names a different sandbox (#9833)", async () => {
    const runId = "mismatched-wrapper";
    const stateDir = `${FAKE_HOME}/.nemoclaw/state/runs/${runId}`;
    store.set(stateDir, { type: "dir" });
    store.set(`${stateDir}/plan.json`, {
      type: "file",
      content: JSON.stringify({
        run_id: runId,
        sandbox_name: "replacement-sandbox",
        sandbox_created_by_apply: true,
        policy_authority: {
          ...managedPolicyAuthority(),
          sandbox_name: "replacement-sandbox",
        },
      }),
    });

    await expect(actionRollback(runId)).rejects.toThrow(/policy authority receipt is invalid/u);
    expect(mockExeca).not.toHaveBeenCalled();
  });

  it("does not report an unexpected receipt field through status (#9833)", () => {
    const runId = "extended-receipt";
    const stateDir = `${FAKE_HOME}/.nemoclaw/state/runs/${runId}`;
    store.set(stateDir, { type: "dir" });
    store.set(`${stateDir}/plan.json`, {
      type: "file",
      content: JSON.stringify({
        run_id: runId,
        policy_authority: {
          ...managedPolicyAuthority(),
          credential_value: "must-not-appear",
        },
      }),
    });

    stdoutCapture.reset();
    actionStatus(runId);
    expect(stdoutCapture.jsonOutput()).toMatchObject({
      run_id: runId,
      status: "unknown",
      receipt_error_kind: "invalid",
    });
    expect(stdoutCapture.text()).not.toContain("must-not-appear");
  });

  it("revalidates a complete transition before reporting it complete (#9833)", async () => {
    const runId = "complete-transition";
    const stateDir = `${FAKE_HOME}/.nemoclaw/state/runs/${runId}`;
    const policy = targetPolicy();
    store.set(stateDir, { type: "dir" });
    store.set(`${stateDir}/merged-policy.yaml`, {
      type: "file",
      content: YAML.stringify(policy),
    });
    store.set(`${stateDir}/plan.json`, {
      type: "file",
      content: JSON.stringify({
        run_id: runId,
        sandbox_name: "test-sandbox",
        sandbox_created_by_apply: true,
        policy_additions: blueprint().components!.policy!.additions!,
        policy_authority: managedPolicyAuthority(),
        policy_transition: {
          status: "complete",
          sandbox_name: "test-sandbox",
          gateway: "test-gateway",
          gateway_host: "127.0.0.1",
          gateway_port: 8080,
          expected_authority: "nemoclaw-managed",
          policy_addition_names: ["nim_service"],
          target_policy_digest: targetPolicyDigest(policy),
        },
      }),
    });
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
      args.join(" ") === "policy get -g test-gateway --full --output json test-sandbox"
        ? sandboxPolicyAuthorityResult(
            "test-sandbox",
            "nemoclaw-managed",
            policy.network_policies,
            policy,
          )
        : defaultCommandResult(args),
    );

    await actionReconcile(runId);
    expect(stdoutCapture.text()).toContain(
      `Policy transition for run ${runId} is already complete.`,
    );
    await expect(main(["reconcile"])).rejects.toThrow(/--run-id is required/u);
  });
});
