// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { isNativeInferenceSelection } from "../../../src/lib/actions/inference-set/native.ts";
import type { InferenceSetDeps } from "../../../src/lib/actions/inference-set.ts";
import type { SandboxEntry } from "../../../src/lib/state/registry.ts";
import {
  NVIDIA_HOSTED_NATIVE_PROFILE_ID,
  NVIDIA_HOSTED_NATIVE_PROVIDER,
} from "../../../src/lib/inference/native-nvidia/contract.ts";
import { applyHermesManagedRoute } from "../../../src/lib/hermes-managed-route.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import type { FakeOpenAiCompatibleRequest } from "../fixtures/fake-openai-compatible.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  CLI,
  rebuildHermesCustomBaseline,
  SANDBOX_NAME,
} from "../live/hermes-inference-switch-helpers.ts";

function result(
  exitCode = 0,
  stdout = JSON.stringify({
    model: "custom-model",
    choices: [{ message: { content: "PONG" } }],
  }),
): ShellProbeResult {
  return {
    command: [],
    exitCode,
    signal: null,
    timedOut: false,
    stdout,
    stderr: "",
    artifacts: { stdout: "", stderr: "", result: "" },
  };
}

const authenticatedRequest = {
  auth: "ok" as const,
  authorizationSent: true,
  method: "POST",
  path: "/v1/chat/completions",
  model: "custom-model",
  bodyBytes: 1,
};

function harness(
  options: {
    endpointUrl?: string;
    configure?: ShellProbeResult;
    rebuild?: ShellProbeResult;
    requests?: FakeOpenAiCompatibleRequest[];
    post?: ShellProbeResult;
  } = {},
) {
  const requests: FakeOpenAiCompatibleRequest[] = [];
  const operations: string[] = [];
  const command = vi.fn<HostCliClient["command"]>(async (_binary, args = []) => {
    const rebuild = args.includes("rebuild");
    operations.push(rebuild ? "rebuild" : "configure");
    return (rebuild ? options.rebuild : options.configure) ?? result();
  });
  const exec = vi.fn<SandboxClient["exec"]>(async () =>
    result(0, "172.19.0.1 STREAM host.openshell.internal\n"),
  );
  const execShell = vi
    .fn<SandboxClient["execShell"]>()
    .mockImplementationOnce(async () => {
      operations.push("baseline");
      requests.push(authenticatedRequest);
      return result();
    })
    .mockImplementationOnce(async () => {
      operations.push("post");
      requests.push(...(options.requests ?? [authenticatedRequest]));
      return options.post ?? result();
    });
  const writeJson = vi.fn().mockResolvedValue("receipt.json");
  return {
    command,
    execShell,
    operations,
    writeJson,
    run: () =>
      rebuildHermesCustomBaseline({
        host: { command },
        sandbox: { exec, execShell } as unknown as SandboxClient,
        endpointUrl: options.endpointUrl ?? "https://custom-fixture.example/v1",
        endpoint: {
          baseUrl: "http://host.openshell.internal:11434/v1",
          requests: () => requests,
        },
        apiKey: "fixture-key",
        model: "custom-model",
        redactionValues: ["fixture-key"],
        progress: { phase: vi.fn() },
        artifacts: { writeJson },
      }),
  };
}

