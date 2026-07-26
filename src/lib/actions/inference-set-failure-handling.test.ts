// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { InferenceSetError, runInferenceSet } from "./inference-set";
import { createDeps } from "./inference-set.test-support";

describe("runInferenceSet failure handling", () => {
  it("resolves the OpenShell runner before entering the async mutation lock", async () => {
    const deps = createDeps({
      config: { agents: { defaults: { model: { primary: "inference/nvidia/model-a" } } } },
      prepareRunOpenshell: () => {
        throw new Error("openshell CLI not found");
      },
    });

    await expect(
      runInferenceSet(
        { provider: "nvidia-prod", model: "nvidia/nemotron-3-super-120b-a12b" },
        deps,
      ),
    ).rejects.toThrow("openshell CLI not found");
    expect(deps.calls.prepareRunOpenshell).toHaveBeenCalledOnce();
    expect(deps.calls.captureOpenshell).not.toHaveBeenCalled();

    // A failed preflight cannot leave a transition lock behind: retrying with
    // a valid runner proceeds immediately in the same process.
    deps.calls.prepareRunOpenshell.mockImplementation(() => undefined);
    await expect(
      runInferenceSet(
        { provider: "nvidia-prod", model: "nvidia/nemotron-3-super-120b-a12b" },
        deps,
      ),
    ).resolves.toMatchObject({ sandboxName: "alpha" });
  });

  it("refuses unsupported agent sandboxes before changing OpenShell inference", async () => {
    const deps = createDeps({
      config: {},
      entry: { name: "spark", agent: "spark" },
    });

    await expect(
      runInferenceSet(
        { provider: "nvidia-prod", model: "nvidia/model-a", sandboxName: "spark" },
        deps,
      ),
    ).rejects.toThrow(/supports OpenClaw and Hermes/);

    expect(deps.calls.captureOpenshell).not.toHaveBeenCalled();
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
  });

  it("does not write sandbox state when openshell inference set fails", async () => {
    const deps = createDeps({ config: {}, openshellStatus: 17 });

    await expect(
      runInferenceSet({ provider: "nvidia-prod", model: "nvidia/model-a" }, deps),
    ).rejects.toThrow(/OpenShell inference route update failed/);

    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
  });

  it("keeps ENOBUFS failures bounded and redacted without writing sandbox state (#5924)", async () => {
    const password = "overflow-password-secret";
    const querySecret = "overflow-query-secret";
    const deps = createDeps({
      config: {},
      entries: [
        { name: "alpha", agent: "openclaw", provider: "nvidia-prod", model: "nvidia/model-a" },
      ],
    });
    deps.calls.captureOpenshell
      .mockReturnValueOnce({
        status: null,
        output: "",
        stdout: "",
        stderr: `error: provider 'openai-api' not found at https://user:${password}@gateway.example.test/v1?token=${querySecret} ${"x".repeat(3_000)}`,
        error: Object.assign(new Error("spawnSync openshell ENOBUFS"), { code: "ENOBUFS" }),
        signal: "SIGTERM",
      })
      .mockReturnValueOnce({
        status: 0,
        output: "nvidia-prod",
        stdout: "nvidia-prod\n",
        stderr: "",
      });

    const err = await runInferenceSet(
      { provider: "openai-api", model: "openai/gpt-5.4-mini" },
      deps,
    ).catch((error: Error) => error);

    expect(err).toBeInstanceOf(InferenceSetError);
    expect((err as InferenceSetError).exitCode).toBe(1);
    const message = (err as Error).message;
    const detail = message.match(/^OpenShell detail: (.*)$/mu)?.[1];
    expect(detail).toHaveLength(2_000);
    expect(message).not.toContain(password);
    expect(message).not.toContain(querySecret);
    expect(message).toContain("Registered providers: nvidia-prod");
    expect(message).toContain("Tip: register a new provider with `nemoclaw onboard`");
    expect(deps.calls.captureOpenshell).toHaveBeenNthCalledWith(1, expect.any(Array), {
      ignoreError: true,
      includeStreams: true,
      maxBuffer: 64 * 1024,
    });
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
  });

  it("uses gateway providers instead of stale sandbox providers for the diagnostic (#5924)", async () => {
    const deps = createDeps({
      config: {},
      entries: [
        { name: "alpha", agent: "openclaw", provider: "stale-local", model: "stale-model" },
      ],
      openshellStatus: 1,
    });
    deps.calls.captureOpenshell
      .mockReturnValueOnce({
        status: 1,
        output: "",
        stdout: "",
        stderr: "error: provider 'openai-api' not found in gateway",
      })
      .mockReturnValueOnce({
        status: 0,
        output: "alpha-telegram-bridge\nnvidia-prod",
        stdout: "alpha-telegram-bridge\nnvidia-prod\n",
        stderr: "",
      });

    const err = await runInferenceSet(
      { provider: "openai-api", model: "openai/gpt-5.4-mini" },
      deps,
    ).catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toMatch(/provider 'openai-api' not found/);
    expect(message).toMatch(/Registered providers: nvidia-prod/);
    expect(message).not.toMatch(/stale-local|telegram-bridge/);
    expect(message).toMatch(/Tip: register a new provider with `nemoclaw onboard`/);
    expect(deps.calls.captureOpenshell).toHaveBeenNthCalledWith(
      2,
      ["provider", "list", "--names"],
      { ignoreError: true, maxBuffer: 64 * 1024, timeout: 5_000 },
    );
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
  });

  it("throws the generic error when openshell fails without a provider-not-found pattern (#5924)", async () => {
    const deps = createDeps({ config: {}, openshellStatus: 42 });
    deps.calls.captureOpenshell.mockReturnValue({
      status: 42,
      stdout: "",
      stderr: "error: network timeout connecting to gateway NVIDIA_API_KEY=nvapi-secret-value",
    });

    const err = await runInferenceSet(
      { provider: "nvidia-prod", model: "nvidia/model-a" },
      deps,
    ).catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toMatch(/OpenShell inference route update failed with exit 42/);
    expect(message).toMatch(/network timeout connecting to gateway/);
    expect(message).not.toContain("nvapi-secret-value");
    expect(message).not.toMatch(/Registered providers/);
    expect(message).not.toMatch(/onboard/);
    expect(deps.calls.captureOpenshell).toHaveBeenCalledTimes(1);
  });

  it("shows 'No providers registered' when the gateway has no credential providers (#5924)", async () => {
    const deps = createDeps({
      config: {},
      entries: [{ name: "alpha", agent: "openclaw", provider: "stale-local", model: "stale" }],
      openshellStatus: 1,
    });
    deps.calls.captureOpenshell
      .mockReturnValueOnce({
        status: 1,
        output: "error: provider 'openai-api' not found in gateway",
        stdout: "error: provider 'openai-api' not found in gateway",
        stderr: "",
      })
      .mockReturnValueOnce({
        status: 0,
        output: "alpha-telegram-bridge",
        stdout: "alpha-telegram-bridge\n",
        stderr: "",
      });

    const err = await runInferenceSet(
      { provider: "openai-api", model: "openai/gpt-5.4-mini" },
      deps,
    ).catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toMatch(/No providers registered/);
    expect(message).toMatch(/Tip: register a new provider with `nemoclaw onboard`/);
  });

  it("omits provider names and emits only a static warning when the gateway query fails (#5924)", async () => {
    const querySecret = "provider-query-secret";
    const deps = createDeps({ config: {}, openshellStatus: 1 });
    deps.calls.captureOpenshell
      .mockReturnValueOnce({
        status: 1,
        output: "",
        stdout: "",
        stderr: "error: provider 'openai-api' not found in gateway",
      })
      .mockImplementationOnce(() => {
        throw new Error(`gateway provider query failed token=${querySecret}`);
      });

    const err = await runInferenceSet(
      { provider: "openai-api", model: "openai/gpt-5.4-mini" },
      deps,
    ).catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).not.toMatch(/Registered providers/);
    expect(message).not.toMatch(/No providers registered/);
    expect(message).not.toContain(querySecret);
    expect(message).toMatch(/Tip: register a new provider with `nemoclaw onboard`/);
    expect(deps.calls.log).toHaveBeenCalledWith(
      "  ⚠ Could not query registered OpenShell providers while formatting the failure.",
    );
    expect(deps.calls.log).not.toHaveBeenCalledWith(expect.stringContaining(querySecret));
  });

  it("uses the same static fallback when the gateway provider query overflows (#5924)", async () => {
    const deps = createDeps({ config: {}, openshellStatus: 1 });
    deps.calls.captureOpenshell
      .mockReturnValueOnce({
        status: 1,
        output: "",
        stdout: "",
        stderr: "error: provider 'openai-api' not found in gateway",
      })
      .mockReturnValueOnce({
        status: null,
        output: "partial-provider-name",
        stdout: "partial-provider-name",
        stderr: "overflow detail",
        error: Object.assign(new Error("spawnSync openshell ENOBUFS"), { code: "ENOBUFS" }),
        signal: "SIGTERM",
      });

    const err = await runInferenceSet(
      { provider: "openai-api", model: "openai/gpt-5.4-mini" },
      deps,
    ).catch((error: Error) => error);

    const message = (err as Error).message;
    expect(message).not.toMatch(/Registered providers|No providers registered/);
    expect(message).not.toContain("partial-provider-name");
    expect(message).toContain("Tip: register a new provider with `nemoclaw onboard`");
    expect(deps.calls.log).toHaveBeenCalledWith(
      "  ⚠ Could not query registered OpenShell providers while formatting the failure.",
    );
  });
});
