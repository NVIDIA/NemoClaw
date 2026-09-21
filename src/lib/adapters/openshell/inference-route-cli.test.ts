// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCliOpenShellInferenceRouteObserver,
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
