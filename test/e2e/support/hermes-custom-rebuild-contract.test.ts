// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { usesCustomNativeOnboarding } from "../../../src/lib/inference/native-provider/custom-setup.ts";
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
  hostHeader: "custom-fixture.example",
  model: "custom-model",
  bodyBytes: 1,
};

function harness(
  options: {
    endpointUrl?: string;
    destroy?: ShellProbeResult;
    configure?: ShellProbeResult;
    baselineHost?: string;
    rebuild?: ShellProbeResult;
    requests?: FakeOpenAiCompatibleRequest[];
    post?: ShellProbeResult;
  } = {},
) {
  const requests: FakeOpenAiCompatibleRequest[] = [];
  const operations: string[] = [];
  const command = vi.fn<HostCliClient["command"]>(async (_binary, args = []) => {
    const operation = args.includes("destroy")
      ? "destroy"
      : args.includes("rebuild")
        ? "rebuild"
        : "configure";
    operations.push(operation);
    return options[operation] ?? result();
  });
  const exec = vi.fn<SandboxClient["exec"]>(async () =>
    result(0, "172.19.0.1 STREAM host.openshell.internal\n"),
  );
  const execShell = vi
    .fn<SandboxClient["execShell"]>()
    .mockImplementationOnce(async () => {
      operations.push("baseline");
      // The CLI route probe can authenticate without refreshing the running
      // entrypoint. Only onboarding starts this fixture with its custom key.
      const startup = command.mock.calls.at(-1);
      const startupHasCustomCredential =
        startup?.[1]?.includes("onboard") && startup[2]?.env?.COMPATIBLE_API_KEY === "fixture-key";

      requests.push({
        ...authenticatedRequest,
        hostHeader: options.baselineHost ?? authenticatedRequest.hostHeader,
        auth: startupHasCustomCredential ? "ok" : "missing",
      });
      return startupHasCustomCredential
        ? result()
        : result(
            0,
            JSON.stringify({
              model: "custom-model",
              choices: [
                {
                  message: { content: "HTTP 401: missing bearer <REDACTED>" },
                  finish_reason: "error",
                },
              ],
              hermes: { completed: false, failed: true, error_code: "agent_error" },
            }),
          );
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
  it("starts the custom credential with the entrypoint before an unassisted rebuild", async () => {
    vi.stubEnv("COMPATIBLE_API_KEY", "ambient-key-must-not-repair-restore");
    const inventory = {
      ...authenticatedRequest,
      method: "GET",
      path: "/v1/models",
      auth: "missing",
    };
    const h = harness({ requests: [inventory, authenticatedRequest] });
    await h.run();
    expect(h.operations).toEqual(["destroy", "configure", "baseline", "rebuild", "post"]);
    expect(h.command.mock.calls[0]!.slice(0, 2)).toEqual([
      "node",
      [CLI, SANDBOX_NAME, "destroy", "--yes"],
    ]);
    const [binary, args, setup] = h.command.mock.calls[1]!;
    expect(binary).toBe("node");
    expect(args).toEqual([
      CLI,
      "onboard",
      "--fresh",
      "--non-interactive",
      "--yes",
      "--yes-i-accept-third-party-software",
    ]);
    expect(setup!.env).toMatchObject({
      COMPATIBLE_API_KEY: "fixture-key",
      NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
      NEMOCLAW_PROVIDER: "custom",
      NEMOCLAW_MODEL: "custom-model",
      NEMOCLAW_COMPAT_MODEL: "custom-model",
      NEMOCLAW_ENDPOINT_URL: "https://custom-fixture.example/v1",
      NEMOCLAW_PREFERRED_API: "openai-completions",
      NEMOCLAW_POLICY_TIER: "balanced",
    });
    const endpointUrl = setup!.env!.NEMOCLAW_ENDPOINT_URL!;
    expect(
      usesCustomNativeOnboarding(
        "compatible-endpoint",
        endpointUrl,
        SANDBOX_NAME,
        null,
        setup!.env!.NEMOCLAW_POLICY_TIER,
      ),
    ).toBe(true);
    const config: Record<string, unknown> = {};
    applyHermesManagedRoute(config, {
      model: "custom-model",
      baseUrl: endpointUrl,
      upstreamProvider: "compatible-endpoint",
      inferenceApi: "openai-completions",
    });
    expect([
      config.model.api_key,
      config.providers["compatible-endpoint"].api_key,
      config.custom_providers[0]!.api_key,
    ]).toEqual(Array(3).fill("${COMPATIBLE_API_KEY}"));
    expect(h.command.mock.calls[2]!.slice(0, 2)).toEqual([
      "node",
      [CLI, SANDBOX_NAME, "rebuild", "--yes"],
    ]);
    expect(h.command.mock.calls[2]![2]!.env).not.toHaveProperty("COMPATIBLE_API_KEY");
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

  it.each([{ destroy: result(1) }, { configure: result(1) }, { rebuild: result(1) }])(
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
    { requests: [{ ...authenticatedRequest, auth: "missing" }, authenticatedRequest] },
    { requests: [{ ...authenticatedRequest, authorizationSent: false }, authenticatedRequest] },
    { requests: [{ ...authenticatedRequest, model: "wrong-model" }, authenticatedRequest] },
    { requests: [{ ...authenticatedRequest, hostHeader: undefined }] },
    { requests: [{ ...authenticatedRequest, hostHeader: "custom-fixture.example:8443" }] },
    { requests: [{ ...authenticatedRequest, model: "wrong-model" }] },
    { requests: [{ ...authenticatedRequest, path: "/v1/models", method: "GET" }] },
  ])(
    "rejects PONG unless the first fresh hosted chat authenticates for the selected model: %j",
    async ({ requests }) => {
      const h = harness({ requests });
      await expect(h.run()).rejects.toThrow();
      expect(h.operations).toEqual(["destroy", "configure", "baseline", "rebuild", "post"]);
    },
  );

  it.each(["baseline", "replacement"] as const)(
    "rejects a valid local turn in place of the hosted %s turn",
    async (phase) => {
      const localHost = "host.openshell.internal:11434";
      const h = harness(
        phase === "baseline"
          ? { baselineHost: localHost }
          : { requests: [{ ...authenticatedRequest, hostHeader: localHost }] },
      );
      await expect(h.run()).rejects.toThrow();
      expect(h.operations).toEqual(
        phase === "baseline"
          ? ["destroy", "configure", "baseline"]
          : ["destroy", "configure", "baseline", "rebuild", "post"],
      );
    },
  );

  it("accepts the hosted HTTPS authority with an explicit default port", async () => {
    const h = harness({ baselineHost: "CUSTOM-FIXTURE.EXAMPLE:443" });
    await expect(h.run()).resolves.toBeUndefined();
  });

  it("does not retry a failed first replacement request", async () => {
    const h = harness({ post: { ...result(22), stderr: "__NEMOCLAW_HTTP_STATUS__=503\n" } });
    await expect(h.run()).rejects.toThrow();
    expect(h.execShell).toHaveBeenCalledTimes(2);
  });
});
