// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { OPENROUTER_PROVIDER_NAME } from "../inference/openrouter";
import { runInferenceSet } from "./inference-set";
import { baseSession, createDeps } from "./inference-set.test-support";
import {
  probeSandboxInferenceInvocation,
  READINESS_INFERENCE_INVOCATION_TIMEOUT_MS,
  type SandboxInferenceInvocationDeps,
} from "./sandbox/inference-invocation-probe";

const ULTRA = "nvidia/nemotron-3-ultra-550b-a55b";
const SUPER = "nvidia/nemotron-3-super-120b-a12b";

function openRouterDeps(probeSandboxRoute?: Parameters<typeof createDeps>[0]["probeSandboxRoute"]) {
  return createDeps({
    probeSandboxRoute,
    config: {
      agents: { defaults: { model: { primary: `inference/${ULTRA}` } } },
      models: { providers: { inference: { api: "openai-completions", models: [] } } },
    },
    entry: {
      name: "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw-18085",
      gatewayPort: 18085,
      provider: OPENROUTER_PROVIDER_NAME,
      model: ULTRA,
    },
    session: baseSession({
      provider: OPENROUTER_PROVIDER_NAME,
      model: ULTRA,
      metadata: { gatewayName: "nemoclaw-18085", fromDockerfile: null },
    }),
  });
}

function routeSelections(deps: ReturnType<typeof openRouterDeps>) {
  return deps.calls.captureOpenshell.mock.calls
    .map(([args]) => args as string[])
    .filter((args) => args[0] === "inference" && args[1] === "set");
}

function expectNoConfigCommit(deps: ReturnType<typeof openRouterDeps>) {
  expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
  expect(deps.calls.setOpenClawConfigValues).not.toHaveBeenCalled();
  expect(deps.calls.updateSession).not.toHaveBeenCalled();
  expect(deps.calls.restartSandboxGateway).not.toHaveBeenCalled();
}

