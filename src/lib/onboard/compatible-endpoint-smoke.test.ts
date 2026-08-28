// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  runSmokeScript,
  writeFakeCurl,
  writeFakeSleep,
  writeSmokeConfig,
} from "./__test-helpers__/compatible-endpoint-smoke-helpers";

vi.mock("../inference/config", () => ({
  INFERENCE_ROUTE_URL: "https://inference.local/v1",
  MANAGED_PROVIDER_ID: "inference",
}));

import {
  buildCompatibleEndpointSandboxSmokeCommand,
  buildCompatibleEndpointSandboxSmokeScript,
  buildProviderNeutralInferenceSandboxSmokeScript,
  spawnOutputToString,
  verifyCompatibleEndpointSandboxSmoke,
} from "./compatible-endpoint-smoke";

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

type ProviderNeutralAuthority = NonNullable<
  Parameters<typeof buildProviderNeutralInferenceSandboxSmokeScript>[1]
>;

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

function providerNeutralResponses(
  model: string,
  includeToolCall = true,
  toolArguments: unknown = "{}",
): unknown[] {
  return [
    { model, choices: [{ message: { content: "PONG" } }] },
    {
      model,
      choices: [
        {
          message: {
            tool_calls: includeToolCall
              ? [
                  {
                    function: {
                      name: "nemoclaw_route_probe",
                      arguments: toolArguments,
                    },
                  },
                ]
              : [],
          },
        },
      ],
    },
  ];
}

