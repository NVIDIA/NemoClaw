// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCliOpenShellInferenceRouteObserver,
  createCliOpenShellInferenceRouteMutator,
  createSynchronousCliOpenShellInferenceRouteObserver,
} from "./inference-route-cli";

const namedRequest = {
  target: { kind: "named", gatewayName: "nemoclaw-19090" },
  timeoutMs: 4_321,
} as const;
const baseRequest = { target: { kind: "named", gatewayName: "nemoclaw" } } as const;

afterEach(() => vi.unstubAllEnvs());

describe("CLI inference route observation", () => {
  it("returns a typed configured route from the named gateway", async () => {
    const capture = vi.fn().mockResolvedValue({
      status: 0,
      output: "",
      stdout:
        "\u001b[32mGateway inference:\u001b[0m\n  Provider: nvidia-prod\n  Model: nvidia/model\u0007\n",
      stderr: "",
    });

    await expect(
      createCliOpenShellInferenceRouteObserver(capture).observeInferenceRoute(namedRequest),
    ).resolves.toEqual({
      ok: true,
      value: {
        state: "configured",
        route: { provider: "nvidia-prod", model: "nvidia/model" },
      },
    });
    expect(capture).toHaveBeenCalledExactlyOnceWith(["inference", "get", "-g", "nemoclaw-19090"], {
      ignoreError: true,
      includeStderr: true,
      includeStreams: true,
      outputLimitBytes: 1024 * 1024,
      timeout: 4_321,
    });
  });

  it("uses the same typed parser for synchronous OpenShell consumers", () => {
    const capture = vi.fn(() => ({
      status: 0,
      output:
        "Inference:\n  Workspace: default\n  Provider: compatible-endpoint\n  Model: custom-model\n  Version: 1\n\nSystem inference:\n  Not configured",
    }));

    expect(
      createSynchronousCliOpenShellInferenceRouteObserver(capture).observeInferenceRoute(
        namedRequest,
      ),
    ).toEqual({
      ok: true,
      value: {
        state: "configured",
        route: { provider: "compatible-endpoint", model: "custom-model" },
      },
    });
    expect(capture).toHaveBeenCalledExactlyOnceWith(
      ["inference", "get", "-g", "nemoclaw-19090"],
      expect.objectContaining({ maxBuffer: 1024 * 1024, timeout: 4_321 }),
    );
  });

  it("accepts the legacy direct provider and model output shape", async () => {
    const capture = vi.fn().mockResolvedValue({
      status: 0,
      output: "Provider: ollama-local\nModel: qwen3-vl:4b\n",
    });

    await expect(
      createCliOpenShellInferenceRouteObserver(capture).observeInferenceRoute(namedRequest),
    ).resolves.toEqual({
      ok: true,
      value: {
        state: "configured",
        route: { provider: "ollama-local", model: "qwen3-vl:4b" },
      },
    });
  });

  it.each([
    ["provider characters", "unsafe provider", "nvidia/model"],
    ["provider length", "p".repeat(129), "nvidia/model"],
    ["model characters", "nvidia", "model;unsafe"],
    ["model length", "nvidia", "m".repeat(513)],
  ])("rejects configured output with unsafe %s", async (_, provider, model) => {
    const capture = vi.fn().mockResolvedValue({
      status: 0,
      output: `Inference:\n  Provider: ${provider}\n  Model: ${model}\n`,
    });

    const result =
      await createCliOpenShellInferenceRouteObserver(capture).observeInferenceRoute(namedRequest);

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "schema", reason: "malformed_output" },
    });
    expect(JSON.stringify(result)).not.toContain(provider);
    expect(JSON.stringify(result)).not.toContain(model);
  });

  it.each(["Gateway inference:\n\n  Not configured", "Inference:\n\n  Not configured"])(
    "returns a typed unconfigured route from %s",
    async (output) => {
      const capture = vi.fn().mockResolvedValue({ status: 0, output });
      await expect(
        createCliOpenShellInferenceRouteObserver(capture).observeInferenceRoute(namedRequest),
      ).resolves.toEqual({ ok: true, value: { state: "unconfigured" } });
    },
  );

  it("rejects heading-free Not configured output", async () => {
    const capture = vi.fn().mockResolvedValue({ status: 0, output: "Not configured" });

    await expect(
      createCliOpenShellInferenceRouteObserver(capture).observeInferenceRoute(namedRequest),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: "schema", reason: "malformed_output" },
    });
  });

  it("keeps an unsupported named base-gateway read scoped", async () => {
    const capture = vi.fn().mockResolvedValue({
      status: 2,
      output: "error: unexpected argument '-g' found",
    });
    const result =
      await createCliOpenShellInferenceRouteObserver(capture).observeInferenceRoute(baseRequest);

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "command", reason: "invalid_request" },
    });
    expect(capture).toHaveBeenCalledExactlyOnceWith(
      ["inference", "get", "-g", "nemoclaw"],
      expect.any(Object),
    );
  });

  it.each([
    [
      "authentication",
      { status: 2, output: "Error: authentication failed; unknown option '-g' token=secret" },
    ],
    ["identity mismatch", { status: 1, output: "handshake verification failed secret" }],
    [
      "timeout",
      {
        status: null,
        output: "secret",
        error: Object.assign(new Error("secret"), { code: "ETIMEDOUT" }),
      },
    ],
    ["transport", { status: 1, output: "connection refused secret" }],
    ["schema", { status: 1, output: "protobuf decode error secret" }],
    ["indeterminate", { status: null, output: "secret" }],
  ])("keeps a base-gateway %s failure scoped", async (_, captured) => {
    const capture = vi.fn().mockResolvedValue(captured);
    const result =
      await createCliOpenShellInferenceRouteObserver(capture).observeInferenceRoute(baseRequest);

    expect(result.ok).toBe(false);
    expect(capture).toHaveBeenCalledOnce();
    expect(capture.mock.calls[0][0]).toEqual(["inference", "get", "-g", "nemoclaw"]);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("keeps a base-gateway process-start failure scoped", async () => {
    const capture = vi.fn().mockRejectedValue(new Error("secret path"));
    const result =
      await createCliOpenShellInferenceRouteObserver(capture).observeInferenceRoute(baseRequest);

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "transport", reason: "process_start" },
    });
    expect(capture).toHaveBeenCalledOnce();
  });

  it("does not hide a synchronous base-gateway authentication failure", () => {
    const capture = vi.fn(() => ({
      status: 2,
      output: "Error: unauthorized; unexpected argument '--gateway' secret",
    }));
    const result =
      createSynchronousCliOpenShellInferenceRouteObserver(capture).observeInferenceRoute(
        baseRequest,
      );

    expect(result).toMatchObject({ ok: false, error: { kind: "authentication" } });
    expect(capture).toHaveBeenCalledOnce();
  });

  it("keeps a named non-default gateway failure scoped", async () => {
    const capture = vi.fn().mockResolvedValue({ status: 1, output: "secret failure" });
    const result =
      await createCliOpenShellInferenceRouteObserver(capture).observeInferenceRoute(namedRequest);

    expect(result).toMatchObject({ ok: false, error: { kind: "command", reason: "failed" } });
    expect(capture).toHaveBeenCalledOnce();
    expect(capture.mock.calls[0][0]).toEqual(["inference", "get", "-g", "nemoclaw-19090"]);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it.each([
    [
      "partial",
      { status: 0, output: "Gateway inference:\n  Provider: nvidia-prod" },
      { kind: "schema", reason: "partial_route" },
    ],
    [
      "malformed",
      { status: 0, output: "Gateway inference:\n  Unexpected: secret" },
      { kind: "schema", reason: "malformed_output" },
    ],
    [
      "authentication",
      { status: 1, output: "Error: authentication failed token=secret" },
      { kind: "authentication" },
    ],
    [
      "status-zero authentication",
      { status: 0, output: "Error: unauthorized token=secret" },
      { kind: "authentication" },
    ],
    [
      "timeout",
      {
        status: null,
        output: "secret",
        error: Object.assign(new Error("secret"), { code: "ETIMEDOUT" }),
      },
      { kind: "timeout" },
    ],
    [
      "transport",
      { status: 1, output: "client error (Connect): Connection refused secret" },
      { kind: "transport", reason: "unreachable" },
    ],
    [
      "protocol",
      { status: 1, output: "protobuf decode error secret" },
      { kind: "schema", reason: "protocol_mismatch" },
    ],
    [
      "status-zero protocol",
      { status: 0, output: "protobuf decode: invalid wire type secret" },
      { kind: "schema", reason: "protocol_mismatch" },
    ],
  ])("keeps a %s failure typed and redacted", async (_, captured, error) => {
    const result = await createCliOpenShellInferenceRouteObserver(
      vi.fn().mockResolvedValue(captured),
    ).observeInferenceRoute(namedRequest);
    expect(result).toMatchObject({ ok: false, error });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("rejects a competing gateway endpoint before observation", async () => {
    const capture = vi.fn();
    const result = await createCliOpenShellInferenceRouteObserver(capture, {
      environment: { OPENSHELL_GATEWAY_ENDPOINT: "https://other.invalid" },
    }).observeInferenceRoute(namedRequest);

    expect(result).toMatchObject({ ok: false, error: { kind: "validation" } });
    expect(capture).not.toHaveBeenCalled();
  });

  it("contains a thrown process-start failure", async () => {
    const capture = vi.fn().mockRejectedValue(new Error("secret path"));
    const result =
      await createCliOpenShellInferenceRouteObserver(capture).observeInferenceRoute(namedRequest);

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "transport", reason: "process_start" },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});

const mutationRequest = {
  target: { kind: "named", gatewayName: "nemoclaw-19090" },
  route: { provider: "openai-api", model: "gpt-5" },
  verification: "skip",
  verificationTimeoutSeconds: 30,
  timeoutMs: 4_321,
} as const;

describe("CLI inference route mutation", () => {
  it("updates only the named gateway through the bounded asynchronous capture", async () => {
    const capture = vi.fn().mockResolvedValue({ status: 0, output: "", stdout: "", stderr: "" });

    await expect(
      createCliOpenShellInferenceRouteMutator(capture).setInferenceRoute(mutationRequest),
    ).resolves.toEqual({ ok: true });
    expect(capture).toHaveBeenCalledExactlyOnceWith(
      [
        "inference",
        "set",
        "-g",
        "nemoclaw-19090",
        "--no-verify",
        "--provider",
        "openai-api",
        "--model",
        "gpt-5",
        "--timeout",
        "30",
      ],
      {
        ignoreError: true,
        includeStderr: true,
        includeStreams: true,
        outputLimitBytes: 1024 * 1024,
        timeout: 4_321,
      },
    );
  });

  it("rejects invalid input and competing endpoint authority before spawning", async () => {
    const capture = vi.fn();
    const mutator = createCliOpenShellInferenceRouteMutator(capture, {
      environment: { OPENSHELL_GATEWAY_ENDPOINT: "https://other.invalid" },
    });

    await expect(mutator.setInferenceRoute(mutationRequest)).resolves.toMatchObject({
      ok: false,
      ambiguous: false,
      error: { kind: "validation" },
    });
    expect(capture).not.toHaveBeenCalled();
  });

  it.each([0, -1, 4_321.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    "rejects an unsafe outer process timeout before spawning: %s",
    async (timeoutMs) => {
      const capture = vi.fn();

      await expect(
        createCliOpenShellInferenceRouteMutator(capture).setInferenceRoute({
          ...mutationRequest,
          timeoutMs,
        }),
      ).resolves.toMatchObject({
        ok: false,
        ambiguous: false,
        error: { kind: "validation" },
      });
      expect(capture).not.toHaveBeenCalled();
    },
  );

  it.each([
    "provider 'openai-api' not found",
    'Provider "openai-api" was not found',
    "not found: provider `openai-api`",
  ])("classifies an exact requested-provider failure as definite: %s", async (output) => {
    const capture = vi.fn().mockResolvedValue({ status: 17, output });

    await expect(
      createCliOpenShellInferenceRouteMutator(capture, {
        redactDiagnostic: (value) => value,
      }).setInferenceRoute(mutationRequest),
    ).resolves.toMatchObject({
      ok: false,
      ambiguous: false,
      error: { kind: "command", reason: "provider_not_found", exitCode: 17 },
    });
  });

  it.each([
    "provider 'other-provider' not found",
    "provider openai-api not found",
    "the provider name was not found: openai-api",
  ])("does not classify unsafe provider-not-found text for retry: %s", async (output) => {
    const result = await createCliOpenShellInferenceRouteMutator(
      vi.fn().mockResolvedValue({ status: 17, output }),
      { redactDiagnostic: (value) => value },
    ).setInferenceRoute(mutationRequest);

    expect(result).toMatchObject({
      ok: false,
      ambiguous: false,
      error: { kind: "command", reason: "failed", exitCode: 17 },
    });
  });

  it("bounds provider-not-found classification to the captured evidence window", async () => {
    const malformed = "x".repeat(100 * 1024);
    const withinCapture = `${"x".repeat(4_000)}\nprovider 'openai-api' not found`;
    const beyondCapture = `${"x".repeat(1024 * 1024)}\nprovider 'openai-api' not found`;
    const mutator = (output: string) =>
      createCliOpenShellInferenceRouteMutator(vi.fn().mockResolvedValue({ status: 17, output }), {
        redactDiagnostic: (value) => value,
      }).setInferenceRoute(mutationRequest);

    await expect(mutator(malformed)).resolves.toMatchObject({
      ok: false,
      ambiguous: false,
      error: { kind: "command", reason: "failed" },
    });
    await expect(mutator(withinCapture)).resolves.toMatchObject({
      ok: false,
      ambiguous: false,
      error: { kind: "command", reason: "provider_not_found" },
    });
    await expect(mutator(beyondCapture)).resolves.toMatchObject({
      ok: false,
      ambiguous: false,
      error: { kind: "command", reason: "failed" },
    });
  });

  it("classifies beyond display truncation while redacting URL userinfo and query text", async () => {
    const password = "provider-password-secret";
    const query = "provider-query-secret";
    const result = await createCliOpenShellInferenceRouteMutator(
      vi.fn().mockResolvedValue({
        status: 17,
        output:
          `https://user:${password}@gateway.example.test/v1?token=${query} ${"x".repeat(3_000)}` +
          "\nprovider 'openai-api' not found",
      }),
      {
        redactDiagnostic: (value) =>
          value.replace(password, "[redacted]").replace(query, "[redacted]"),
      },
    ).setInferenceRoute(mutationRequest);

    expect(result).toMatchObject({
      ok: false,
      ambiguous: false,
      error: { kind: "command", reason: "provider_not_found" },
    });
    expect(JSON.stringify(result)).not.toContain(password);
    expect(JSON.stringify(result)).not.toContain(query);
  });

  it.each([
    [
      "timeout",
      {
        status: null,
        output: "token=secret",
        error: Object.assign(new Error("secret"), { code: "ETIMEDOUT" }),
      },
      { kind: "timeout" },
    ],
    [
      "missing status",
      { status: null, output: "token=secret" },
      { kind: "command", reason: "indeterminate" },
    ],
    [
      "signal-terminated process with collapsed exit status",
      { status: 1, signal: "SIGTERM", output: "token=secret" },
      { kind: "command", reason: "indeterminate", exitCode: null },
    ],
    [
      "lost connection",
      { status: 1, output: "connection reset token=secret" },
      { kind: "transport", reason: "unreachable" },
    ],
    [
      "status-zero error",
      { status: 0, output: "Error: token=secret" },
      { kind: "command", reason: "indeterminate" },
    ],
  ])("marks a %s result ambiguous and redacts its detail", async (_, captured, error) => {
    const result = await createCliOpenShellInferenceRouteMutator(
      vi.fn().mockResolvedValue(captured),
      {
        redactDiagnostic: (value) => value.replaceAll("secret", "[redacted]"),
      },
    ).setInferenceRoute(mutationRequest);

    expect(result).toMatchObject({ ok: false, ambiguous: true, error });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it.each([
    ["authentication", "Error: unauthorized token=secret", { kind: "authentication" }],
    [
      "gateway identity",
      "handshake verification failed token=secret",
      { kind: "transport", reason: "identity_mismatch" },
    ],
  ])("keeps status-zero %s output ambiguous", async (_, output, error) => {
    const result = await createCliOpenShellInferenceRouteMutator(
      vi.fn().mockResolvedValue({ status: 0, output }),
      { redactDiagnostic: (value) => value.replaceAll("secret", "[redacted]") },
    ).setInferenceRoute(mutationRequest);

    expect(result).toMatchObject({
      ok: false,
      ambiguous: true,
      error,
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it.each([
    ["authentication", "Error: unauthorized", { kind: "authentication" }],
    [
      "gateway identity",
      "handshake verification failed",
      { kind: "transport", reason: "identity_mismatch" },
    ],
  ])("keeps nonzero %s output definite", async (_, output, error) => {
    const result = await createCliOpenShellInferenceRouteMutator(
      vi.fn().mockResolvedValue({ status: 1, output }),
    ).setInferenceRoute(mutationRequest);

    expect(result).toMatchObject({ ok: false, ambiguous: false, error });
  });

  it("contains a pre-spawn failure as a definite non-application", async () => {
    const capture = vi.fn().mockResolvedValue({
      status: null,
      output: "",
      error: Object.assign(new Error("missing"), { code: "ENOENT" }),
    });

    await expect(
      createCliOpenShellInferenceRouteMutator(capture).setInferenceRoute(mutationRequest),
    ).resolves.toMatchObject({
      ok: false,
      ambiguous: false,
      error: { kind: "transport", reason: "process_start" },
    });
  });

  it("keeps an unrecognized verified nonzero result ambiguous", async () => {
    const result = await createCliOpenShellInferenceRouteMutator(
      vi.fn().mockResolvedValue({ status: 19, output: "verification command failed" }),
      { redactDiagnostic: (value) => value },
    ).setInferenceRoute({
      ...mutationRequest,
      verification: "required",
      timeoutMs: 45_000,
    });

    expect(result).toMatchObject({
      ok: false,
      ambiguous: true,
      error: { kind: "command", reason: "indeterminate", exitCode: 19 },
    });
  });

  it("classifies the exact requested provider/model verification failure as definite", async () => {
    const output =
      "failed to verify inference endpoint for provider 'openai-api' and model 'gpt-5' at https://api.example.test/v1: HTTP 401 unauthorized";
    const result = await createCliOpenShellInferenceRouteMutator(
      vi.fn().mockResolvedValue({ status: 1, output }),
      { redactDiagnostic: (value) => value },
    ).setInferenceRoute({ ...mutationRequest, verification: "required", timeoutMs: 45_000 });

    expect(result).toMatchObject({
      ok: false,
      ambiguous: false,
      error: { kind: "command", reason: "verification_failed", exitCode: 1 },
    });
  });

  it.each([
    "failed to verify inference endpoint for provider 'other' and model 'gpt-5' at https://api.example.test/v1",
    "failed to verify inference endpoint for provider 'openai-api' and model 'other' at https://api.example.test/v1",
    "failed to verify inference endpoint for provider 'OpenAI-api' and model 'gpt-5' at https://api.example.test/v1",
  ])("does not trust verification failure text for a different route: %s", async (output) => {
    const result = await createCliOpenShellInferenceRouteMutator(
      vi.fn().mockResolvedValue({ status: 1, output }),
      { redactDiagnostic: (value) => value },
    ).setInferenceRoute({ ...mutationRequest, verification: "required", timeoutMs: 45_000 });

    expect(result).toMatchObject({
      ok: false,
      ambiguous: true,
      error: { kind: "command", reason: "indeterminate", exitCode: 1 },
    });
  });

  it("does not classify verification text from a successful command", async () => {
    const output =
      "failed to verify inference endpoint for provider 'openai-api' and model 'gpt-5' at https://api.example.test/v1";

    await expect(
      createCliOpenShellInferenceRouteMutator(
        vi.fn().mockResolvedValue({ status: 0, output }),
      ).setInferenceRoute({ ...mutationRequest, verification: "required", timeoutMs: 45_000 }),
    ).resolves.toEqual({ ok: true });
  });

  it.each(["HTTP 401 unauthorized", "Error: authentication failed"])(
    "does not treat required-verification authorization output as a definite pre-write failure: %s",
    async (output) => {
      const result = await createCliOpenShellInferenceRouteMutator(
        vi.fn().mockResolvedValue({ status: 1, output }),
        { redactDiagnostic: (value) => value },
      ).setInferenceRoute({
        ...mutationRequest,
        verification: "required",
        timeoutMs: 45_000,
      });

      expect(result).toMatchObject({
        ok: false,
        ambiguous: true,
        error: { kind: "command", reason: "indeterminate", exitCode: 1 },
      });
    },
  );

  it("does not expose a successful exit code for an ambiguous required-verification failure", async () => {
    const result = await createCliOpenShellInferenceRouteMutator(
      vi.fn().mockResolvedValue({ status: 0, output: "Error: authentication failed" }),
      { redactDiagnostic: (value) => value },
    ).setInferenceRoute({
      ...mutationRequest,
      verification: "required",
      timeoutMs: 45_000,
    });

    expect(result).toMatchObject({
      ok: false,
      ambiguous: true,
      error: { kind: "command", reason: "indeterminate", exitCode: null },
    });
  });

  it("allows verified mutations enough outer-process grace without extending no-verify calls", async () => {
    const verifiedCapture = vi
      .fn()
      .mockResolvedValue({ status: 0, output: "", stdout: "", stderr: "" });
    await createCliOpenShellInferenceRouteMutator(verifiedCapture).setInferenceRoute({
      ...mutationRequest,
      verification: "required",
      verificationTimeoutSeconds: 180,
      timeoutMs: undefined,
    });
    expect(verifiedCapture).toHaveBeenCalledWith(
      expect.arrayContaining(["--timeout", "180"]),
      expect.objectContaining({ timeout: 195_000 }),
    );

    const skippedCapture = vi
      .fn()
      .mockResolvedValue({ status: 0, output: "", stdout: "", stderr: "" });
    await createCliOpenShellInferenceRouteMutator(skippedCapture).setInferenceRoute({
      ...mutationRequest,
      verification: "skip",
      verificationTimeoutSeconds: 180,
      timeoutMs: 4_321,
    });
    expect(skippedCapture).toHaveBeenCalledWith(
      expect.arrayContaining(["--no-verify", "--timeout", "180"]),
      expect.objectContaining({ timeout: 4_321 }),
    );
  });

  it("allows the omitted 60-second verification default enough outer-process grace", async () => {
    const capture = vi.fn().mockResolvedValue({ status: 0, output: "" });

    await createCliOpenShellInferenceRouteMutator(capture).setInferenceRoute({
      target: mutationRequest.target,
      route: mutationRequest.route,
      verification: "required",
    });

    expect(capture).toHaveBeenCalledWith(
      expect.not.arrayContaining(["--timeout"]),
      expect.objectContaining({ timeout: 75_000 }),
    );
  });

  it("rejects an explicit process cap shorter than omitted required verification", async () => {
    const capture = vi.fn();

    await expect(
      createCliOpenShellInferenceRouteMutator(capture).setInferenceRoute({
        target: mutationRequest.target,
        route: mutationRequest.route,
        verification: "required",
        timeoutMs: 74_999,
      }),
    ).resolves.toMatchObject({
      ok: false,
      ambiguous: false,
      error: { kind: "validation" },
    });
    expect(capture).not.toHaveBeenCalled();
  });

  it("treats a rejected asynchronous capture as an unknown outcome", async () => {
    const capture = vi.fn().mockRejectedValue(new Error("secret"));

    const result =
      await createCliOpenShellInferenceRouteMutator(capture).setInferenceRoute(mutationRequest);
    expect(result).toMatchObject({
      ok: false,
      ambiguous: true,
      error: { kind: "command", reason: "indeterminate", exitCode: null },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
