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
import { nativeLocalIdentity } from "../inference/native-local/contract";
import { createDeps } from "../../../test/helpers/inference-set";

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

  it.each(["local", "hosted", "legacy router"])(
    "rejects a router switch from %s without a native router receipt before mutation",
    async (previous) => {
      const deps =
        previous === "local"
          ? fixture()
          : createDeps({
              config: {},
              entry: {
                name: "alpha",
                agent: "openclaw",
                provider: previous === "legacy router" ? "nvidia-router" : "nvidia-prod",
                model: "old-model",
              },
            });
      const create = vi.spyOn(deps.providerAdapter, "createProvider");
      const update = vi.spyOn(deps.providerAdapter, "updateProvider");
      const attach = vi.spyOn(deps.providerAdapter, "attachProvider");
      const detach = vi.spyOn(deps.providerAdapter, "detachProvider");
      const deletion = vi.spyOn(deps.providerAdapter, "deleteProvider");
      const route = vi.spyOn(deps.inferenceRouteMutator, "setInferenceRoute");

      await expect(
        runInferenceSet(
          {
            provider: "nvidia-router",
            model: "routed-model",
            sandboxName: "alpha",
            noVerify: true,
          },
          deps,
        ),
      ).rejects.toMatchObject({
        exitCode: 2,
        message: expect.stringMatching(/Model Router has been removed/),
      });

      expect(create).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(attach).not.toHaveBeenCalled();
      expect(detach).not.toHaveBeenCalled();
      expect(deletion).not.toHaveBeenCalled();
      expect(route).not.toHaveBeenCalled();
      expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
      expect(deps.calls.setOpenClawConfigValues).not.toHaveBeenCalled();
      expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
      expect(deps.calls.updateSession).not.toHaveBeenCalled();
      expect(deps.calls.clearNativeLocalProviderAuthority).not.toHaveBeenCalled();
      expect(deps.calls.restartSandboxGateway).not.toHaveBeenCalled();
    },
  );

  it("detaches and retires local authority before publishing a shared selection", async () => {
    const deps = fixture();
    const detach = vi.spyOn(deps.providerAdapter, "detachProvider");
    const deletion = vi.spyOn(deps.providerAdapter, "deleteProvider");
    await runInferenceSet(
      {
        provider: "nvidia-nim",
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
        provider: "nvidia-nim",
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
        { provider: "nvidia-nim", model: "routed-model", sandboxName: "alpha" },
        deps,
      ),
    ).rejects.toThrow(/Failed to update NemoClaw registry.*restoring.*reattach rejected/s);
    expect(deps.calls.clearNativeLocalProviderAuthority).not.toHaveBeenCalled();
  });

  it("reselects the same Ollama endpoint with the dual-stack profile (#13544)", async () => {
    const previous = { ...attachment, ...nativeLocalIdentity(attachment, 1) };
    const { deps, next, isAttached } = switchingFixture(previous, "ollama-local");
    await expect(
      runInferenceSet({ provider: "ollama-local", model: "old-model", sandboxName: "alpha" }, deps),
    ).resolves.toMatchObject({ provider: "ollama-local" });
    expect(isAttached()).toBe(true);
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ nativeLocalProviderAttachment: next }),
    );
    expect(deps.calls.clearNativeLocalProviderAuthority).toHaveBeenCalledWith(previous);
  });

  it("restores the IPv4 attachment when dual-stack selection cannot save the registry (#13544)", async () => {
    const previous = { ...attachment, ...nativeLocalIdentity(attachment, 1) };
    const { deps, isAttached } = switchingFixture(previous, "ollama-local");
    deps.calls.updateSandbox.mockReturnValue(false);
    await expect(
      runInferenceSet({ provider: "ollama-local", model: "old-model", sandboxName: "alpha" }, deps),
    ).rejects.toThrow(/Failed to update NemoClaw registry/);
    expect(isAttached()).toBe(false);
    expect(
      await deps.providerAdapter.listProviderAttachments({
        target: { kind: "named", gatewayName: "nemoclaw" },
        sandboxName: "alpha",
      }),
    ).toMatchObject({ ok: true, value: { names: [previous.providerName] } });
    expect(deps.calls.clearNativeLocalProviderAuthority).not.toHaveBeenCalledWith(previous);
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
    expect(deps.getNativeLocalProviderAuthority?.(next.providerName)).toEqual(next);
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
    expect(deps.getNativeLocalProviderAuthority?.(next.providerName)).toEqual(next);
    expect(deps.calls.clearNativeLocalProviderAuthority).not.toHaveBeenCalled();
  });

  it.each(["ollama-local"] as const)(
    "changes the %s model without touching the shared gateway route",
    async (provider) => {
      const selectedBinding = attachment;
      const selected = { ...selectedBinding, ...nativeLocalIdentity(selectedBinding) };
      const deps = fixture(selected);
      const result = await runInferenceSet(
        {
          provider,
          model: "new-model",
          sandboxName: "alpha",
        },
        deps,
      );
      expect(result.provider).toBe(provider);
      expect(deps.calls.probeSandboxRoute).toHaveBeenCalledWith(
        expect.objectContaining({
          nativeProvider: true,
          nativeLocalProviderAttachment: selected,
          agentName: "openclaw",
          model: "new-model",
        }),
      );
      expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
        "alpha",
        expect.objectContaining({
          model: "new-model",
          nativeLocalProviderAttachment: selected,
        }),
      );
      expect(deps.calls.setOpenClawConfigValues).toHaveBeenCalled();
      expect(JSON.stringify(deps.calls.setOpenClawConfigValues.mock.calls)).toContain(
        "NEMOCLAW_LOCAL_INFERENCE_TOKEN",
      );
      expect(deps.calls.restartSandboxGateway).toHaveBeenCalled();
      expect(
        deps.calls.captureOpenshell.mock.calls.some(
          ([args]) => Array.isArray(args) && args[0] === "inference" && args[1] === "set",
        ),
      ).toBe(false);
    },
  );

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
        { provider: "nvidia-nim", model: "routed-model", sandboxName: "alpha" },
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
      provider: "nvidia-nim",
      model: "routed-model",
    });
    await runInferenceSet(
      { provider: "nvidia-nim", model: "routed-model", sandboxName: "alpha" },
      deps,
    );
    expect(deps.calls.clearNativeLocalProviderAuthority).toHaveBeenCalledWith(attachment);
  });

  it("rejects a conflicting gateway identity before retiring pending local authority", async () => {
    const pendingBinding = { ...attachment, gatewayName: "nemoclaw-18080" };
    const pending = { ...pendingBinding, ...nativeLocalIdentity(pendingBinding) };
    const deps = fixture(pending);
    const entry = deps.getSandbox("alpha")!;
    entry.gatewayName = "nemoclaw-18081";
    entry.gatewayPort = 18080;
    entry.nativeLocalProviderAttachment = undefined;
    deps.listNativeLocalProviderAuthorities = () => [pending];
    const detach = vi.spyOn(deps.providerAdapter, "detachProvider");
    const deletion = vi.spyOn(deps.providerAdapter, "deleteProvider");

    await expect(
      runInferenceSet(
        { provider: "nvidia-nim", model: "routed-model", sandboxName: "alpha" },
        deps,
      ),
    ).rejects.toThrow(/conflicting gateway identity/);
    expect(detach).not.toHaveBeenCalled();
    expect(deletion).not.toHaveBeenCalled();
    expect(deps.calls.clearNativeLocalProviderAuthority).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
  });
});
