// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  attachment,
  fixture,
  switchingFixture,
} from "../../../test/helpers/inference-set-openclaw-native-local";
import { resolveOpenClawLocalSwitch } from "./inference-set/native-local";
import { runInferenceSet } from "./inference-set";

vi.mock("../adapters/openshell/provider-policy", () => ({
  requireNativeProviderPolicy: vi.fn(async () => {}),
}));

describe("OpenClaw native local live selection", () => {
  it.each([
    { provider: "vllm-local", expected: {} },
    { provider: "ollama-local", expected: { prepare: true } },
  ])(
    "keeps owned NIM shared only when selecting $provider still uses NIM",
    async ({ provider, expected }) => {
      const deps = fixture();
      await expect(
        resolveOpenClawLocalSwitch({
          agentName: "openclaw",
          provider,
          sandboxName: "alpha",
          gatewayName: "nemoclaw",
          deps,
          entry: {
            name: "alpha",
            agent: "openclaw",
            provider: "vllm-local",
            nimContainer: "owned-nim",
          },
        }),
      ).resolves.toEqual(expected);
    },
  );

  it("detaches and retires local authority before publishing a shared selection", async () => {
    const deps = fixture();
    const detach = vi.spyOn(deps.providerAdapter, "detachProvider");
    const deletion = vi.spyOn(deps.providerAdapter, "deleteProvider");
    await runInferenceSet(
      {
        provider: "nvidia-router",
        model: "routed-model",
        sandboxName: "alpha",
      },
      deps,
    );
    expect(detach).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxName: "alpha",
        providerName: attachment.providerName,
      }),
    );
    expect(deletion).toHaveBeenCalled();
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        provider: "nvidia-router",
        nativeLocalProviderAttachment: undefined,
      }),
    );
    expect(deps.calls.clearNativeLocalProviderAuthority).toHaveBeenCalledWith(attachment);
  });

  it("preserves the switch failure when restoring local access also fails", async () => {
    const deps = fixture();
    deps.calls.updateSandbox.mockReturnValue(false);
    vi.spyOn(deps.providerAdapter, "attachProvider").mockResolvedValue({
      ok: false,
      error: { kind: "command", reason: "failed", message: "reattach rejected" },
    });
    await expect(
      runInferenceSet(
        { provider: "nvidia-router", model: "routed-model", sandboxName: "alpha" },
        deps,
      ),
    ).rejects.toThrow(/Failed to update NemoClaw registry.*restoring.*reattach rejected/s);
    expect(deps.calls.clearNativeLocalProviderAuthority).not.toHaveBeenCalled();
  });

  it("switches from Ollama to another local provider without changing the shared route", async () => {
    const { deps } = switchingFixture();
    await expect(
      runInferenceSet(
        {
          provider: "vllm-local",
          model: "new-model",
          sandboxName: "alpha",
        },
        deps,
      ),
    ).resolves.toMatchObject({ provider: "vllm-local" });
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        provider: "vllm-local",
        nativeLocalProviderAttachment: expect.objectContaining({
          agent: "openclaw",
          provider: "vllm-local",
          sandboxName: "alpha",
          gatewayName: "nemoclaw",
        }),
      }),
    );
    expect(deps.calls.clearNativeLocalProviderAuthority).toHaveBeenCalledWith(attachment);
    expect(
      deps.calls.captureOpenshell.mock.calls.some(
        ([args]) => Array.isArray(args) && args[0] === "inference" && args[1] === "set",
      ),
    ).toBe(false);
  });

  it.each([
    {
      stage: "attachment",
      arrange: ({ deps, next }: ReturnType<typeof switchingFixture>) => {
        const attach = deps.providerAdapter.attachProvider;
        deps.providerAdapter.attachProvider = async (request) =>
          request.providerName === next.providerName
            ? {
                ok: false,
                error: { kind: "command", reason: "failed", message: "attachment rejected" },
              }
            : attach(request);
      },
    },
    {
      stage: "registry",
      arrange: ({ deps }: ReturnType<typeof switchingFixture>) => {
        deps.calls.updateSandbox.mockReturnValue(false);
      },
    },
  ])("restores the prior local route after $stage failure", async ({ stage, arrange }) => {
    const state = switchingFixture();
    const { deps, isPresent, isAttached } = state;
    arrange(state);
    await expect(
      runInferenceSet({ provider: "vllm-local", model: "new-model", sandboxName: "alpha" }, deps),
    ).rejects.toThrow(
      stage === "attachment" ? /attachment rejected/ : /Failed to update NemoClaw registry/,
    );
    expect(isPresent()).toBe(false);
    expect(isAttached()).toBe(false);
    const current = await deps.providerAdapter.listProviderAttachments({
      target: { kind: "named", gatewayName: "nemoclaw" },
      sandboxName: "alpha",
    });
    expect(current).toMatchObject({ ok: true, value: { names: [attachment.providerName] } });
    expect(deps.calls.clearNativeLocalProviderAuthority).not.toHaveBeenCalledWith(attachment);
  });

  it("restores prior access even when replacement retirement fails", async () => {
    const { deps, next } = switchingFixture();
    deps.calls.updateSandbox.mockReturnValue(false);
    vi.spyOn(deps.providerAdapter, "deleteProvider").mockResolvedValue({
      ok: false,
      error: { kind: "command", reason: "failed", message: "retirement rejected" },
    });
    await expect(
      runInferenceSet({ provider: "vllm-local", model: "new-model", sandboxName: "alpha" }, deps),
    ).rejects.toThrow(/Failed to update NemoClaw registry.*removal was not confirmed/s);
    expect(
      await deps.providerAdapter.listProviderAttachments({
        target: { kind: "named", gatewayName: "nemoclaw" },
        sandboxName: "alpha",
      }),
    ).toMatchObject({ ok: true, value: { names: [attachment.providerName] } });
    expect(deps.getNativeLocalProviderAuthority(next.providerName)).toEqual(next);
    expect(deps.calls.clearNativeLocalProviderAuthority).not.toHaveBeenCalled();
  });

  it("identifies both retained providers when cleanup and restoration fail", async () => {
    const { deps, next } = switchingFixture();
    deps.calls.updateSandbox.mockReturnValue(false);
    vi.spyOn(deps.providerAdapter, "deleteProvider").mockResolvedValue({
      ok: false,
      error: { kind: "command", reason: "failed", message: "retirement rejected" },
    });
    const attach = deps.providerAdapter.attachProvider;
    vi.spyOn(deps.providerAdapter, "attachProvider").mockImplementation(async (request) =>
      request.providerName === attachment.providerName
        ? {
            ok: false,
            error: { kind: "command", reason: "failed", message: "restoration rejected" },
          }
        : attach(request),
    );
    const result = runInferenceSet(
      { provider: "vllm-local", model: "new-model", sandboxName: "alpha" },
      deps,
    );
    await expect(result).rejects.toThrow(/removal was not confirmed.*restoration rejected/s);
    await expect(result).rejects.toThrow(attachment.providerName);
    await expect(result).rejects.toThrow(next.providerName);
    expect(deps.getNativeLocalProviderAuthority(next.providerName)).toEqual(next);
    expect(deps.calls.clearNativeLocalProviderAuthority).not.toHaveBeenCalled();
  });

  it("changes the selected model without touching the shared gateway route", async () => {
    const deps = fixture();
    const result = await runInferenceSet(
      {
        provider: "ollama-local",
        model: "new-model",
        sandboxName: "alpha",
      },
      deps,
    );
    expect(result.provider).toBe("ollama-local");
    expect(deps.calls.probeSandboxRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        nativeProvider: true,
        nativeLocalProviderAttachment: attachment,
        agentName: "openclaw",
        model: "new-model",
      }),
    );
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        model: "new-model",
        nativeLocalProviderAttachment: attachment,
      }),
    );
    expect(deps.calls.setOpenClawConfigValues).toHaveBeenCalled();
    expect(deps.calls.restartSandboxGateway).toHaveBeenCalled();
    expect(
      deps.calls.captureOpenshell.mock.calls.some(
        ([args]) => Array.isArray(args) && args[0] === "inference" && args[1] === "set",
      ),
    ).toBe(false);
  });

  it("retries exact provider retirement after a committed route switch", async () => {
    const deps = fixture();
    let pending = true;
    const originalDelete = deps.providerAdapter.deleteProvider.bind(deps.providerAdapter);
    vi.spyOn(deps.providerAdapter, "deleteProvider").mockImplementation(async (request) =>
      pending
        ? { ok: false, error: { kind: "command", reason: "attached", message: "attached" } }
        : originalDelete(request),
    );
    deps.listNativeLocalProviderAuthorities = () => [attachment];
    await expect(
      runInferenceSet(
        { provider: "nvidia-router", model: "routed-model", sandboxName: "alpha" },
        deps,
      ),
    ).rejects.toThrow(/retry inference set/);
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ nativeLocalProviderAttachment: undefined }),
    );
    expect(deps.calls.clearNativeLocalProviderAuthority).not.toHaveBeenCalled();

    pending = false;
    deps.getSandbox = () => ({
      name: "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw",
      provider: "nvidia-router",
      model: "routed-model",
    });
    await runInferenceSet(
      { provider: "nvidia-router", model: "routed-model", sandboxName: "alpha" },
      deps,
    );
    expect(deps.calls.clearNativeLocalProviderAuthority).toHaveBeenCalledWith(attachment);
  });
});
