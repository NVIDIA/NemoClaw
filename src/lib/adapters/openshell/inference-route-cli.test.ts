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
      maxBuffer: 1024 * 1024,
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
      expect.objectContaining({ timeout: 4_321 }),
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

  it.each(["Gateway inference:\n\n  Not configured", "Inference:\n\n  Not configured"])(
    "returns a typed unconfigured route from %s",
    async (output) => {
      const capture = vi.fn().mockResolvedValue({ status: 0, output });
      await expect(
        createCliOpenShellInferenceRouteObserver(capture).observeInferenceRoute(namedRequest),
      ).resolves.toEqual({ ok: true, value: { state: "unconfigured" } });
    },
  );

  it("uses the legacy selected-gateway fallback only for the base gateway", async () => {
    const capture = vi
      .fn()
      .mockResolvedValueOnce({ status: 1, output: "unsupported" })
      .mockResolvedValueOnce({
        status: 0,
        output: "Inference:\n  Provider: nvidia-prod\n  Model: nvidia/model",
      });
    const observer = createCliOpenShellInferenceRouteObserver(capture, {
      allowLegacySelectedFallback: true,
    });

    await expect(
      observer.observeInferenceRoute({ target: { kind: "named", gatewayName: "nemoclaw" } }),
    ).resolves.toMatchObject({ ok: true, value: { state: "configured" } });
    expect(capture.mock.calls.map(([args]) => args)).toEqual([
      ["inference", "get", "-g", "nemoclaw"],
      ["inference", "get"],
    ]);
  });

  it("never falls back from a named non-default gateway", async () => {
    const capture = vi.fn().mockResolvedValue({ status: 1, output: "secret failure" });
    const result = await createCliOpenShellInferenceRouteObserver(capture, {
      allowLegacySelectedFallback: true,
    }).observeInferenceRoute(namedRequest);

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
