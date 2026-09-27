// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createCliOpenShellSandboxLifecycle,
  createCliOpenShellSandboxLifecycleFromRunner,
} from "./sandbox-lifecycle-cli";

const request = {
  sandboxName: "alpha",
  target: { kind: "named", gatewayName: "nemoclaw-8091" },
} as const;

const createRequest = {
  sandboxName: "alpha",
  target: { kind: "named", gatewayName: "nemoclaw-8091" },
  source: { reference: "/tmp/context/Dockerfile" },
  policyPath: "/tmp/policy.yaml",
  driverConfigJson: '{"docker":{"mounts":[]}}',
  gpu: { device: "nvidia.com/gpu=all" },
  resources: { cpu: "2", memory: "4Gi" },
  providers: ["nvidia"],
  labels: { "nemoclaw.dev/create-attempt": "abc123" },
  startupCommand: ["env", "MODE=test", "nemoclaw-start"],
  environment: { PATH: "/usr/bin", NVIDIA_API_KEY: "must-not-leak" },
} as const;

describe("OpenShell sandbox lifecycle CLI", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("renders and streams one semantic create request through the named gateway", async () => {
    const streamCreate = vi.fn().mockResolvedValue({
      status: 0,
      output: "Created sandbox: alpha",
      sawProgress: true,
    });
    const result = await createCliOpenShellSandboxLifecycle({
      capture: vi.fn(),
      streamCreate,
      resolveBinary: () => "/qualified/openshell",
    }).createSandbox(createRequest, { initialPhase: "create" });

    expect(result).toMatchObject({ status: 0, ambiguous: false });
    expect(streamCreate).toHaveBeenCalledOnce();
    const [binary, args, environment, options] = streamCreate.mock.calls[0];
    expect(binary).toBe("/qualified/openshell");
    expect(args).toEqual([
      "sandbox",
      "create",
      "-g",
      "nemoclaw-8091",
      "--from",
      "/tmp/context/Dockerfile",
      "--name",
      "alpha",
      "--policy",
      "/tmp/policy.yaml",
      "--driver-config-json",
      '{"docker":{"mounts":[]}}',
      "--gpu",
      "--gpu-device",
      "nvidia.com/gpu=all",
      "--cpu",
      "2",
      "--memory",
      "4Gi",
      "--label",
      "nemoclaw.dev/create-attempt=abc123",
      "--provider",
      "nvidia",
      "--",
      "env",
      "MODE=test",
      "nemoclaw-start",
    ]);
    expect(args).not.toContain("must-not-leak");
    expect(environment).toEqual({ PATH: "/usr/bin" });
    expect(options).toMatchObject({ initialPhase: "create" });
  });

  it("renders snapshot-owned automatic provider selection semantically", async () => {
    const streamCreate = vi.fn().mockResolvedValue({ status: 0, output: "created" });

    await createCliOpenShellSandboxLifecycle({ capture: vi.fn(), streamCreate }).createSandbox({
      ...createRequest,
      providers: undefined,
      autoProviders: true,
    });

    expect(streamCreate.mock.calls[0]![1]).toContain("--auto-providers");
    expect(streamCreate.mock.calls[0]![1]).not.toContain("--provider");
  });

  it("does not restore ambient credentials while pinning create runtime selection", async () => {
    vi.stubEnv("KUBECONFIG", "/host/kubeconfig");
    vi.stubEnv("SSH_AUTH_SOCK", "/host/ssh.sock");
    const streamCreate = vi.fn().mockResolvedValue({ status: 0, output: "created" });

    await createCliOpenShellSandboxLifecycle({ capture: vi.fn(), streamCreate }).createSandbox({
      ...createRequest,
      runtimeSelection: { gatewayName: "nemoclaw-8091", workspace: "recorded" },
    });

    const environment = streamCreate.mock.calls[0]![2];
    expect(environment).toMatchObject({
      OPENSHELL_GATEWAY: "nemoclaw-8091",
      OPENSHELL_WORKSPACE: "recorded",
    });
    expect(environment).not.toHaveProperty("KUBECONFIG");
    expect(environment).not.toHaveProperty("SSH_AUTH_SOCK");
  });

  it("preserves only the explicitly prepared credential-free Docker config", async () => {
    const streamCreate = vi.fn().mockResolvedValue({ status: 0, output: "created" });

    await createCliOpenShellSandboxLifecycle({ capture: vi.fn(), streamCreate }).createSandbox({
      ...createRequest,
      environment: { ...createRequest.environment, DOCKER_CONFIG: "/host/docker-config" },
      dockerClientConfigDirectory: "/tmp/nemoclaw-credential-free-docker",
    });

    expect(streamCreate.mock.calls[0]![2]).toMatchObject({
      DOCKER_CONFIG: "/tmp/nemoclaw-credential-free-docker",
    });
    expect(streamCreate.mock.calls[0]![2].DOCKER_CONFIG).not.toBe("/host/docker-config");
  });

  it("rejects malformed create input and ambient endpoint overrides before spawn", async () => {
    const streamCreate = vi.fn();
    const lifecycle = createCliOpenShellSandboxLifecycle({ capture: vi.fn(), streamCreate });

    await expect(
      lifecycle.createSandbox({ ...createRequest, source: { reference: "bad\nsource" } }),
    ).resolves.toMatchObject({ status: 1, ambiguous: false });
    await expect(
      lifecycle.createSandbox({
        ...createRequest,
        environment: { ...createRequest.environment, OPENSHELL_GATEWAY_ENDPOINT: "https://drift" },
      }),
    ).resolves.toMatchObject({ status: 1, ambiguous: false });
    await expect(
      lifecycle.createSandbox({ ...createRequest, workingDirectory: "/tmp/bad\0directory" }),
    ).resolves.toMatchObject({ status: 1, ambiguous: false });
    await expect(
      lifecycle.createSandbox({ ...createRequest, autoProviders: true }),
    ).resolves.toMatchObject({ status: 1, ambiguous: false });
    expect(streamCreate).not.toHaveBeenCalled();
  });

  it("classifies executable resolution failure as definite before spawn", async () => {
    const streamCreate = vi.fn();
    const result = await createCliOpenShellSandboxLifecycle({
      capture: vi.fn(),
      streamCreate,
      resolveBinary: () => {
        throw new Error("OpenShell executable selection returned an empty command.");
      },
    }).createSandbox(createRequest);

    expect(result).toMatchObject({ status: 1, ambiguous: false });
    expect(streamCreate).not.toHaveBeenCalled();
  });

  it("classifies a post-spawn ready handoff timeout as ambiguous and redacts its result", async () => {
    const streamCreate = vi.fn().mockResolvedValue({
      status: 1,
      output: "NVIDIA_API_KEY=must-not-leak",
      sawProgress: true,
      readyTerminationTimedOut: true,
    });
    const result = await createCliOpenShellSandboxLifecycle({
      capture: vi.fn(),
      streamCreate,
    }).createSandbox(createRequest);

    expect(result).toMatchObject({ status: 1, ambiguous: true });
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });

  it("classifies every post-spawn nonzero result as ambiguous", async () => {
    const streamCreate = vi.fn().mockResolvedValue({
      status: 1,
      output: "gateway returned an ordinary command failure",
      sawProgress: true,
    });
    const result = await createCliOpenShellSandboxLifecycle({
      capture: vi.fn(),
      streamCreate,
    }).createSandbox(createRequest);

    expect(result).toMatchObject({ status: 1, ambiguous: true });
    expect(streamCreate).toHaveBeenCalledOnce();
  });

  it("keeps an exact pre-submission CLI parser rejection definite", async () => {
    const streamCreate = vi.fn().mockResolvedValue({
      status: 2,
      output: "error: unexpected argument '--gpu' found",
      sawProgress: false,
    });
    const result = await createCliOpenShellSandboxLifecycle({
      capture: vi.fn(),
      streamCreate,
    }).createSandbox(createRequest);

    expect(result).toMatchObject({ status: 2, ambiguous: false });
  });

  it("submits one explicitly targeted delete without retrying", async () => {
    const capture = vi.fn().mockResolvedValue({ status: 0, output: "deleted" });
    const result = await createCliOpenShellSandboxLifecycle({ capture }).deleteSandbox(request);

    expect(result).toEqual({ kind: "accepted", diagnostic: "deleted", exitCode: 0 });
    expect(capture).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledWith(["sandbox", "delete", "-g", "nemoclaw-8091", "alpha"], {
      ignoreError: true,
      includeStderr: true,
      includeStreams: true,
      maxBuffer: 1024 * 1024,
      timeout: 60_000,
    });
  });

  it("pins the delete to its frozen runtime selection", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY", "ambient");
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://ambient.invalid");
    const capture = vi.fn().mockResolvedValue({ status: 0, output: "" });

    await createCliOpenShellSandboxLifecycle({ capture }).deleteSandbox({
      ...request,
      timeoutMs: 1_234,
      runtimeSelection: {
        gatewayName: "nemoclaw-8091",
        workspace: "recorded",
        localTlsDir: "/recorded/tls",
      },
    });

    expect(capture).toHaveBeenCalledOnce();
    const [, options] = capture.mock.calls[0];
    expect(options).toMatchObject({
      timeout: 1_234,
      replaceEnv: true,
      env: {
        OPENSHELL_GATEWAY: "nemoclaw-8091",
        OPENSHELL_WORKSPACE: "recorded",
        OPENSHELL_LOCAL_TLS_DIR: "/recorded/tls",
      },
    });
    expect(options.env).not.toHaveProperty("OPENSHELL_GATEWAY_ENDPOINT");
  });

  it("rejects malformed or mismatched requests before execution", async () => {
    const capture = vi.fn();
    const lifecycle = createCliOpenShellSandboxLifecycle({ capture });

    await expect(
      lifecycle.deleteSandbox({ ...request, sandboxName: "../foreign" }),
    ).resolves.toMatchObject({
      kind: "failed",
      ambiguous: false,
      error: { kind: "command", reason: "invalid_request" },
    });
    await expect(
      lifecycle.deleteSandbox({
        ...request,
        runtimeSelection: { gatewayName: "different", workspace: "default" },
      }),
    ).resolves.toMatchObject({
      kind: "failed",
      ambiguous: false,
      error: { kind: "command", reason: "invalid_request" },
    });
    expect(capture).not.toHaveBeenCalled();
  });

  it("rejects a reserved ambient endpoint override before execution", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://foreign.invalid");
    const capture = vi.fn();

    await expect(
      createCliOpenShellSandboxLifecycle({ capture }).deleteSandbox(request),
    ).resolves.toMatchObject({
      kind: "failed",
      ambiguous: false,
      error: { reason: "invalid_request" },
    });
    expect(capture).not.toHaveBeenCalled();
  });

  it.each([
    "Error: sandbox 'alpha' not found.",
    "No such sandbox alpha",
    "Error: status: NotFound, sandbox 'alpha' not found",
    'Error: status: Not Found, message: "sandbox not found"',
    'Error: code: "Some requested entity was not found", message: "sandbox not found"',
  ])("returns only explicit target absence for %s", async (output) => {
    const capture = vi.fn().mockResolvedValue({ status: 1, output });
    await expect(
      createCliOpenShellSandboxLifecycle({ capture }).deleteSandbox(request),
    ).resolves.toMatchObject({ kind: "absent" });
  });

  it("does not mistake unrelated absence for target absence", async () => {
    const capture = vi
      .fn()
      .mockResolvedValue({ status: 1, output: "Error: provider alpha not found" });
    await expect(
      createCliOpenShellSandboxLifecycle({ capture }).deleteSandbox(request),
    ).resolves.toMatchObject({ kind: "failed", ambiguous: false });
  });

  it("does not accept a zero exit that prints an OpenShell error", async () => {
    const capture = vi.fn().mockResolvedValue({ status: 0, output: "Error: delete failed" });

    await expect(
      createCliOpenShellSandboxLifecycle({ capture }).deleteSandbox(request),
    ).resolves.toMatchObject({ kind: "failed", ambiguous: false });
  });

  it("uses aggregate runner output when captured streams are empty", async () => {
    const run = vi.fn().mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
      output: "Error: delete failed",
    });

    await expect(
      createCliOpenShellSandboxLifecycleFromRunner(run).deleteSandbox(request),
    ).resolves.toMatchObject({ kind: "failed", ambiguous: false });
  });

  it.each(["ENOENT", "EACCES"])("classifies pre-spawn %s as definite", async (code) => {
    const error = Object.assign(new Error("token=must-not-leak"), { code });
    const capture = vi.fn().mockRejectedValue(error);
    const result = await createCliOpenShellSandboxLifecycle({ capture }).deleteSandbox(request);

    expect(result).toMatchObject({ kind: "failed", ambiguous: false });
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });

  it.each([
    ["ETIMEDOUT", "timeout"],
    ["ENOBUFS", "command"],
    ["ABORT_ERR", "command"],
  ])("marks %s after submission as ambiguous", async (code, kind) => {
    const error = Object.assign(new Error("credential=must-not-leak"), { code });
    const capture = vi.fn().mockResolvedValue({
      status: null,
      output: "api_key=must-not-leak",
      error,
    });
    const result = await createCliOpenShellSandboxLifecycle({ capture }).deleteSandbox(request);

    expect(result).toMatchObject({ kind: "failed", ambiguous: true, error: { kind } });
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    expect(capture).toHaveBeenCalledOnce();
  });

  it("classifies an explicit connection refusal as definite non-submission", async () => {
    const capture = vi.fn().mockResolvedValue({
      status: 1,
      output: "tcp connect error: Connection refused (os error 61)",
    });

    await expect(
      createCliOpenShellSandboxLifecycle({ capture }).deleteSandbox(request),
    ).resolves.toMatchObject({
      kind: "failed",
      ambiguous: false,
      error: { kind: "transport", reason: "unreachable" },
    });
  });

  it("keeps connection loss after submission ambiguous", async () => {
    const capture = vi.fn().mockResolvedValue({
      status: 1,
      output: "transport error: connection reset",
    });

    await expect(
      createCliOpenShellSandboxLifecycle({ capture }).deleteSandbox(request),
    ).resolves.toMatchObject({ kind: "failed", ambiguous: true });
  });

  it("keeps an interrupted connection-refusal result ambiguous", async () => {
    const error = Object.assign(new Error("interrupted"), { code: "ABORT_ERR" });
    const capture = vi.fn().mockResolvedValue({
      status: 1,
      output: "tcp connect error: Connection refused (os error 61)",
      error,
    });

    await expect(
      createCliOpenShellSandboxLifecycle({ capture }).deleteSandbox(request),
    ).resolves.toMatchObject({ kind: "failed", ambiguous: true });
  });

  it("does not trust explicit absence from an unsettled runner result", async () => {
    const capture = vi.fn().mockResolvedValue({
      status: null,
      output: "Error: sandbox 'alpha' not found.",
    });

    await expect(
      createCliOpenShellSandboxLifecycle({ capture }).deleteSandbox(request),
    ).resolves.toMatchObject({ kind: "failed", ambiguous: true });
  });

  it("keeps a signaled runner result ambiguous", async () => {
    const run = vi.fn().mockReturnValue({ status: 1, stdout: "", stderr: "", signal: "SIGTERM" });

    await expect(
      createCliOpenShellSandboxLifecycleFromRunner(run).deleteSandbox(request),
    ).resolves.toMatchObject({ kind: "failed", ambiguous: true });
    expect(run).toHaveBeenCalledOnce();
  });

  it("keeps a signaled runner result ambiguous when the runner also reports an error", async () => {
    const run = vi.fn().mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "",
      signal: "SIGTERM",
      error: Object.assign(new Error("permission denied"), { code: "EACCES" }),
    });

    await expect(
      createCliOpenShellSandboxLifecycleFromRunner(run).deleteSandbox(request),
    ).resolves.toMatchObject({ kind: "failed", ambiguous: true });
    expect(run).toHaveBeenCalledOnce();
  });

  it("treats a rejected capture as ambiguous without exposing or retrying it", async () => {
    const capture = vi.fn().mockRejectedValue(new Error("token=must-not-leak"));
    const result = await createCliOpenShellSandboxLifecycle({ capture }).deleteSandbox(request);

    expect(result).toMatchObject({ kind: "failed", ambiguous: true });
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    expect(capture).toHaveBeenCalledOnce();
  });

  it("bounds and redacts returned diagnostics", async () => {
    const capture = vi.fn().mockResolvedValue({
      status: 1,
      output: `api_key=must-not-leak\n${"🙂".repeat(10_000)}`,
    });
    const result = await createCliOpenShellSandboxLifecycle({ capture }).deleteSandbox(request);

    expect(result).toMatchObject({ kind: "failed" });
    expect(result.diagnostic).toContain("[OpenShell diagnostic truncated]");
    expect(result.diagnostic).not.toContain("must-not-leak");
    expect(Buffer.byteLength(result.diagnostic)).toBeLessThanOrEqual(4_096);
  });

  it("adapts buffered runners and preserves selected-target environment", async () => {
    const run = vi.fn().mockReturnValue({
      status: 1,
      stdout: Buffer.from(""),
      stderr: Buffer.from("permission denied"),
    });
    const result = await createCliOpenShellSandboxLifecycleFromRunner(run).deleteSandbox({
      ...request,
      runtimeSelection: { gatewayName: "nemoclaw-8091", workspace: "recorded" },
    });

    expect(result).toMatchObject({ kind: "failed", error: { kind: "authentication" } });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][1]).toMatchObject({
      env: { OPENSHELL_GATEWAY: "nemoclaw-8091", OPENSHELL_WORKSPACE: "recorded" },
      replaceEnv: true,
      killProcessTreeOnTimeout: true,
      killSignal: "SIGKILL",
    });
  });
});