function runProviderNeutralScript(options: {
  authority: ProviderNeutralAuthority;
  model?: string;
  script?: string;
  responses?: unknown[];
  denial?: unknown;
  denialBytes?: readonly number[];
  denialOversized?: boolean;
  directError?: "connection-refused" | "dns" | "timeout";
  managedProxyResponses?: unknown[];
}) {
  const model = options.model ?? "qwen3.5-9b";
  const directAuthority = `host.openshell.internal:${String(options.authority.directHostPort)}`;
  const responses = options.responses ?? providerNeutralResponses(model);
  const denial =
    options.denial ??
    ({
      error: "policy_denied",
      detail: `POST ${directAuthority}/v1/chat/completions not permitted by policy`,
    } satisfies Record<string, string>);
  const denialBytes =
    options.denialBytes ?? Array.from(Buffer.from(JSON.stringify(denial), "utf8"));
  const denialBody = options.denialOversized
    ? 'b"x" * 1048577'
    : `bytes(${JSON.stringify(denialBytes)})`;
  const prelude = `
import atexit
import errno
import io
import json
import socket
import time
import urllib.error
import urllib.request

responses = json.loads(${JSON.stringify(JSON.stringify(responses))})
managed_proxy_responses = json.loads(${JSON.stringify(
    JSON.stringify(options.managedProxyResponses ?? []),
  )})
managed_proxy_enabled = ${options.managedProxyResponses === undefined ? "False" : "True"}
denial_bytes = ${denialBody}
inference_request_tokens = []
direct_request_count = []
direct_request_urls = []
managed_proxy_request_count = []
managed_proxy_request_urls = []
sleep_delays = []
direct_error = ${options.directError === undefined ? "None" : JSON.stringify(options.directError)}

def emit_request_evidence():
    print("INFERENCE_REQUEST_TOKENS=" + ",".join(str(value) for value in inference_request_tokens))
    print("DIRECT_REQUEST_COUNT=" + str(len(direct_request_count)))
    print("DIRECT_REQUEST_URLS=" + ",".join(direct_request_urls))
    print("MANAGED_PROXY_REQUEST_COUNT=" + str(len(managed_proxy_request_count)))
    print("MANAGED_PROXY_REQUEST_URLS=" + ",".join(managed_proxy_request_urls))
    print("SLEEP_DELAYS=" + ",".join(str(value) for value in sleep_delays))

atexit.register(emit_request_evidence)

class FakeResponse:
    def __init__(self, status, payload):
        self.status = status
        self.payload_source = payload
        self.payload = json.dumps(payload).encode("utf-8")
    def __enter__(self):
        return self
    def __exit__(self, exc_type, exc, traceback):
        return False
    def read(self, size=-1):
        if isinstance(self.payload_source, dict) and self.payload_source.get("__oversized__") is True:
            return b"x" * (size if size >= 0 else 1048577)
        return self.payload if size < 0 else self.payload[:size]

class FakeOpener:
    def open(self, request, timeout):
        if request.full_url.startswith("https://inference.local/"):
            if not responses:
                raise RuntimeError("test response queue exhausted")
            request_data = json.loads(request.data.decode("utf-8"))
            inference_request_tokens.append(
                request_data.get("max_tokens", request_data.get("max_completion_tokens"))
            )
            return FakeResponse(200, responses.pop(0))
        direct_request_count.append(1)
        direct_request_urls.append(request.full_url)
        if direct_error == "connection-refused":
            raise urllib.error.URLError(ConnectionRefusedError(errno.ECONNREFUSED, "refused"))
        if direct_error == "dns":
            raise urllib.error.URLError(socket.gaierror(socket.EAI_NONAME, "not known"))
        if direct_error == "timeout":
            raise urllib.error.URLError(TimeoutError("timed out"))
        raise urllib.error.HTTPError(
            request.full_url,
            403,
            "Forbidden",
            {},
            io.BytesIO(denial_bytes),
        )

class ManagedProxyOpener:
    def open(self, request, timeout):
        managed_proxy_request_count.append(1)
        managed_proxy_request_urls.append(request.full_url)
        if not managed_proxy_responses:
            raise urllib.error.URLError(ConnectionRefusedError(errno.ECONNREFUSED, "refused"))
        request_data = json.loads(request.data.decode("utf-8"))
        inference_request_tokens.append(
            request_data.get("max_tokens", request_data.get("max_completion_tokens"))
        )
        return FakeResponse(200, managed_proxy_responses.pop(0))

def build_test_opener(*handlers):
    proxy_disabled = any(
        isinstance(handler, urllib.request.ProxyHandler) and handler.proxies == {}
        for handler in handlers
    )
    if managed_proxy_enabled and not proxy_disabled:
        return ManagedProxyOpener()
    return FakeOpener()

urllib.request.build_opener = build_test_opener
time.sleep = lambda seconds: sleep_delays.append(seconds)
`;
  const script =
    options.script ?? buildProviderNeutralInferenceSandboxSmokeScript(model, options.authority);
  return spawnSync("python3", ["-c", `${prelude}\n${script}`], {
    encoding: "utf8",
    env:
      options.managedProxyResponses === undefined
        ? process.env
        : {
            ...process.env,
            HTTPS_PROXY: "http://openshell-runtime-proxy.invalid:8080",
            NO_PROXY: "",
          },
  });
}

