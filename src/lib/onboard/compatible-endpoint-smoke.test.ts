// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  nativeLocalIdentity,
  type NativeLocalProviderAttachment,
} from "../inference/native-local/contract";
import type { OpenShellSandboxBufferedCommandRequest } from "../adapters/openshell/sandbox-command";
import {
  providerNeutralResponses,
  runProviderNeutralScript,
  type ProviderNeutralAuthority,
} from "./__test-helpers__/compatible-endpoint-smoke-helpers";

import {
  createCompatibleEndpointSmoke,
  buildCompatibleEndpointSandboxSmokeScript,
  buildProviderNeutralInferenceSandboxSmokeScript,
  spawnOutputToString,
  verifyCompatibleEndpointSandboxSmoke,
} from "./compatible-endpoint-smoke";

type CompatibleSmokeOptions = Parameters<typeof verifyCompatibleEndpointSandboxSmoke>[0];

function bufferedExecutorThrough(runOpenshell: CompatibleSmokeOptions["runOpenshell"]) {
  return {
    runBuffered: vi.fn(async (request: OpenShellSandboxBufferedCommandRequest) => {
      const targetArgs = request.target.kind === "named" ? ["-g", request.target.gatewayName] : [];
      const ttyArgs = request.tty === false ? ["--no-tty"] : [];
      const args = ["sandbox", "exec", "-n", request.sandboxName, ...targetArgs, ...ttyArgs];
      for (const [key, value] of Object.entries(request.sandboxEnvironment ?? {})) {
        args.push("--env", `${key}=${value}`);
      }
      const result = runOpenshell([...args, "--", ...request.command], {
        ignoreError: true,
        suppressOutput: true,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: request.timeoutMilliseconds,
      });
      return result.status === null
        ? {
            outcome: {
              kind: "failed" as const,
              error: { kind: "invocation" as const, message: "unobservable" },
            },
            stdout: spawnOutputToString(result.stdout),
            stderr: spawnOutputToString(result.stderr),
          }
        : {
            outcome: { kind: "completed" as const, exitCode: result.status },
            stdout: spawnOutputToString(result.stdout),
            stderr: spawnOutputToString(result.stderr),
          };
    }),
  };
}

const providerNeutralCases = ["openclaw", "hermes", "langchain-deepagents-code"].flatMap(
  (agentName) => [
    {
      agentName,
      service: "ollama" as const,
      provider: "ollama-local",
      port: 11434,
      directHealthPath: "/api/tags" as const,
    },
    {
      agentName,
      service: "nim" as const,
      provider: "vllm-local",
      port: 8001,
      directHealthPath: "/v1/health/ready" as const,
    },
    {
      agentName,
      service: "vllm" as const,
      provider: "vllm-local",
      port: 8000,
      directHealthPath: "/health" as const,
    },
  ],
);

const allAgentProofAuthorities = [
  {
    agentName: "openclaw",
    authority: {
      service: "ollama",
      directHostPort: 11434,
      directHealthPath: "/api/tags",
      toolCallingRequired: true,
    },
  },
  {
    agentName: "hermes",
    authority: {
      service: "nim",
      directHostPort: 8001,
      directHealthPath: "/v1/health/ready",
      toolCallingRequired: true,
    },
  },
  {
    agentName: "langchain-deepagents-code",
    authority: {
      service: "vllm",
      directHostPort: 8000,
      directHealthPath: "/health",
      toolCallingRequired: true,
    },
  },
] as const satisfies readonly { agentName: string; authority: ProviderNeutralAuthority }[];