describe("Hermes custom hosted rebuild evidence", () => {
  it("selects the hosted reference and requires authenticated turns around an unassisted rebuild", async () => {
    vi.stubEnv("COMPATIBLE_API_KEY", "ambient-key-must-not-repair-restore");
    const h = harness();
    await h.run();
    expect(h.operations).toEqual(["configure", "baseline", "rebuild", "post"]);
    const [binary, args, setup] = h.command.mock.calls[0]!;
    expect(binary).toBe("node");
    expect(args).toEqual([
      CLI,
      "inference",
      "set",
      "--sandbox",
      SANDBOX_NAME,
      "--provider",
      "compatible-endpoint",
      "--model",
      "custom-model",
      "--endpoint-url",
      "https://custom-fixture.example/v1",
      "--credential-env",
      "COMPATIBLE_API_KEY",
      "--inference-api",
      "openai-completions",
      "--no-verify",
    ]);
    expect(setup!.env).toMatchObject({
      COMPATIBLE_API_KEY: "fixture-key",
    });
    const recorded = {
      provider: "nvidia-prod",
      nativeNvidiaProviderAttachment: {
        schemaVersion: 1,
        profileId: NVIDIA_HOSTED_NATIVE_PROFILE_ID,
        providerName: NVIDIA_HOSTED_NATIVE_PROVIDER,
        providerId: "verified-live-attachment",
      },
    } as SandboxEntry;
    const endpointUrl = args![args!.indexOf("--endpoint-url") + 1]!;
    expect(
      isNativeInferenceSelection(
        "compatible-endpoint",
        recorded,
        endpointUrl,
        "nemoclaw",
        {} as InferenceSetDeps,
      ),
    ).toBe(true);
    expect(
      isNativeInferenceSelection(
        "compatible-endpoint",
        { provider: "compatible-endpoint" } as SandboxEntry,
        endpointUrl,
        "nemoclaw",
        {} as InferenceSetDeps,
      ),
    ).toBe(false);
    const config: Record<string, unknown> = {};
    applyHermesManagedRoute(config, {
      model: "custom-model",
      baseUrl: args![args!.indexOf("--endpoint-url") + 1]!,
      upstreamProvider: "compatible-endpoint",
      inferenceApi: "openai-completions",
    });
    expect([
      config.model.api_key,
      config.providers["compatible-endpoint"].api_key,
      config.custom_providers[0]!.api_key,
    ]).toEqual(Array(3).fill("${COMPATIBLE_API_KEY}"));
    expect(h.command.mock.calls[1]!.slice(0, 2)).toEqual([
      "node",
      [CLI, SANDBOX_NAME, "rebuild", "--yes"],
    ]);
    expect(h.command.mock.calls[1]![2]!.env).not.toHaveProperty("COMPATIBLE_API_KEY");
    expect(h.execShell.mock.calls).toHaveLength(2);
    expect(h.execShell.mock.calls[0]![2]!.env).not.toHaveProperty("COMPATIBLE_API_KEY");
    expect(h.execShell.mock.calls[1]![2]!.env).not.toHaveProperty("COMPATIBLE_API_KEY");
    expect(h.writeJson.mock.calls.map(([name]) => name)).toEqual([
      "retry/hermes-custom-before-rebuild.json",
      "retry/hermes-custom-after-rebuild.json",
    ]);
    const addedBudget =
      h.command.mock.calls.reduce((sum, call) => sum + call[2]!.timeoutMs!, 0) +
      h.execShell.mock.calls.reduce((sum, call) => sum + call[2]!.timeoutMs!, 0);
    expect(addedBudget).toBe(780_000);
  });

  it.each([{ configure: result(1) }, { rebuild: result(1) }])(
    "rejects unsuccessful setup or replacement before a post-rebuild turn: %j",
    async (options) => {
      const h = harness(options);
      await expect(h.run()).rejects.toThrow();
      expect(h.operations).not.toContain("post");
    },
  );

  it.each<{ requests: FakeOpenAiCompatibleRequest[] }>([
    { requests: [] },
    { requests: [{ ...authenticatedRequest, auth: "rejected" }] },
    { requests: [{ ...authenticatedRequest, model: "wrong-model" }] },
    { requests: [{ ...authenticatedRequest, path: "/v1/models", method: "GET" }] },
  ])(
    "rejects PONG without a fresh authenticated selected-model request: %j",
    async ({ requests }) => {
      const h = harness({ requests });
      await expect(h.run()).rejects.toThrow();
      expect(h.operations).toEqual(["configure", "baseline", "rebuild", "post"]);
    },
  );

  it("does not retry a failed first replacement request", async () => {
    const h = harness({ post: { ...result(22), stderr: "__NEMOCLAW_HTTP_STATUS__=503\n" } });
    await expect(h.run()).rejects.toThrow();
    expect(h.execShell).toHaveBeenCalledTimes(2);
  });
});