describe("compatible endpoint sandbox smoke helpers", () => {
  it.each([
    { agent: { name: "hermes" as const }, provider: "compatible-endpoint" },
    { agent: { name: "openclaw" as const }, provider: "nvidia-prod" },
  ])("skips sandbox smoke for $agent.name with $provider", ({ agent, provider }) => {
    const runOpenshell = vi.fn();

    verifyCompatibleEndpointSandboxSmoke({
      sandboxName: "smoke-sandbox",
      provider,
      model: "nvidia/nemotron-3-ultra",
      runOpenshell,
      redact: (value) => value,
      agent,
    });

    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("normalizes spawn output values to strings", () => {
    expect(spawnOutputToString("already string")).toBe("already string");
    expect(spawnOutputToString(Buffer.from("buffered"))).toBe("buffered");
    expect(spawnOutputToString(null)).toBe("");
    expect(spawnOutputToString(42)).toBe("42");
  });

  it("budgets the host command timeout for every retry attempt", () => {
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: "provider ready" })
      .mockReturnValueOnce({
        status: 0,
        stdout: "OPENCLAW_CONFIG_OK\nINFERENCE_SMOKE_OK PONG",
      });

    verifyCompatibleEndpointSandboxSmoke({
      sandboxName: "smoke-sandbox",
      provider: "compatible-endpoint",
      model: "nvidia/nemotron-3-ultra",
      runOpenshell,
      redact: (value) => value,
      messagingChannels: ["telegram"],
    });

    expect(runOpenshell).toHaveBeenNthCalledWith(
      2,
      expect.any(Array),
      expect.objectContaining({ timeout: 225_000 }),
    );
  });

  it("withholds sandbox-route success output when policy authority changes during proof (#9833)", () => {
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: "provider ready" })
      .mockReturnValueOnce({ status: 0, stdout: "INFERENCE_SMOKE_OK PONG" });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(() =>
      verifyCompatibleEndpointSandboxSmoke({
        sandboxName: "smoke-sandbox",
        provider: "compatible-endpoint",
        model: "nvidia/nemotron-3-ultra",
        runOpenshell,
        redact: (value) => value,
        messagingChannels: ["telegram"],
        beforeSuccess: () => {
          throw new Error("policy authority changed");
        },
      }),
    ).toThrow("policy authority changed");

    expect(runOpenshell).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.flat().join("\n")).not.toContain(
      "Compatible endpoint responds through inference.local",
    );
    log.mockRestore();
  });

  it("budgets the canonical outer timeout for reasoning retry, tool proof, and direct denial", () => {
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: "provider ready" })
      .mockReturnValueOnce({ status: 0, stdout: "INFERENCE_SMOKE_OK PONG" });

    verifyCompatibleEndpointSandboxSmoke({
      sandboxName: "managed-inference-sandbox",
      provider: "vllm-local",
      model: "qwen3.5-9b",
      runOpenshell,
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
      expect.objectContaining({ timeout: 625_000 }),
    );
  });

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
  ])("reports mode-accurate $label provider lookup failures", (testCase) => {
    const errors: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation((message) => {
      errors.push(String(message));
    });
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    try {
      expect(() =>
        verifyCompatibleEndpointSandboxSmoke({
          sandboxName: "provider-lookup-failure-sandbox",
          provider: testCase.provider,
          model: "qwen3.5-9b",
          runOpenshell: vi.fn().mockReturnValue({ status: 1, stderr: "provider query failed" }),
          redact: (value) => value,
          messagingChannels: testCase.messagingChannels,
          forceCanonicalRoute: testCase.forceCanonicalRoute,
        }),
      ).toThrow("process.exit(1)");

      const diagnostics = errors.join("\n");
      expect(diagnostics).toContain(testCase.expected[0]);
      expect(diagnostics).toContain(testCase.expected[1]);
      expect(diagnostics).not.toContain(testCase.unexpected);
      expect(diagnostics).toContain("provider query failed");
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });

  it.each([
    { label: "none", messagingChannels: [] as string[] },
    { label: "Telegram", messagingChannels: ["telegram"] },
  ])(
    "reports a channel-agnostic sandbox smoke failure for $label messaging (#10405)",
    ({ messagingChannels }) => {
    const errors: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation((message) => {
      errors.push(String(message));
    });
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: "provider ready" })
      .mockReturnValueOnce({ status: 1, stderr: "curl exit 7" });

    try {
      expect(() =>
        verifyCompatibleEndpointSandboxSmoke({
          sandboxName: "no-messaging-sandbox",
          provider: "compatible-endpoint",
          model: "issue-10405-model",
          runOpenshell,
          redact: (value) => value,
          messagingChannels,
        }),
      ).toThrow("process.exit(1)");

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
    ({ agentName, service, provider, port, directHealthPath }) => {
      const runOpenshell = vi
        .fn()
        .mockReturnValueOnce({ status: 0, stdout: "provider ready" })
        .mockReturnValueOnce({ status: 0, stdout: "INFERENCE_SMOKE_OK PONG" });

      verifyCompatibleEndpointSandboxSmoke({
        sandboxName: `${agentName}-sandbox`,
        provider,
        model: "qwen3.5-9b",
        endpointUrl: "https://inference.local/v1",
        runOpenshell,
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
      expect(sandboxCommand[7]).toContain("method=direct_method");
      expect(sandboxCommand[7]).toContain('response_data.get("model") != model');
      expect(sandboxCommand[7]).toContain('"tool_choice"');
      expect(sandboxCommand[7]).toContain('direct_denial_error = "policy_denied"');
      expect(sandboxCommand[7]).toContain('denial.get("error") != direct_denial_error');
      expect(sandboxCommand[7]).toContain("ProxyHandler({})");
      expect(sandboxCommand[7]).not.toContain("curl");
    },
  );

  it("fails closed when the provider-neutral sandbox request or direct-host deny proof fails", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: "provider ready" })
      .mockReturnValueOnce({ status: 1, stderr: "direct host inference deny could not be proven" });

    expect(() =>
      verifyCompatibleEndpointSandboxSmoke({
        sandboxName: "hermes-sandbox",
        provider: "ollama-local",
        model: "qwen3.5-9b",
        runOpenshell,
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
    ).toThrow("process.exit(1)");

    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();
  });

  it("builds a sandbox script that checks managed provider routing", () => {
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

  it("builds a Python-only provider-neutral route allow and direct-host deny proof", () => {
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
    expect(script).toContain("method=direct_method");
    expect(script).toContain("max_tokens_field: 1");
    expect(script).toContain('response_data.get("model") != model');
    expect(script).toContain('"tool_choice"');
    expect(script).toContain("direct_denial_contract_version = 1");
    expect(script).toContain('direct_denial_error = "policy_denied"');
    expect(script).toContain("error.read(max_response_bytes + 1)");
    expect(script).toContain('denial_bytes.decode("utf-8", errors="strict")');
    expect(script).toContain("direct_deny_timeout_seconds = 10");
    expect(script).toContain("ProxyHandler({})");
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
    },
  );

  it("retries reasoning-only content through the public sandbox verification path", () => {
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
      .mockReturnValueOnce({ status: 0, stdout: "provider ready" })
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
      verifyCompatibleEndpointSandboxSmoke({
        sandboxName: "managed-inference-sandbox",
        provider: "ollama-local",
        model,
        runOpenshell,
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

  it("routes managed inference through the runtime proxy and bypasses it for direct denial (#10423)", () => {
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

  it("does not fall back to direct DNS when the managed runtime proxy is unavailable (#10423)", () => {
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

  it("executes the provider-neutral proof for receipt-owned llama.cpp authority (#10423)", () => {
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

  it("fails after one larger-budget attempt when output remains reasoning-only", () => {
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
    "accepts exact connection refusal as a direct-host deny proof for $agentName (#9211)",
    ({ authority }) => {
      const result = runProviderNeutralScript({ authority, directError: "connection-refused" });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("INFERENCE_SMOKE_OK PONG");
    },
  );

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

  it("accepts a content-only proof when durable authority marks tool calling optional", () => {
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

  it("rejects service-specific direct-host authority drift before sandbox execution", () => {
    expect(() =>
      buildProviderNeutralInferenceSandboxSmokeScript("qwen3.5-9b", {
        service: "nim",
        directHostPort: 8001,
        directHealthPath: "/health",
        toolCallingRequired: true,
      }),
    ).toThrow("exact provider health authority");
  });

  it("rejects an oversized provider-neutral inference response before JSON parsing", () => {
    const result = runProviderNeutralScript({
      authority: allAgentProofAuthorities[0].authority,
      responses: [{ __oversized__: true }],
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("response exceeded byte limit");
  });

  it("does not mistake a reachable provider's own HTTP 403 for policy denial", () => {
    const authority = allAgentProofAuthorities[2].authority;
    const result = runProviderNeutralScript({
      authority,
      denial: { error: "authentication_required", detail: "missing provider API key" },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("was not an OpenShell policy denial");
  });

  it("accepts an exact OpenShell denial with guidance beyond the old 4096-byte window", () => {
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

  it("rejects an oversized OpenShell policy-denial body before parsing", () => {
    const result = runProviderNeutralScript({
      authority: allAgentProofAuthorities[2].authority,
      denialOversized: true,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("policy-denial response exceeded byte limit");
  });

  it("reports malformed OpenShell policy-denial JSON separately", () => {
    const result = runProviderNeutralScript({
      authority: allAgentProofAuthorities[2].authority,
      denialBytes: Array.from(Buffer.from('{"error":', "utf8")),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("policy-denial response was not valid JSON");
  });

  it("reports invalid UTF-8 in an OpenShell policy-denial body separately", () => {
    const result = runProviderNeutralScript({
      authority: allAgentProofAuthorities[2].authority,
      denialBytes: [0xff],
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("policy-denial response was not valid UTF-8");
  });

  it("reports OpenShell policy-denial contract format drift separately", () => {
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

  it("shell-quotes hostile model text through the generated smoke script", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-compat-smoke-quoting-"));
    const sentinel = path.join(tmpDir, "model-command-ran");
    const model = "foo'bar`baz$(touch " + sentinel + ")";
    const configPath = writeSmokeConfig(tmpDir, model);
    const { binDir, requestFile } = writeFakeCurl(
      tmpDir,
      `printf '%s\\n' '{"choices":[{"message":{"content":"PONG"},"finish_reason":"stop"}]}'`,
    );
    const script = buildCompatibleEndpointSandboxSmokeScript(model, {
      configPath,
      retryDelaySeconds: 0,
    });
    const result = runSmokeScript(script, tmpDir, binDir);
    expect(result.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(requestFile, "utf-8")).model).toBe(model);
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it("retries a reasoning-only length response before failing the sandbox smoke", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-compat-smoke-reasoning-"));
    const model = "provider/reasoning-model";
    const configPath = writeSmokeConfig(tmpDir, model);
    const { binDir, callFile } = writeFakeCurl(
      tmpDir,
      String.raw`
if [ "$count" -eq 1 ]; then
  cat <<'JSON'
{"id":"82f5ff","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":null,"reasoning_content":"The user asked for PONG."},"finish_reason":"length"}],"usage":{"completion_tokens":32,"reasoning_tokens":32}}
JSON
else
  cat <<'JSON'
{"id":"82f5ff","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"PONG"},"finish_reason":"stop"}]}
JSON
fi
`,
    );
    const script = buildCompatibleEndpointSandboxSmokeScript(model, {
      attempts: 2,
      configPath,
      initialMaxTokens: 32,
      retryDelaySeconds: 0,
      retryMaxTokens: 512,
    });

    const result = runSmokeScript(script, tmpDir, binDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OPENCLAW_CONFIG_OK");
    expect(result.stdout).toContain("INFERENCE_SMOKE_OK PONG");
    expect(result.stderr).toContain("exhausted max_tokens=32 in reasoning_content");
    expect(fs.readFileSync(callFile, "utf-8")).toBe("2");
  });

  it("retries a transient non-JSON gateway response", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-compat-smoke-transient-"));
    const model = "nvidia/nemotron-3-ultra";
    const configPath = writeSmokeConfig(tmpDir, model);
    const { binDir, callFile } = writeFakeCurl(
      tmpDir,
      String.raw`
if [ "$count" -eq 1 ]; then
  printf '%s\n' '<html><head><title>504 Gateway Time-out</title></head></html>'
else
  printf '%s\n' '{"choices":[{"message":{"content":"PONG"},"finish_reason":"stop"}]}'
fi
`,
    );
    const script = buildCompatibleEndpointSandboxSmokeScript(model, {
      attempts: 3,
      configPath,
      retryDelaySeconds: 0,
    });

    const result = runSmokeScript(script, tmpDir, binDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("INFERENCE_SMOKE_OK PONG");
    expect(result.stderr).toContain("inference.local returned non-JSON response");
    expect(result.stderr).toContain("smoke attempt 1/3 failed; retrying in 0s");
    expect(fs.readFileSync(callFile, "utf-8")).toBe("2");
  });

  it("retries a parseable JSON HTTP 500 response", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-compat-smoke-json-500-"));
    const model = "nvidia/nemotron-3-ultra";
    const configPath = writeSmokeConfig(tmpDir, model);
    const { binDir, callFile } = writeFakeCurl(
      tmpDir,
      String.raw`
if [ "$count" -eq 1 ]; then
  printf '%s\n' '__HTTP_STATUS__=500'
  printf '%s\n' '{"error":{"message":"temporary gateway failure"}}'
else
  printf '%s\n' '{"choices":[{"message":{"content":"PONG"},"finish_reason":"stop"}]}'
fi
`,
    );
    const script = buildCompatibleEndpointSandboxSmokeScript(model, {
      attempts: 3,
      configPath,
      retryDelaySeconds: 0,
    });

    const result = runSmokeScript(script, tmpDir, binDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("INFERENCE_SMOKE_OK PONG");
    expect(result.stderr).toContain("transient HTTP 500");
    expect(result.stderr).toContain("smoke attempt 1/3 failed; retrying in 0s");
    expect(fs.readFileSync(callFile, "utf-8")).toBe("2");
  });

  it("backs off for 5s then 10s between three attempts", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-compat-smoke-backoff-"));
    const model = "nvidia/nemotron-3-ultra";
    const configPath = writeSmokeConfig(tmpDir, model);
    const { binDir } = writeFakeCurl(
      tmpDir,
      String.raw`
if [ "$count" -lt 3 ]; then
  printf '%s\n' '__HTTP_STATUS__=500'
  printf '%s\n' '{"error":{"message":"temporary gateway failure"}}'
else
  printf '%s\n' '{"choices":[{"message":{"content":"PONG"},"finish_reason":"stop"}]}'
fi
`,
    );
    const sleepFile = writeFakeSleep(tmpDir, binDir);
    const script = buildCompatibleEndpointSandboxSmokeScript(model, {
      attempts: 3,
      configPath,
      retryDelaySeconds: 5,
    });
    const result = runSmokeScript(script, tmpDir, binDir);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("retrying in 5s");
    expect(result.stderr).toContain("retrying in 10s");
    expect(fs.readFileSync(sleepFile, "utf-8")).toBe("5\n10\n");
  });

  it("does not retry a parseable JSON HTTP 429 response", () => {
    // Fail closed: a blind replay cannot honor Retry-After and amplifies overload.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-compat-smoke-json-429-"));
    const model = "nvidia/nemotron-3-ultra";
    const configPath = writeSmokeConfig(tmpDir, model);
    const { binDir, callFile } = writeFakeCurl(
      tmpDir,
      String.raw`
printf '%s\n' '__HTTP_STATUS__=429'
printf '%s\n' '{"choices":[{"message":{"content":"PONG"},"finish_reason":"stop"}]}'
`,
    );
    const script = buildCompatibleEndpointSandboxSmokeScript(model, {
      attempts: 3,
      configPath,
      retryDelaySeconds: 0,
    });

    const result = runSmokeScript(script, tmpDir, binDir);

    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("INFERENCE_SMOKE_OK");
    expect(result.stderr).toContain("terminal HTTP 429");
    expect(result.stderr).not.toContain("retrying in");
    expect(fs.readFileSync(callFile, "utf-8")).toBe("1");
  });

  it.each([6, 7, 28, 52, 55, 56])(
    "retries transient curl exit %i before succeeding",
    (exitCode) => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-compat-smoke-curl-retry-"));
      const model = "nvidia/nemotron-3-ultra";
      const configPath = writeSmokeConfig(tmpDir, model);
      const { binDir, callFile } = writeFakeCurl(
        tmpDir,
        String.raw`
if [ "$count" -eq 1 ]; then
  exit ${exitCode}
fi
printf '%s\n' '{"choices":[{"message":{"content":"PONG"},"finish_reason":"stop"}]}'
`,
      );
      const script = buildCompatibleEndpointSandboxSmokeScript(model, {
        attempts: 3,
        configPath,
        retryDelaySeconds: 0,
      });

      const result = runSmokeScript(script, tmpDir, binDir);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("INFERENCE_SMOKE_OK PONG");
      expect(result.stderr).toContain(`curl exit ${exitCode}`);
      expect(result.stderr).toContain("smoke attempt 1/3 failed; retrying in 0s");
      expect(fs.readFileSync(callFile, "utf-8")).toBe("2");
    },
  );

  it("does not retry a permanent curl exit", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-compat-smoke-curl-terminal-"));
    const model = "nvidia/nemotron-3-ultra";
    const configPath = writeSmokeConfig(tmpDir, model);
    const { binDir, callFile } = writeFakeCurl(tmpDir, "exit 2");
    const script = buildCompatibleEndpointSandboxSmokeScript(model, {
      attempts: 3,
      configPath,
      retryDelaySeconds: 0,
    });

    const result = runSmokeScript(script, tmpDir, binDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("curl exit 2");
    expect(result.stderr).not.toContain("retrying in");
    expect(fs.readFileSync(callFile, "utf-8")).toBe("1");
  });

  it("does not retry a permanent JSON response validation failure", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-compat-smoke-permanent-"));
    const model = "nvidia/nemotron-3-ultra";
    const configPath = writeSmokeConfig(tmpDir, model);
    const { binDir, callFile } = writeFakeCurl(
      tmpDir,
      `printf '%s\\n' '{"error":{"message":"invalid model"}}'`,
    );
    const script = buildCompatibleEndpointSandboxSmokeScript(model, {
      attempts: 3,
      configPath,
      retryDelaySeconds: 0,
    });

    const result = runSmokeScript(script, tmpDir, binDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("did not contain non-empty choices[0].message.content");
    expect(result.stderr).not.toContain("retrying in");
    expect(fs.readFileSync(callFile, "utf-8")).toBe("1");
  });

  it("fails after the bounded transient retry budget", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-compat-smoke-exhausted-"));
    const model = "nvidia/nemotron-3-ultra";
    const configPath = writeSmokeConfig(tmpDir, model);
    const { binDir, callFile } = writeFakeCurl(
      tmpDir,
      "printf '%s\\n' '<html><head><title>504 Gateway Time-out</title></head><body>Authorization: Bearer test-secret</body></html>'",
    );
    const script = buildCompatibleEndpointSandboxSmokeScript(model, {
      attempts: 3,
      configPath,
      retryDelaySeconds: 0,
    });

    const result = runSmokeScript(script, tmpDir, binDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("http_status=504");
    expect(result.stderr).toContain("response_bytes=");
    expect(result.stderr).not.toContain("test-secret");
    expect(result.stderr).toContain("smoke attempt 1/3 failed; retrying in 0s");
    expect(result.stderr).toContain("smoke attempt 2/3 failed; retrying in 0s");
    expect(fs.readFileSync(callFile, "utf-8")).toBe("3");
  });

  it("reports a model-output budget problem when the retry also has no assistant content", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-compat-smoke-no-content-"));
    const model = "provider/reasoning-model";
    const configPath = writeSmokeConfig(tmpDir, model);
    const { binDir, callFile } = writeFakeCurl(
      tmpDir,
      String.raw`
cat <<'JSON'
{"id":"82f5ff","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":null,"reasoning_content":"Still reasoning."},"finish_reason":"length"}],"usage":{"completion_tokens":32,"reasoning_tokens":32}}
JSON
`,
    );
    const script = buildCompatibleEndpointSandboxSmokeScript(model, {
      attempts: 2,
      configPath,
      initialMaxTokens: 32,
      retryDelaySeconds: 0,
      retryMaxTokens: 64,
    });

    const result = runSmokeScript(script, tmpDir, binDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("initial smoke attempt exhausted max_tokens=32");
    expect(result.stderr).toContain("retry smoke attempt still exhausted max_tokens=64");
    expect(fs.readFileSync(callFile, "utf-8")).toBe("2");
  });

  it("passes the native multiline script through the OpenShell command argument", () => {
    const command = buildCompatibleEndpointSandboxSmokeCommand("nvidia/model");

    expect(command).toBe(buildCompatibleEndpointSandboxSmokeScript("nvidia/model"));
    expect(command).toContain("\n");
    expect(command).not.toContain("base64.b64decode");
  });
});