describe("OpenRouter model switch verification", () => {
  it("commits a switch after the real sandbox probe accepts the completion (#12628)", async () => {
    const execute = vi.fn<NonNullable<SandboxInferenceInvocationDeps["execute"]>>(async () => ({
      status: 0,
      stdout: '200\n{"choices":[{"message":{"content":"OK"}}]}',
      stderr: "",
    }));
    const deps = openRouterDeps((input) =>
      probeSandboxInferenceInvocation(
        input,
        { execute },
        READINESS_INFERENCE_INVOCATION_TIMEOUT_MS,
      ),
    );

    await expect(
      runInferenceSet({ provider: OPENROUTER_PROVIDER_NAME, model: SUPER }, deps),
    ).resolves.toMatchObject({ model: SUPER });

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      "alpha",
      expect.stringContaining("https://inference.local/v1/chat/completions"),
      READINESS_INFERENCE_INVOCATION_TIMEOUT_MS,
      { gatewayName: "nemoclaw-18085" },
    );
    expect(execute.mock.calls[0]?.[1]).toContain(`"model":"${SUPER}"`);
    expect(execute.mock.invocationCallOrder[0]).toBeLessThan(
      deps.calls.updateSandbox.mock.invocationCallOrder[0],
    );
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ model: SUPER }),
    );
    expect(deps.calls.setOpenClawConfigValues).toHaveBeenCalledWith(
      "alpha",
      expect.arrayContaining([
        { dotpath: "agents.defaults.model.primary", value: `inference/${SUPER}` },
      ]),
      "nemoclaw-18085",
    );
  });

  it.each([
    { label: "HTTP 401", status: 1, stdout: "401\n", error: "HTTP 401" },
    {
      label: "an invalid HTTP 200 body",
      status: 0,
      stdout: "200\n{}",
      error: "invalid response body",
    },
  ])(
    "restores Ultra when the real sandbox probe receives $label (#12628)",
    async ({ status, stdout, error }) => {
      const execute = vi.fn<NonNullable<SandboxInferenceInvocationDeps["execute"]>>(async () => ({
        status,
        stdout,
        stderr: "",
      }));
      const deps = openRouterDeps((input) =>
        probeSandboxInferenceInvocation(
          input,
          { execute },
          READINESS_INFERENCE_INVOCATION_TIMEOUT_MS,
        ),
      );

      await expect(
        runInferenceSet({ provider: OPENROUTER_PROVIDER_NAME, model: SUPER }, deps),
      ).rejects.toThrow(error);

      expect(execute).toHaveBeenCalledWith(
        "alpha",
        expect.stringContaining(`"model":"${SUPER}"`),
        READINESS_INFERENCE_INVOCATION_TIMEOUT_MS,
        { gatewayName: "nemoclaw-18085" },
      );
      expect(routeSelections(deps).map((args) => args.at(-1))).toEqual([SUPER, ULTRA]);
      expectNoConfigCommit(deps);
    },
  );

  it.each([
    { model: SUPER, delays: [[6_000]] },
    { model: ULTRA, delays: [] },
  ])(
    "verifies $model through the sandbox before committing (#12628)",
    async ({ model, delays }) => {
      const deps = openRouterDeps();

      const result = await runInferenceSet({ provider: OPENROUTER_PROVIDER_NAME, model }, deps);

      expect(result.model).toBe(model);
      expect(routeSelections(deps)).toEqual([
        [
          "inference",
          "set",
          "-g",
          "nemoclaw-18085",
          "--no-verify",
          "--provider",
          OPENROUTER_PROVIDER_NAME,
          "--model",
          model,
        ],
      ]);
      expect(deps.calls.probeSandboxRoute).toHaveBeenCalledWith({
        gatewayName: "nemoclaw-18085",
        sandboxName: "alpha",
        provider: OPENROUTER_PROVIDER_NAME,
        model,
        preferredInferenceApi: "openai-completions",
      });
      expect(deps.calls.probeSandboxRoute.mock.invocationCallOrder[0]).toBeLessThan(
        deps.calls.updateSandbox.mock.invocationCallOrder[0],
      );
      expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
        "alpha",
        expect.objectContaining({ model }),
      );
      expect(deps.calls.sleep.mock.calls).toEqual(delays);
    },
  );

  it.each([401, 502])(
    "restores Ultra when sandbox verification returns HTTP %s (#12628)",
    async (httpStatus) => {
      const deps = openRouterDeps();
      deps.calls.probeSandboxRoute.mockResolvedValue({
        ok: false,
        httpStatus,
        detail: `HTTP ${httpStatus}`,
      });

      await expect(
        runInferenceSet({ provider: OPENROUTER_PROVIDER_NAME, model: SUPER }, deps),
      ).rejects.toThrow(
        /Sandbox-side verification rejected.*previous OpenShell inference selection was restored/s,
      );

      expect(routeSelections(deps).map((args) => args.at(-1))).toEqual([SUPER, ULTRA]);
      expect(deps.calls.probeSandboxRoute).toHaveBeenCalledOnce();
      expectNoConfigCommit(deps);
    },
  );

  it("restores Ultra after sandbox transport retries fail (#12628)", async () => {
    const deps = openRouterDeps();
    deps.calls.probeSandboxRoute.mockResolvedValue({
      ok: false,
      httpStatus: null,
      detail: "sandbox unavailable",
    });

    await expect(
      runInferenceSet({ provider: OPENROUTER_PROVIDER_NAME, model: SUPER }, deps),
    ).rejects.toThrow(/previous OpenShell inference selection was restored/);

    expect(deps.calls.probeSandboxRoute).toHaveBeenCalledTimes(3);
    expect(routeSelections(deps).map((args) => args.at(-1))).toEqual([SUPER, ULTRA]);
    expectNoConfigCommit(deps);
  });

  it("restores Ultra when the sandbox probe throws (#12628)", async () => {
    const deps = openRouterDeps();
    deps.calls.probeSandboxRoute.mockRejectedValue(new Error("sandbox dial failed"));

    await expect(
      runInferenceSet({ provider: OPENROUTER_PROVIDER_NAME, model: SUPER }, deps),
    ).rejects.toThrow(/sandbox dial failed.*previous OpenShell inference selection was restored/s);

    expect(routeSelections(deps).map((args) => args.at(-1))).toEqual([SUPER, ULTRA]);
    expectNoConfigCommit(deps);
  });

  it("reports a failed restore without committing agent configuration (#12628)", async () => {
    const deps = openRouterDeps();
    deps.calls.probeSandboxRoute.mockResolvedValue({
      ok: false,
      httpStatus: 401,
      detail: "HTTP 401",
    });
    const setInferenceRoute = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: false,
        ambiguous: false,
        error: { kind: "command", exitCode: 1, message: "restore failed" },
      });
    deps.inferenceRouteMutator = { setInferenceRoute };

    await expect(
      runInferenceSet({ provider: OPENROUTER_PROVIDER_NAME, model: SUPER }, deps),
    ).rejects.toThrow(/Failed to restore the previous OpenShell inference selection/);

    expect(setInferenceRoute).toHaveBeenCalledTimes(2);
    expectNoConfigCommit(deps);
  });
});