describe("compatible endpoint sandbox smoke helpers", () => {
  const nativeBinding = {
    provider: "compatible-endpoint",
    endpointUrl: "http://host.openshell.internal:8000/v1",
    credentialEnv: "NEMOCLAW_LOCAL_INFERENCE_TOKEN",
    authMode: "authenticated",
    gatewayName: "nemoclaw",
    sandboxName: "native-denial",
  } as const;
  const nativeAttachment: NativeLocalProviderAttachment = {
    ...nativeBinding,
    ...nativeLocalIdentity(nativeBinding),
    schemaVersion: 1,
    providerId: "native-denial-provider",
  };
  // OpenShell 0.1.3 l7/rest.rs deny_response_body; Brev recorded this path-only reason.
  const nativeDenial = {
    error: "policy_denied",
    detail: "POST /v1/nemoclaw-denied not permitted by policy",
    layer: "l7",
    protocol: "rest",
    method: "POST",
    path: "/v1/nemoclaw-denied",
    host: "host.openshell.internal",
    port: 8000,
    policy: `_provider_${nativeAttachment.providerName.replaceAll("-", "_")}`,
    rule: "POST /v1/nemoclaw-denied",
  };

  it("accepts the native OpenShell L7 denial for the attached provider's forbidden path", () => {
    const result = runProviderNeutralScript({
      authority: allAgentProofAuthorities[0].authority,
      local: nativeAttachment,
      denial: nativeDenial,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("INFERENCE_SMOKE_OK PONG");
    expect(result.stdout).toContain(
      "DIRECT_REQUEST_URLS=http://host.openshell.internal:8000/v1/nemoclaw-denied",
    );
  });

  it.each(["connection-refused", "network-unreachable", "host-unreachable"] as const)(
    "checks the native IPv4 policy denial after an IPv6 %s result",
    (ipv6Outcome) => {
      const result = runProviderNeutralScript({
        authority: allAgentProofAuthorities[0].authority,
        local: nativeAttachment,
        denial: nativeDenial,
        directAddresses: ["fdc4:f303:9324::254", "192.168.65.254"],
        directOutcomes: { "fdc4:f303:9324::254": ipv6Outcome },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("INFERENCE_SMOKE_OK PONG");
      expect(result.stdout).toContain(
        "DIRECT_REQUEST_ADDRESSES=fdc4:f303:9324::254,192.168.65.254",
      );
      expect(result.stdout).toContain("DIRECT_REQUEST_HOSTS=host.openshell.internal:8000");
    },
  );

  it("rejects a native IPv4 denial with the wrong port type after an unreachable IPv6 address", () => {
    const result = runProviderNeutralScript({
      authority: allAgentProofAuthorities[0].authority,
      local: nativeAttachment,
      denial: { ...nativeDenial, port: "8000" },
      directAddresses: ["fdc4:f303:9324::254", "192.168.65.254"],
      directOutcomes: { "fdc4:f303:9324::254": "network-unreachable" },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("policy-denial contract v2 format drifted");
    expect(result.stderr).toContain("192.168.65.254 (policy-format-drift)");
    expect(result.stdout).not.toContain("INFERENCE_SMOKE_OK");
  });

  it.each([
    ["host", "other-host.invalid"],
    ["port", 8001],
    ["port", "8000"],
    ["policy", "_provider_other_sandbox"],
    ["layer", "l4"],
    ["protocol", "http"],
    ["method", "GET"],
    ["path", "/v1/chat/completions"],
    ["rule", "POST /v1/chat/completions"],
    ["detail", "POST host.openshell.internal:8000/v1/nemoclaw-denied not permitted by policy"],
    ["host", undefined],
  ])("rejects native denial with a mismatched %s field (%s)", (field, value) => {
    const result = runProviderNeutralScript({
      authority: allAgentProofAuthorities[0].authority,
      local: nativeAttachment,
      denial: { ...nativeDenial, [field as string]: value },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("policy-denial contract v2 format drifted");
    expect(result.stdout).not.toContain("INFERENCE_SMOKE_OK");
  });

  it("rejects an upstream authentication error as a native policy denial", () => {
    const result = runProviderNeutralScript({
      authority: allAgentProofAuthorities[0].authority,
      local: nativeAttachment,
      denial: { ...nativeDenial, error: "authentication_required" },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("was not an OpenShell policy denial");
  });

  it.each([
    ["refused", "ConnectionRefusedError"],
    ["dns", "gaierror"],
    ["permission", "PermissionError"],
    ["unknown", "unknown"],
  ] as const)("reports safe native transport diagnostics for %s", (inferenceError, errorType) => {
    const result = runProviderNeutralScript({
      authority: allAgentProofAuthorities[0].authority,
      local: nativeAttachment,
      inferenceError,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `Native local inference content proof transport failed after bounded retries (type=${errorType}, errno=`,
    );
    expect(result.stderr).toMatch(/errno=(?:-?\d+|unknown)\)/);
    expect(result.stderr).not.toContain("private-credential-value");
    expect(result.stdout).toContain("INFERENCE_REQUEST_TOKENS=512,512,512");
    expect(result.stdout).toContain("SLEEP_DELAYS=5,10");
    expect(result.stdout).toContain("DIRECT_REQUEST_COUNT=0");
    expect(result.stdout).not.toContain("INFERENCE_SMOKE_OK");
  });

  const providerMetadata = (name: string): string =>
    [
      `Id: provider-${name}`,
      `Name: ${name}`,
      "Type: openai",
      "Resource version: 1",
      "Credential keys: COMPATIBLE_API_KEY",
      "Config keys: OPENAI_BASE_URL",
    ].join("\n");
  // OpenShell answers the provider metadata query, then returns one smoke result.
  const smokeRunner = (result: { status: number; stdout?: string; stderr?: string }) =>
    vi
      .fn()
      .mockImplementationOnce((args: string[]) => ({
        status: 0,
        stdout: providerMetadata(args.at(-1) ?? ""),
      }))
      .mockReturnValueOnce(result);

  it("keeps the gateway-scoped runner for ordinary onboarding smoke", async () => {
    const defaultRun = vi.fn();
    const scopedRun = vi.fn((args: string[]) => ({
      status: 0,
      stdout: providerMetadata(args.at(-1) ?? ""),
    }));
    const executor = {
      runBuffered: vi.fn(async () => ({
        outcome: { kind: "completed" as const, exitCode: 0 },
        stdout: "OPENCLAW_CONFIG_OK\nINFERENCE_SMOKE_OK PONG",
        stderr: "",
      })),
    };
    const smoke = createCompatibleEndpointSmoke(
      defaultRun,
      executor,
      (value) => value,
      () => null,
    );
    await smoke.verify(
      { sandboxName: "smoke-sandbox", provider: "compatible-endpoint", model: "baseline" },
      scopedRun,
    );
    expect(defaultRun).not.toHaveBeenCalled();
    expect(scopedRun).toHaveBeenCalledExactlyOnceWith(
      ["provider", "get", "compatible-endpoint"],
      expect.any(Object),
    );
    expect(executor.runBuffered).toHaveBeenCalledOnce();
  });

  it.each([
    { label: "missing provider", status: 1, exitCode: 0, output: "", expected: 1 },
    { label: "failed proof", status: 0, exitCode: 7, output: "", expected: 7 },
    { label: "missing proof marker", status: 0, exitCode: 0, output: "", expected: 1 },
  ])("rejects rebuilt verification without exiting for $label", async (testCase) => {
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`unexpected process.exit(${code})`);
    });
    const executor = {
      runBuffered: vi.fn(async () => ({
        outcome: { kind: "completed" as const, exitCode: testCase.exitCode },
        stdout: testCase.output,
        stderr: "",
      })),
    };
    const smoke = createCompatibleEndpointSmoke(
      () => ({ status: testCase.status, stdout: providerMetadata("compatible-endpoint") }),
      executor,
      (value) => value,
      () => null,
    );
    try {
      await expect(
        smoke.verifyRebuilt({
          sandboxName: "rebuilt-sandbox",
          provider: "compatible-endpoint",
          model: "baseline",
          environment: {},
        }),
      ).rejects.toThrow(`Compatible endpoint verification failed (exit ${testCase.expected}).`);
      expect(exit).not.toHaveBeenCalled();
      expect(executor.runBuffered).toHaveBeenCalledTimes(testCase.status === 0 ? 1 : 0);
    } finally {
      exit.mockRestore();
    }
  });

  it.each([
    { agent: { name: "hermes" as const }, provider: "compatible-endpoint" },
    { agent: { name: "openclaw" as const }, provider: "nvidia-prod" },
  ])("skips sandbox smoke for $agent.name with $provider", async ({ agent, provider }) => {
    const runOpenshell = vi.fn();

    await verifyCompatibleEndpointSandboxSmoke({
      sandboxName: "smoke-sandbox",
      provider,
      model: "nvidia/nemotron-3-ultra",
      runOpenshell,
      sandboxCommandExecutor: bufferedExecutorThrough(runOpenshell),
      redact: (value) => value,
      agent,
    });

    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("normalizes spawn output values to strings", async () => {
    expect(spawnOutputToString("already string")).toBe("already string");
    expect(spawnOutputToString(Buffer.from("buffered"))).toBe("buffered");
    expect(spawnOutputToString(null)).toBe("");
    expect(spawnOutputToString(42)).toBe("42");
  });

  it("budgets the host command timeout for every retry attempt", async () => {
    const runOpenshell = vi
      .fn()
      .mockImplementationOnce((args: string[]) => ({
        status: 0,
        stdout: providerMetadata(args.at(-1) ?? ""),
      }))
      .mockReturnValueOnce({
        status: 0,
        stdout: "OPENCLAW_CONFIG_OK\nINFERENCE_SMOKE_OK PONG",
      });

    await verifyCompatibleEndpointSandboxSmoke({
      sandboxName: "smoke-sandbox",
      provider: "compatible-endpoint",
      model: "nvidia/nemotron-3-ultra",
      runOpenshell,
      sandboxCommandExecutor: bufferedExecutorThrough(runOpenshell),
      redact: (value) => value,
      messagingChannels: ["telegram"],
    });

    expect(runOpenshell).toHaveBeenNthCalledWith(
      2,
      expect.any(Array),
      expect.objectContaining({ timeout: 225_000 }),
    );
  });

  it("fails closed on a typed sandbox transport failure", async () => {
    const runOpenshell = vi.fn().mockImplementation((args: string[]) => ({
      status: 0,
      stdout: providerMetadata(args.at(-1) ?? ""),
    }));
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    try {
      await expect(
        verifyCompatibleEndpointSandboxSmoke({
          sandboxName: "smoke-sandbox",
          provider: "compatible-endpoint",
          model: "nvidia/nemotron-3-ultra",
          runOpenshell,
          sandboxCommandExecutor: {
            runBuffered: async () => ({
              outcome: {
                kind: "failed",
                error: { kind: "timeout", message: "smoke timed out" },
              },
              stdout: "",
              stderr: "",
            }),
          },
          redact: (value) => value,
        }),
      ).rejects.toThrow("process.exit(1)");
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      exit.mockRestore();
    }
  });

  it("withholds sandbox-route success output when sandbox identity changes during proof (#9833)", async () => {
    const runOpenshell = smokeRunner({ status: 0, stdout: "INFERENCE_SMOKE_OK PONG" });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      verifyCompatibleEndpointSandboxSmoke({
        sandboxName: "smoke-sandbox",
        provider: "compatible-endpoint",
        model: "nvidia/nemotron-3-ultra",
        runOpenshell,
        sandboxCommandExecutor: bufferedExecutorThrough(runOpenshell),
        redact: (value) => value,
        messagingChannels: ["telegram"],
        beforeSuccess: () => {
          throw new Error("sandbox identity changed");
        },
      }),
    ).rejects.toThrow("sandbox identity changed");

    expect(runOpenshell).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.flat().join("\n")).not.toContain(
      "Compatible endpoint responds through inference.local",
    );
    log.mockRestore();
  });

  it.each([
    { override: undefined, requestSeconds: 180, outerMs: 1_705_000 },
    { override: "300", requestSeconds: 300, outerMs: 2_785_000 },
  ])(
    "budgets the canonical outer timeout for reasoning retry, tool proof, and direct denial with timeout override $override (#13663)",
    async ({ override, requestSeconds, outerMs }) => {
      vi.stubEnv("NEMOCLAW_LOCAL_INFERENCE_TIMEOUT", override);
      vi.resetModules();
      try {
        const { verifyCompatibleEndpointSandboxSmoke: verify } =
          await import("./compatible-endpoint-smoke");
        const runOpenshell = smokeRunner({ status: 0, stdout: "INFERENCE_SMOKE_OK PONG" });

        await verify({
          sandboxName: "managed-inference-sandbox",
          provider: "vllm-local",
          model: "qwen3.5-9b",
          runOpenshell,
          sandboxCommandExecutor: bufferedExecutorThrough(runOpenshell),
          redact: (value) => value,
          forceCanonicalRoute: true,
          hostLocalInferenceProofAuthority: {
            service: "vllm",
            directHostPort: 8000,
            directHealthPath: "/health",
            toolCallingRequired: true,
          },
        });

        expect(runOpenshell).toHaveBeenNthCalledWith(
          2,
          expect.any(Array),
          expect.objectContaining({ timeout: outerMs }),
        );
        expect(String(runOpenshell.mock.calls[1]?.[0]?.at(-1))).toContain(
          `request_timeout_seconds = ${String(requestSeconds)}`,
        );
      } finally {
        vi.unstubAllEnvs();
        vi.resetModules();
      }
    },
  );

  it.each([
    { timeoutResponse: "__timeout__", local: undefined, inferenceError: undefined },
    { timeoutResponse: "__wrapped_timeout__", local: undefined, inferenceError: undefined },
    { timeoutResponse: "__timeout__", local: nativeAttachment, inferenceError: undefined },
    { timeoutResponse: "unused", local: nativeAttachment, inferenceError: "timeout" as const },
  ])(
    "reports a $timeoutResponse inference timeout once, without a traceback (#13663)",
    ({ timeoutResponse, local, inferenceError }) => {
      const authority = allAgentProofAuthorities[0].authority;
      const result = runProviderNeutralScript({
        authority,
        responses: [timeoutResponse],
        local,
        inferenceError,
        script: buildProviderNeutralInferenceSandboxSmokeScript(
          "qwen3.5-9b",
          authority,
          local,
          300,
        ),
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "content proof timed out after 300 seconds without a response",
      );
      expect(result.stderr).toContain("raise NEMOCLAW_LOCAL_INFERENCE_TIMEOUT");
      expect(result.stderr).toContain("retry the failed operation");
      expect(result.stderr).not.toContain("resume onboarding");
      expect(result.stderr).not.toContain("Traceback");
      expect(result.stderr).not.toContain("private-credential-value");
      expect(result.stdout).toContain("DIRECT_REQUEST_COUNT=0");
      expect(result.stdout).not.toContain("INFERENCE_SMOKE_OK");
      expect(result.stdout).toContain("INFERENCE_REQUEST_TOKENS=512\n");
      expect(result.stdout).toContain("SLEEP_DELAYS=\n");
    },
  );

  it.each([
    {
      label: "provider-neutral",
      forceCanonicalRoute: true,
      provider: "vllm-local",
      messagingChannels: [] as string[],
      expected: ["Provider-neutral inference provider", "inference.local route cannot reach"],
      unexpected: "Telegram",
    },
    {
      label: "compatible-endpoint messaging",
      forceCanonicalRoute: false,
      provider: "compatible-endpoint",
      messagingChannels: ["telegram"],
      expected: ["Compatible endpoint provider", "inference.local route cannot reach"],
      unexpected: "Telegram",
    },
    {
      label: "compatible-endpoint without messaging",
      forceCanonicalRoute: false,
      provider: "compatible-endpoint",
      messagingChannels: [] as string[],
      expected: ["Compatible endpoint provider", "inference.local route cannot reach"],
      unexpected: "Telegram",
    },
  ])("reports mode-accurate $label provider lookup failures", async (testCase) => {
    const errors: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation((message) => {
      errors.push(String(message));
    });
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    const runOpenshell = vi.fn().mockReturnValue({
      status: 1,
      stderr: "provider query failed",
    });

    try {
      await expect(
        verifyCompatibleEndpointSandboxSmoke({
          sandboxName: "provider-lookup-failure-sandbox",
          provider: testCase.provider,
          model: "qwen3.5-9b",
          runOpenshell,
          sandboxCommandExecutor: bufferedExecutorThrough(runOpenshell),
          redact: (value) => value,
          messagingChannels: testCase.messagingChannels,
          forceCanonicalRoute: testCase.forceCanonicalRoute,
        }),
      ).rejects.toThrow("process.exit(1)");

      const diagnostics = errors.join("\n");
      expect(diagnostics).toContain(testCase.expected[0]);
      expect(diagnostics).toContain(testCase.expected[1]);
      expect(diagnostics).not.toContain(testCase.unexpected);
      expect(diagnostics).toContain("OpenShell could not inspect the provider");
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });

  it.each([
    { label: "none", messagingChannels: [] as string[], stderr: "curl exit 7" },
    { label: "Telegram", messagingChannels: ["telegram"], stderr: "curl exit 7" },
    {
      label: "long-output",
      messagingChannels: [] as string[],
      stderr: `${"x".repeat(2000)} curl exit 7`,
    },
  ])(
    "reports a channel-agnostic sandbox smoke failure for $label messaging (#10405)",
    async ({ messagingChannels, stderr }) => {
      const errors: string[] = [];
      const error = vi.spyOn(console, "error").mockImplementation((message) => {
        errors.push(String(message));
      });
      const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
        throw new Error(`process.exit(${code})`);
      });
      const runOpenshell = smokeRunner({ status: 1, stderr });

      try {
        await expect(
          verifyCompatibleEndpointSandboxSmoke({
            sandboxName: "no-messaging-sandbox",
            provider: "compatible-endpoint",
            model: "issue-10405-model",
            runOpenshell,
            sandboxCommandExecutor: bufferedExecutorThrough(runOpenshell),
            redact: (value) => value,
            messagingChannels,
          }),
        ).rejects.toThrow("process.exit(1)");

        expect(runOpenshell).toHaveBeenCalledTimes(2);
        const diagnostics = errors.join("\n");
        expect(diagnostics).toContain("Compatible endpoint sandbox smoke check failed");
        expect(diagnostics).toContain(
          "Messaging setup is not the root cause; the sandbox inference.local route failed.",
        );
        expect(diagnostics).toContain("curl exit 7");
        expect(diagnostics).not.toContain("Telegram");
      } finally {
        exit.mockRestore();
        error.mockRestore();
      }
    },
  );

  it.each(providerNeutralCases)(
    "runs a real provider-neutral $service request inside the $agentName sandbox",
    async ({ agentName, service, provider, port, directHealthPath }) => {
      const runOpenshell = smokeRunner({ status: 0, stdout: "INFERENCE_SMOKE_OK PONG" });

      await verifyCompatibleEndpointSandboxSmoke({
        sandboxName: `${agentName}-sandbox`,
        provider,
        model: "qwen3.5-9b",
        endpointUrl: "https://inference.local/v1",
        runOpenshell,
        sandboxCommandExecutor: bufferedExecutorThrough(runOpenshell),
        redact: (value) => value,
        messagingChannels: [],
        agent: { name: agentName },
        forceCanonicalRoute: true,
        hostLocalInferenceProofAuthority: {
          service,
          directHostPort: port,
          directHealthPath,
          toolCallingRequired: true,
        },
      });

      expect(runOpenshell).toHaveBeenNthCalledWith(
        1,
        ["provider", "get", provider],
        expect.objectContaining({ ignoreError: true }),
      );
      const sandboxCommand = runOpenshell.mock.calls[1]?.[0] as string[];
      expect(sandboxCommand.slice(0, 7)).toEqual([
        "sandbox",
        "exec",
        "-n",
        `${agentName}-sandbox`,
        "--",
        "python3",
        "-c",
      ]);
      expect(sandboxCommand[7]).toContain("opener.open");
      expect(sandboxCommand[7]).toContain("https://inference.local/v1/chat/completions");
      expect(sandboxCommand[7]).toContain('"content": "Reply with exactly: PONG"');
      expect(sandboxCommand[7]).toContain(
        `host.openshell.internal:${String(port)}/v1/chat/completions`,
      );
      expect(sandboxCommand[7]).toContain('direct_method = "POST"');
      expect(sandboxCommand[7]).toContain('response_data.get("model") != model');
      expect(sandboxCommand[7]).toContain('"tool_choice"');
      expect(sandboxCommand[7]).toContain('direct_denial_error = "policy_denied"');
      expect(sandboxCommand[7]).toContain('denial.get("error") != direct_denial_error');
      expect(sandboxCommand[7]).not.toContain("curl");
    },
  );

  it("fails closed when the provider-neutral sandbox request or direct-host deny proof fails", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    const runOpenshell = smokeRunner({
      status: 1,
      stderr: "direct host inference deny could not be proven",
    });

    await expect(
      verifyCompatibleEndpointSandboxSmoke({
        sandboxName: "hermes-sandbox",
        provider: "ollama-local",
        model: "qwen3.5-9b",
        runOpenshell,
        sandboxCommandExecutor: bufferedExecutorThrough(runOpenshell),
        redact: (value) => value,
        agent: { name: "hermes" },
        forceCanonicalRoute: true,
        hostLocalInferenceProofAuthority: {
          service: "ollama",
          directHostPort: 11434,
          directHealthPath: "/api/tags",
          toolCallingRequired: true,
        },
      }),
    ).rejects.toThrow("process.exit(1)");

    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();
  });

  it("builds a sandbox script that checks managed provider routing", async () => {
    const script = buildCompatibleEndpointSandboxSmokeScript("provider/model'");

    expect(script).toContain("OPENCLAW_CONFIG_OK");
    expect(script).toContain("INFERENCE_SMOKE_OK");
    expect(script).toContain("models.providers.inference");
    expect(script).toContain("https://inference.local/v1/chat/completions");
    expect(script).toContain("INITIAL_MAX_TOKENS=512");
    expect(script).toContain("RETRY_MAX_TOKENS=1024");
    expect(script).toContain("SMOKE_ATTEMPTS=3");
    expect(script).toContain("SMOKE_REQUEST_TIMEOUT_SECONDS=60");
    expect(script).toContain("SMOKE_RETRY_DELAY_SECONDS=5");
    expect(script).toContain("MODEL='provider/model'\\'''");
    expect(script).not.toContain("VALIDATE_OPENCLAW_CONFIG");
  });

  it("builds a Python-only provider-neutral route allow and direct-host deny proof", async () => {
    const script = buildProviderNeutralInferenceSandboxSmokeScript("qwen3.5-9b", {
      service: "nim",
      directHostPort: 8001,
      directHealthPath: "/v1/health/ready",
      toolCallingRequired: true,
    });

    expect(script).toContain("https://inference.local/v1/chat/completions");
    expect(script).toContain("INFERENCE_SMOKE_OK");
    expect(script).toContain('denial.get("error") != direct_denial_error');
    expect(script).toContain("host.openshell.internal:8001/v1/chat/completions");
    expect(script).toContain('direct_method = "POST"');
    expect(script).toContain("max_tokens_field: 1");
    expect(script).toContain('response_data.get("model") != model');
    expect(script).toContain('"tool_choice"');
    expect(script).toContain("direct_denial_contract_version = 1");
    expect(script).toContain('direct_denial_error = "policy_denied"');
    expect(script).toContain('denial_bytes.decode("utf-8", errors="strict")');
    expect(script).toContain("direct_deny_timeout_seconds = 10");
    expect(script).not.toContain("curl");
  });

  it.each(allAgentProofAuthorities)(
    "executes exact model, required tool, and policy-deny proof for $agentName",
    ({ authority }) => {
      const result = runProviderNeutralScript({ authority });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("INFERENCE_SMOKE_OK PONG");
      expect(result.stdout).toContain("INFERENCE_REQUEST_TOKENS=512,512");
      expect(result.stdout).toContain("DIRECT_REQUEST_COUNT=1");
      expect(result.stdout).toContain(
        `DIRECT_REQUEST_HOSTS=host.openshell.internal:${String(authority.directHostPort)}`,
      );
    },
  );

  it("retries reasoning-only content through the public sandbox verification path", async () => {
    const authority = allAgentProofAuthorities[0].authority;
    const model = "qwen3-vl:4b";
    const responses = [
      {
        model,
        choices: [
          {
            finish_reason: "length",
            message: { content: "", reasoning_content: "Planning the response." },
          },
        ],
      },
      { model, choices: [{ message: { content: "PONG" } }] },
      providerNeutralResponses(model)[1],
    ];
    let result: ReturnType<typeof runProviderNeutralScript> | undefined;
    const runOpenshell = vi
      .fn()
      .mockImplementationOnce((args: string[]) => ({
        status: 0,
        stdout: providerMetadata(args.at(-1) ?? ""),
      }))
      .mockImplementationOnce((args: string[]) => {
        result = runProviderNeutralScript({
          authority,
          model,
          responses,
          script: String(args.at(-1)),
        });
        return result;
      });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await verifyCompatibleEndpointSandboxSmoke({
        sandboxName: "managed-inference-sandbox",
        provider: "ollama-local",
        model,
        runOpenshell,
        sandboxCommandExecutor: bufferedExecutorThrough(runOpenshell),
        redact: (value) => value,
        forceCanonicalRoute: true,
        hostLocalInferenceProofAuthority: authority,
      });

      expect(result?.status, result?.stderr).toBe(0);
      expect(result?.stderr).toContain("REASONING_ONLY at the initial token limit");
      expect(result?.stdout).toContain("INFERENCE_REQUEST_TOKENS=512,1024,512");
      expect(result?.stdout).toContain("DIRECT_REQUEST_COUNT=1");
      expect(log.mock.calls.flat().join("\n")).toContain(
        "Provider responds through inference.local inside the sandbox",
      );
    } finally {
      log.mockRestore();
    }
  });

  it("routes managed inference through the runtime proxy and bypasses it for direct denial (#10423)", async () => {
    const authority = allAgentProofAuthorities[0].authority;
    const result = runProviderNeutralScript({
      authority,
      managedProxyResponses: providerNeutralResponses("qwen3.5-9b"),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("INFERENCE_SMOKE_OK PONG");
    expect(result.stdout).toContain("MANAGED_PROXY_REQUEST_COUNT=2");
    expect(result.stdout).toContain(
      "MANAGED_PROXY_REQUEST_URLS=https://inference.local/v1/chat/completions,https://inference.local/v1/chat/completions",
    );
    expect(result.stdout).toContain("INFERENCE_REQUEST_TOKENS=512,512");
    expect(result.stdout).toContain("DIRECT_REQUEST_COUNT=1");
  });

  it("does not fall back to direct DNS when the managed runtime proxy is unavailable (#10423)", async () => {
    const result = runProviderNeutralScript({
      authority: allAgentProofAuthorities[0].authority,
      managedProxyResponses: [],
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "inference.local content proof transport failed after bounded retries",
    );
    expect(result.stdout).toContain("MANAGED_PROXY_REQUEST_COUNT=3");
    expect(result.stdout).toContain("INFERENCE_REQUEST_TOKENS=");
    expect(result.stdout).toContain("DIRECT_REQUEST_COUNT=0");
    expect(result.stdout).toContain("SLEEP_DELAYS=5,10");
  });

  it("executes the provider-neutral proof for receipt-owned llama.cpp authority (#10423)", async () => {
    const result = runProviderNeutralScript({
      authority: {
        service: "llama-cpp",
        directHostPort: 18_080,
        directHealthPath: "/health",
        toolCallingRequired: true,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("INFERENCE_SMOKE_OK PONG");
    expect(result.stdout).toContain("INFERENCE_REQUEST_TOKENS=512,512");
    expect(result.stdout).toContain("DIRECT_REQUEST_COUNT=1");
    expect(result.stdout).toContain(
      "DIRECT_REQUEST_URLS=http://host.openshell.internal:18080/v1/chat/completions",
    );
  });

  it("fails after one larger-budget attempt when output remains reasoning-only", async () => {
    const reasoningOnly = {
      model: "qwen3.5-9b",
      choices: [
        {
          finish_reason: "length",
          message: { content: null, reasoning_content: "Still planning. SECRET_CANARY" },
        },
      ],
    };
    const result = runProviderNeutralScript({
      authority: allAgentProofAuthorities[0].authority,
      responses: [reasoningOnly, reasoningOnly],
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("content proof failed: REASONING_ONLY");
    expect(result.stderr).not.toContain("SECRET_CANARY");
    expect(result.stdout).toContain("INFERENCE_REQUEST_TOKENS=512,1024");
    expect(result.stdout).toContain("DIRECT_REQUEST_COUNT=0");
  });

  it.each([
    {
      shape: "CHOICES_MISSING",
      response: { model: "qwen3.5-9b", choices: [] },
    },
    {
      shape: "MESSAGE_MISSING",
      response: { model: "qwen3.5-9b", choices: [{ finish_reason: "stop" }] },
    },
    {
      shape: "REASONING_ONLY",
      response: {
        model: "qwen3.5-9b",
        choices: [{ finish_reason: "stop", message: { reasoning: "Planning." } }],
      },
    },
    {
      shape: "TOOL_CALL_ONLY",
      response: {
        model: "qwen3.5-9b",
        choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{}] } }],
      },
    },
    {
      shape: "EMPTY_LENGTH",
      response: {
        model: "qwen3.5-9b",
        choices: [{ finish_reason: "length", message: { content: "" } }],
      },
    },
    {
      shape: "EMPTY_OTHER",
      response: {
        model: "qwen3.5-9b",
        choices: [{ finish_reason: "stop", message: { content: " " } }],
      },
    },
  ])(
    "reports fixed $shape content-shape evidence without running later proofs",
    ({ shape, response }) => {
      const result = runProviderNeutralScript({
        authority: allAgentProofAuthorities[0].authority,
        responses: [response],
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`content proof failed: ${shape}`);
      expect(result.stdout).toContain("INFERENCE_REQUEST_TOKENS=512");
      expect(result.stdout).toContain("DIRECT_REQUEST_COUNT=0");
    },
  );

  it.each(allAgentProofAuthorities)(
    "accepts refused direct access after authorized inference for $agentName (#9211)",
    ({ authority }) => {
      const result = runProviderNeutralScript({ authority, directError: "connection-refused" });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("INFERENCE_SMOKE_OK PONG");
    },
  );

  it.each(["network-unreachable", "host-unreachable"] as const)(
    "checks IPv4 after a %s IPv6 host bridge (#13518)",
    (ipv6Outcome) => {
      const result = runProviderNeutralScript({
        authority: allAgentProofAuthorities[0].authority,
        directAddresses: ["fdc4:f303:9324::254", "192.168.65.254"],
        directOutcomes: {
          "fdc4:f303:9324::254": ipv6Outcome,
          "192.168.65.254": "connection-refused",
        },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("INFERENCE_SMOKE_OK PONG");
      expect(result.stdout).toContain(
        "DIRECT_REQUEST_ADDRESSES=fdc4:f303:9324::254,192.168.65.254",
      );
    },
  );

  it("rejects a reachable IPv4 route after an unreachable IPv6 host bridge (#13518)", () => {
    const result = runProviderNeutralScript({
      authority: allAgentProofAuthorities[0].authority,
      directAddresses: ["fdc4:f303:9324::254", "192.168.65.254"],
      directOutcomes: {
        "fdc4:f303:9324::254": "network-unreachable",
        "192.168.65.254": "http-200",
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "direct host inference response was not an OpenShell policy denial",
    );
    expect(result.stderr).toContain("fdc4:f303:9324::254 (network-unreachable)");
    expect(result.stderr).toContain("192.168.65.254 (unexpected-response)");
    expect(result.stdout).toContain("DIRECT_REQUEST_ADDRESSES=fdc4:f303:9324::254,192.168.65.254");
  });

  it("checks every resolved address after a valid policy denial (#13518)", () => {
    const result = runProviderNeutralScript({
      authority: allAgentProofAuthorities[0].authority,
      directAddresses: ["fdc4:f303:9324::254", "192.168.65.254"],
      directOutcomes: { "192.168.65.254": "http-200" },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "direct host inference response was not an OpenShell policy denial",
    );
    expect(result.stderr).toContain("fdc4:f303:9324::254 (policy-denied)");
    expect(result.stderr).toContain("192.168.65.254 (unexpected-response)");
    expect(result.stdout).toContain("DIRECT_REQUEST_ADDRESSES=fdc4:f303:9324::254,192.168.65.254");
  });

  it("keeps direct failure diagnostics bounded and names the failing address", () => {
    const directAddresses = Array.from({ length: 10 }, (_, index) => `192.0.2.${index + 1}`);
    const directOutcomes: Record<string, "network-unreachable" | "http-200"> = Object.fromEntries(
      directAddresses.map((address) => [address, "network-unreachable"]),
    );
    directOutcomes["192.0.2.10"] = "http-200";
    const result = runProviderNeutralScript({
      authority: allAgentProofAuthorities[0].authority,
      directAddresses,
      directOutcomes,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("192.0.2.1 (network-unreachable)");
    expect(result.stderr).toContain("192.0.2.10 (unexpected-response)");
    expect(result.stderr).toContain("2 earlier outcomes omitted");
    expect(result.stderr).not.toContain("192.0.2.8 (");
    expect(result.stderr.length).toBeLessThan(600);
  });

  it.each(["dns", "timeout"] as const)(
    "does not accept a %s transport error as a direct-host deny proof (#9211)",
    (directError) => {
      const result = runProviderNeutralScript({
        authority: allAgentProofAuthorities[0].authority,
        directError,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("direct host inference deny could not be proven");
    },
  );

  it.each(allAgentProofAuthorities)(
    "rejects a cross-wired response model for $agentName",
    ({ authority }) => {
      const result = runProviderNeutralScript({
        authority,
        responses: providerNeutralResponses("other-provider/model"),
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("returned a different model identity");
    },
  );

  it.each(allAgentProofAuthorities)(
    "rejects a missing required tool call for $agentName",
    ({ authority }) => {
      const result = runProviderNeutralScript({
        authority,
        responses: providerNeutralResponses("qwen3.5-9b", false),
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("did not return the required tool call");
    },
  );

  it.each(allAgentProofAuthorities)(
    "accepts semantic empty tool arguments for $agentName",
    ({ authority }) => {
      const result = runProviderNeutralScript({
        authority,
        responses: providerNeutralResponses("qwen3.5-9b", true, " { } "),
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("INFERENCE_SMOKE_OK PONG");
    },
  );

  it.each(
    allAgentProofAuthorities.flatMap(({ agentName, authority }) =>
      (["{", "[]", "null", '{"unexpected":true}'] as const).map((toolArguments) => ({
        agentName,
        authority,
        toolArguments,
      })),
    ),
  )(
    "rejects invalid semantic tool arguments $toolArguments for $agentName",
    ({ authority, toolArguments }) => {
      const result = runProviderNeutralScript({
        authority,
        responses: providerNeutralResponses("qwen3.5-9b", true, toolArguments),
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("returned invalid tool arguments");
    },
  );

  it("accepts a content-only proof when durable authority marks tool calling optional", async () => {
    const authority = {
      ...allAgentProofAuthorities[0].authority,
      toolCallingRequired: false,
    };
    const result = runProviderNeutralScript({
      authority,
      responses: [{ model: "qwen3.5-9b", choices: [{ message: { content: "PONG" } }] }],
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("INFERENCE_SMOKE_OK PONG");
  });

  it("rejects service-specific direct-host authority drift before sandbox execution", async () => {
    expect(() =>
      buildProviderNeutralInferenceSandboxSmokeScript("qwen3.5-9b", {
        service: "nim",
        directHostPort: 8001,
        directHealthPath: "/health",
        toolCallingRequired: true,
      }),
    ).toThrow("exact provider health authority");
  });

  it("rejects an oversized provider-neutral inference response before JSON parsing", async () => {
    const result = runProviderNeutralScript({
      authority: allAgentProofAuthorities[0].authority,
      responses: [{ __oversized__: true }],
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("response exceeded byte limit");
  });

  it("does not mistake a reachable provider's own HTTP 403 for policy denial", async () => {
    const authority = allAgentProofAuthorities[2].authority;
    const result = runProviderNeutralScript({
      authority,
      denial: { error: "authentication_required", detail: "missing provider API key" },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("was not an OpenShell policy denial");
  });

  it("accepts an exact OpenShell denial with guidance beyond the old 4096-byte window", async () => {
    const authority = allAgentProofAuthorities[2].authority;
    const directAuthority = `host.openshell.internal:${String(authority.directHostPort)}`;
    const result = runProviderNeutralScript({
      authority,
      denial: {
        error: "policy_denied",
        detail: `POST ${directAuthority}/v1/chat/completions not permitted by policy`,
        agent_guidance: "x".repeat(8192),
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("INFERENCE_SMOKE_OK PONG");
  });

  it("rejects an oversized OpenShell policy-denial body before parsing", async () => {
    const result = runProviderNeutralScript({
      authority: allAgentProofAuthorities[2].authority,
      denialOversized: true,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("policy-denial response exceeded byte limit");
  });

  it("reports malformed OpenShell policy-denial JSON separately", async () => {
    const result = runProviderNeutralScript({
      authority: allAgentProofAuthorities[2].authority,
      denialBytes: Array.from(Buffer.from('{"error":', "utf8")),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("policy-denial response was not valid JSON");
  });

  it("reports invalid UTF-8 in an OpenShell policy-denial body separately", async () => {
    const result = runProviderNeutralScript({
      authority: allAgentProofAuthorities[2].authority,
      denialBytes: [0xff],
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("policy-denial response was not valid UTF-8");
  });

  it("reports OpenShell policy-denial contract format drift separately", async () => {
    const authority = allAgentProofAuthorities[2].authority;
    const result = runProviderNeutralScript({
      authority,
      denial: {
        error: "policy_denied",
        detail: "POST host.openshell.internal:8000/v1/chat/completions denied by policy",
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("OpenShell policy-denial contract v1 format drifted");
    expect(result.stderr).not.toContain("was not an OpenShell policy denial");
  });
});
