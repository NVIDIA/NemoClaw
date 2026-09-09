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
vi.mock("./private-networks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./private-networks.js")>()),
  isPrivateHostname: (host: string) =>
    new Set(["0.0.0.0", "10.0.0.1", "127.0.0.1", "169.254.169.254"]).has(host),
}));

const { actionApply, actionReconcile, actionStatus } = await import("./runner.js");
const { validateEndpointUrl } = await import("./ssrf.js");
const mockedValidateEndpoint = vi.mocked(validateEndpointUrl);

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
  let policyHistory: Map<number, Record<string, unknown>>;
  let policyVersion: number;
  let globalActive: boolean;
  let basePolicyFailure: string | null;
  let basePolicyOutput: string | null;
  let basePolicyReads: number;
  let mutateBasePolicyOnRead: number | null;
  let mutateBasePolicy: (() => void) | null;
  let mutateBeforePolicySet: (() => void) | null;
  let policySetDiagnostic: string | null;
  let policySetBehavior: "applied" | "ambiguous-applied" | "ambiguous-unapplied" | "rejected";

  function recordHostMutation(mutation: (() => void) | null): void {
    mutation?.();
    policyVersion += mutation === null ? 0 : 1;
    mutation === null ? undefined : policyHistory.set(policyVersion, structuredClone(livePolicy));
  }

  function recordPolicyWrite(policy: Record<string, unknown>): void {
    livePolicy = policy;
    policyVersion += 1;
    policyHistory.set(policyVersion, structuredClone(livePolicy));
  }

  beforeEach(() => {
    store.clear();
    store.set(TEST_SANDBOX_POLICY_PATH, { type: "file", content: TEST_SANDBOX_POLICY });
    vi.stubEnv("OPENSHELL_SANDBOX_POLICY", TEST_SANDBOX_POLICY_PATH);
    livePolicy = {
      version: 1,
      future_section: { preserve: true },
      network_policies: { host_added: { endpoints: [{ host: "host.example", port: 443 }] } },
    };
    policyVersion = 1;
    policyHistory = new Map([[policyVersion, structuredClone(livePolicy)]]);
    globalActive = false;
    basePolicyFailure = null;
    basePolicyOutput = null;
    basePolicyReads = 0;
    mutateBasePolicyOnRead = null;
    mutateBasePolicy = null;
    mutateBeforePolicySet = null;
    policySetDiagnostic = null;
    policySetBehavior = "applied";
    mockedValidateEndpoint
      .mockReset()
      .mockImplementation(async (url: string) => resolvedEndpointFor(url));
    mockExeca.mockReset().mockImplementation(async (_command: string, args: string[]) => {
      const joined = args.join(" ");
      const revisionRead = /^policy get -g test-gateway --rev (\d+) --base test-sandbox$/u.exec(
        joined,
      );
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
            `sha256:test-policy-${String(policyVersion)}`,
            policyVersion,
          );
        case revisionRead?.[0]:
          return {
            exitCode: 0,
            stdout: YAML.stringify(
              policyHistory.get(Number.parseInt(revisionRead?.[1] ?? "0", 10)) ?? livePolicy,
            ),
            stderr: "",
          };
        case "policy get -g test-gateway --base test-sandbox":
          basePolicyReads += 1;
          recordHostMutation(basePolicyReads === mutateBasePolicyOnRead ? mutateBasePolicy : null);
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
          const concurrentMutation = mutateBeforePolicySet;
          mutateBeforePolicySet = null;
          recordHostMutation(concurrentMutation);
          const requestedPolicy = YAML.parse(String(store.get(path)?.content ?? "")) as Record<
            string,
            unknown
          >;
          switch (policySetBehavior) {
            case "rejected":
              return {
                exitCode: 1,
                stdout: "",
                stderr:
                  policySetDiagnostic ??
                  "Error: code: 'failed_precondition', message: 'write rejected'",
              };
            case "ambiguous-unapplied":
              return {
                exitCode: 1,
                stdout: "",
                stderr: policySetDiagnostic ?? "h2 protocol error",
              };
            case "ambiguous-applied":
              recordPolicyWrite(requestedPolicy);
              return { exitCode: 1, stdout: "", stderr: "h2 protocol error" };
            default:
              recordPolicyWrite(requestedPolicy);
              return successResult();
          }
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

  it("writes the DNS-pinned address returned by policy hostname validation", async () => {
    mockedValidateEndpoint.mockResolvedValueOnce({
      url: "http://integrate.api.nvidia.com:443",
      pinnedUrl: "http://93.184.216.34:443/",
      protocol: "http:",
      hostname: "integrate.api.nvidia.com",
      resolvedAddress: "93.184.216.34",
      resolvedFamily: 4,
      dnsResolved: true,
    });

    await actionApply("default", blueprint());

    expect(livePolicy.network_policies).toMatchObject({
      nim_service: {
        endpoints: [{ host: "93.184.216.34", port: 443, access: "full" }],
      },
    });
  });

  it.each(["*", "*.example.com", "0.0.0.0", "169.254.169.254", "127.0.0.1", "10.0.0.1"])(
    "rejects unsafe policy host %s before any lifecycle mutation",
    async (host) => {
      const value = structuredClone(blueprint());
      value.components!.policy!.additions!.nim_service.endpoints[0].host = host;

      await expect(actionApply("default", value)).rejects.toThrow(
        "Blueprint policy addition 'nim_service' endpoint 1 is rejected",
      );
      expect(mockExeca).not.toHaveBeenCalled();
      expect([...store.keys()].some((path) => path.includes("/.nemoclaw/state/runs/"))).toBe(false);
    },
  );

  it("rejects a policy hostname that resolves to a private address before any lifecycle mutation", async () => {
    const value = structuredClone(blueprint());
    value.components!.policy!.additions!.nim_service.endpoints[0].host = "rebind.example.com";
    mockedValidateEndpoint.mockRejectedValueOnce(
      new Error("Endpoint URL resolves to private/internal address 127.0.0.1"),
    );

    await expect(actionApply("default", value)).rejects.toThrow(
      /Blueprint policy addition 'nim_service' endpoint 1 is rejected:.*127\.0\.0\.1/iu,
    );
    expect(mockedValidateEndpoint).toHaveBeenCalledWith("http://rebind.example.com:443");
    expect(mockExeca).not.toHaveBeenCalled();
    expect([...store.keys()].some((path) => path.includes("/.nemoclaw/state/runs/"))).toBe(false);
  });

  it("rejects a DNS validation result that does not pin the policy hostname", async () => {
    mockedValidateEndpoint.mockResolvedValueOnce({
      url: "http://integrate.api.nvidia.com:443",
      pinnedUrl: "http://integrate.api.nvidia.com:443/",
      protocol: "http:",
      hostname: "integrate.api.nvidia.com",
      resolvedAddress: "93.184.216.34",
      resolvedFamily: 4,
      dnsResolved: true,
    });

    await expect(actionApply("default", blueprint())).rejects.toThrow(
      /policy hostname validation did not return a pinned IP address/iu,
    );
    expect(mockExeca).not.toHaveBeenCalled();
  });

  it("verifies policy additions before creating the inference provider or route", async () => {
    await actionApply("default", blueprint());

    const commands = mockExeca.mock.calls.map(([, args]) => (args ?? []).join(" "));
    const policySet = commands.findIndex((command) => command.startsWith("policy set "));
    const policyVerification = commands.findIndex(
      (command, index) =>
        index > policySet &&
        command === "policy get -g test-gateway --full --output json test-sandbox",
    );
    const providerCreate = commands.findIndex((command) => command.startsWith("provider create "));
    const inferenceSet = commands.findIndex((command) => command.startsWith("inference set "));

    expect(policySet).toBeGreaterThanOrEqual(0);
    expect(policyVerification).toBeGreaterThan(policySet);
    expect(providerCreate).toBeGreaterThan(policyVerification);
    expect(inferenceSet).toBeGreaterThan(providerCreate);
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

  it("rebases additions when an unrelated host edit races the policy write", async () => {
    mutateBeforePolicySet = () => {
      livePolicy.network_policies = {
        ...(livePolicy.network_policies as Record<string, unknown>),
        concurrent_after_read: {
          endpoints: [{ host: "after-read.example", port: 443 }],
        },
      };
    };

    await actionApply("default", blueprint());

    expect(livePolicy.network_policies).toEqual(
      expect.objectContaining({
        concurrent_after_read: expect.any(Object),
        nim_service: additions.nim_service,
      }),
    );
    expect(
      mockExeca.mock.calls.filter(
        ([, args]) => Array.isArray(args) && args[0] === "policy" && args[1] === "set",
      ),
    ).toHaveLength(2);
  });

  it("restores a blueprint-owned host edit that races the policy write", async () => {
    mutateBeforePolicySet = () => {
      livePolicy.network_policies = {
        ...(livePolicy.network_policies as Record<string, unknown>),
        nim_service: {
          name: "nim_service",
          endpoints: [{ host: "operator-after-read.example", port: 443, access: "full" }],
        },
      };
    };

    await expect(actionApply("default", blueprint())).rejects.toThrow(
      "network policy 'nim_service' changed concurrently",
    );
    expect(livePolicy.network_policies).toMatchObject({
      nim_service: { endpoints: [{ host: "operator-after-read.example" }] },
    });
    expect(
      mockExeca.mock.calls.some(
        ([, args]) => Array.isArray(args) && args[0] === "provider" && args[1] === "create",
      ),
    ).toBe(false);
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

  it("rejects literal credentials before creating a blueprint policy handoff", async () => {
    livePolicy.process = {
      environment: { SERVICE_API_KEY: "opaque-live-policy-credential" },
    };

    await expect(actionApply("default", blueprint())).rejects.toThrow(
      "Cannot prepare the blueprint policy update because the live OpenShell policy contains a literal credential value.",
    );
    expect([...store.keys()].some((path) => path.endsWith("policy-update.yaml"))).toBe(false);
    expect(
      mockExeca.mock.calls.some(
        ([, args]) => Array.isArray(args) && args[0] === "policy" && args[1] === "set",
      ),
    ).toBe(false);
  });

  it("redacts a rejected OpenShell policy-write diagnostic", async () => {
    const urlCredential = "opaque-url-credential";
    const assignmentCredential = "opaque-lowercase-credential";
    policySetBehavior = "rejected";
    policySetDiagnostic =
      `Error: code: 'failed_precondition', message: 'write rejected at ` +
      `https://operator:${urlCredential}@api.example apiKey=${assignmentCredential}'`;

    const failure = await actionApply("default", blueprint()).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/Failed to apply policy additions: write rejected/);
    expect((failure as Error).message).not.toContain(urlCredential);
    expect((failure as Error).message).not.toContain(assignmentCredential);
    const commands = mockExeca.mock.calls.map(([, args]) => (args ?? []).join(" "));
    expect(commands.some((command) => command.startsWith("provider create "))).toBe(false);
    expect(commands.some((command) => command.startsWith("inference set "))).toBe(false);
  });

  it("accepts an ambiguous write only when typed readback contains the requested additions", async () => {
    policySetBehavior = "ambiguous-applied";

    await actionApply("default", blueprint());

    expect(livePolicy.network_policies).toMatchObject({ nim_service: additions.nim_service });
  });

  it("redacts an ambiguous policy-write diagnostic before stopping", async () => {
    const urlCredential = "opaque-url-credential";
    const assignmentCredential = "opaque-lowercase-credential";
    policySetBehavior = "ambiguous-unapplied";
    policySetDiagnostic =
      `h2 protocol error at https://operator:${urlCredential}@api.example ` +
      `apiKey=${assignmentCredential}`;

    const failure = await actionApply("default", blueprint()).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(
      /Could not confirm the blueprint policy update: h2 protocol error/,
    );
    expect((failure as Error).message).not.toContain(urlCredential);
    expect((failure as Error).message).not.toContain(assignmentCredential);
    expect(livePolicy.network_policies).not.toHaveProperty("nim_service");
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

  it("preserves bounded sanitized mTLS detail when global policy inspection fails", async () => {
    const tlsDirectory = "/tmp/openshell-policy-tls";
    const urlCredential = "opaque-url-credential";
    const assignmentCredential = "opaque-assignment-credential";
    const truncatedTail = "must-not-survive-the-policy-detail-limit";
    vi.stubEnv("OPENSHELL_LOCAL_TLS_DIR", tlsDirectory);
    const implementation = mockExeca.getMockImplementation();
    expect(implementation).toBeDefined();
    mockExeca.mockImplementation(async (command: string, args: string[]) =>
      args.join(" ") === "policy list -g test-gateway --global --limit 1"
        ? {
            exitCode: 1,
            stdout: "",
            stderr:
              `BadSignature \u001b[31mforged\u202efailure from ` +
              `https://operator:${urlCredential}'fragment@example.test ` +
              `AUTH_TOKEN=${assignmentCredential} ${"diagnostic-word ".repeat(30)} ${truncatedTail}`,
          }
        : implementation!(command, args),
    );

    const failure = await actionApply("default", blueprint()).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("BadSignature");
    expect(message).toContain("\\u001b[31mforged\\u202efailure");
    expect(message).not.toMatch(
      /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u,
    );
    expect(message).not.toContain(urlCredential);
    expect(message).not.toContain(assignmentCredential);
    expect(message).not.toContain(truncatedTail);
    const detail = /OpenShell detail: (.*)\. Policy-dependent operations must stop\.$/u.exec(
      message,
    )?.[1];
    expect(detail).toBeDefined();
    expect(detail!.length).toBeLessThanOrEqual(240);

    const policyCalls = mockExeca.mock.calls.filter(
      ([, args]) => Array.isArray(args) && args[0] === "policy",
    );
    expect(policyCalls).toHaveLength(1);
    expect(policyCalls[0]).toEqual([
      "openshell",
      ["policy", "list", "-g", "test-gateway", "--global", "--limit", "1"],
      expect.objectContaining({
        extendEnv: false,
        env: expect.objectContaining({
          OPENSHELL_GATEWAY: "test-gateway",
          OPENSHELL_LOCAL_TLS_DIR: tlsDirectory,
        }),
      }),
    ]);
    const commands = mockExeca.mock.calls.map(([, args]) => (args ?? []).join(" "));
    expect(
      commands.some((command) =>
        /^(?:policy get|policy set|sandbox create|provider create|inference set)\b/u.test(command),
      ),
    ).toBe(false);
  });

  it("preserves bounded sanitized mTLS detail when sandbox policy inspection fails", async () => {
    const tlsDirectory = "/tmp/openshell-sandbox-policy-tls";
    const urlCredential = "opaque-sandbox-url-credential";
    const assignmentCredential = "opaque-sandbox-assignment-credential";
    const truncatedTail = "must-not-survive-the-sandbox-policy-detail-limit";
    vi.stubEnv("OPENSHELL_LOCAL_TLS_DIR", tlsDirectory);
    const implementation = mockExeca.getMockImplementation();
    expect(implementation).toBeDefined();
    mockExeca.mockImplementation(async (command: string, args: string[]) => {
      const joined = args.join(" ");
      return joined.startsWith("sandbox create -g test-gateway ")
        ? { exitCode: 1, stdout: "", stderr: "sandbox already exists" }
        : joined === "policy get -g test-gateway --full --output json test-sandbox"
          ? {
              exitCode: 1,
              stdout:
                `BadSignature \u001b[31mforged\u202efailure from ` +
                `https://operator:${urlCredential}'fragment@example.test ` +
                `AUTH_TOKEN=${assignmentCredential} ${"diagnostic-word ".repeat(30)} ${truncatedTail}`,
              stderr: "",
            }
          : implementation!(command, args);
    });

    const failure = await actionApply("default", blueprint()).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("OpenShell sandbox policy inspection failed");
    expect(message).toContain("BadSignature");
    expect(message).toContain("\\u001b[31mforged\\u202efailure");
    expect(message).not.toMatch(
      /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u,
    );
    expect(message).not.toContain(urlCredential);
    expect(message).not.toContain(assignmentCredential);
    expect(message).not.toContain(truncatedTail);
    const detail = message.split("OpenShell detail: ")[1]?.split(". Policy-dependent")[0];
    expect(detail).toBeDefined();
    expect(detail!.length).toBeLessThanOrEqual(240);

    const commands = mockExeca.mock.calls.map(([, args]) => (args ?? []).join(" "));
    expect(commands).toContain("policy list -g test-gateway --global --limit 1");
    expect(commands).toContain("policy get -g test-gateway --full --output json test-sandbox");
    expect(commands.filter((command) => command.startsWith("sandbox create "))).toHaveLength(1);
    expect(mockExeca).toHaveBeenCalledWith(
      "openshell",
      ["policy", "get", "-g", "test-gateway", "--full", "--output", "json", "test-sandbox"],
      expect.objectContaining({
        extendEnv: false,
        env: expect.objectContaining({
          OPENSHELL_GATEWAY: "test-gateway",
          OPENSHELL_LOCAL_TLS_DIR: tlsDirectory,
        }),
      }),
    );
    expect(
      commands.some((command) => /^(?:policy set|provider create|inference set)\b/u.test(command)),
    ).toBe(false);
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
