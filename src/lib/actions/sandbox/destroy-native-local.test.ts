// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDestroyHarness,
  resetDestroyModuleCache,
} from "../../../../test/helpers/destroy-flow-test-harness";
import { serializedLlamaCppHostLocalInferenceReceipt } from "../../../../test/helpers/host-local-inference-receipt";
import type { SandboxEntry } from "../../state/registry";
import {
  nativeLocalIdentity,
  type NativeLocalBinding,
} from "../../inference/native-local/contract";
import { retireDestroyedSandboxNativeLocalProvider } from "./destroy-execution";

const binding: NativeLocalBinding = {
  provider: "llama-cpp-local",
  endpointUrl: "http://host.openshell.internal:8080/v1",
  credentialEnv: "NEMOCLAW_LLAMACPP_LOCAL_TOKEN",
  authMode: "authenticated",
  gatewayName: "nemoclaw-19080",
  sandboxName: "alpha",
};
const attachment = {
  ...binding,
  ...nativeLocalIdentity(binding),
  schemaVersion: 1 as const,
  providerId: "owned-provider-id",
};

describe("native local provider destroy", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-destroy-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("OPENSHELL_GATEWAY", "nemoclaw-19080");
    vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetDestroyModuleCache();
    fs.rmSync(home, { force: true, recursive: true });
  });

  it(
    "releases the runtime cleanup lease and preserves registry authority when provider retirement fails (#12558)",
    { timeout: 30_000 },
    async () => {
      const abort = vi.fn();
      const cleanup = vi.fn(() => ({ ok: true as const, removed: [], preserved: [] }));
      const harness = createDestroyHarness({
        provider: "llama-cpp-local",
        hostLocalInferenceReceipt: serializedLlamaCppHostLocalInferenceReceipt(),
        registryEntryOverrides: { nativeLocalProviderAttachment: attachment },
        preparedManagedLlamaCppRuntimeCleanup: { abort, cleanup },
      });
      harness.retireNativeLocalProviderSpy.mockRejectedValueOnce(
        new Error("provider ownership uncertain"),
      );
      await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow(
        "provider ownership uncertain",
      );
      expect(abort).toHaveBeenCalledOnce();
      expect(cleanup).not.toHaveBeenCalled();
      expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
    },
  );

  it("retains native provider authority when forced deletion cannot reach the gateway (#12558)", async () => {
    const harness = createDestroyHarness({
      deleteStatus: 1,
      deleteOutput: "connection refused",
      registryEntryOverrides: { nativeLocalProviderAttachment: attachment },
    });
    await expect(harness.destroySandbox("alpha", { yes: true, force: true })).rejects.toThrow(
      "process.exit(1)",
    );
    expect(harness.retireNativeLocalProviderSpy).not.toHaveBeenCalled();
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
  });
  it("retains detached provider cleanup authority after an unreachable forced destroy (#12558)", async () => {
    const harness = createDestroyHarness({ deleteStatus: 1, deleteOutput: "connection refused" });
    const authority = harness.nativeLocalProviderAuthority;
    authority.setNativeLocalProviderAuthority(attachment);
    await expect(harness.destroySandbox("alpha", { yes: true, force: true })).rejects.toThrow(
      "process.exit(1)",
    );
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
    expect(authority.getNativeLocalProviderAuthority(attachment.providerName)).toEqual(attachment);
  });

  it("runs native authority cleanup after confirmed destroy even when the current route is shared (#12558)", async () => {
    const harness = createDestroyHarness({});
    await harness.destroySandbox("alpha", { yes: true });
    expect(harness.retireNativeLocalProviderSpy).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: "alpha" }),
      "nemoclaw-19080",
      expect.any(Function),
      undefined,
    );
    expect(harness.removeSandboxSpy).toHaveBeenCalledOnce();
  });

  it("retires the native provider in the selected OpenShell workspace (#12975)", async () => {
    vi.stubEnv("OPENSHELL_WORKSPACE", "ambient-workspace");
    const runOpenshell = vi.fn(() => ({
      status: 1,
      stdout: "",
      stderr: `Error: provider '${attachment.providerName}' not found`,
    }));
    const sandbox = {
      name: "alpha",
      nativeLocalProviderAttachment: attachment,
    } as SandboxEntry;

    await retireDestroyedSandboxNativeLocalProvider(sandbox, binding.gatewayName, runOpenshell, {
      gatewayName: binding.gatewayName,
      workspace: "owned-workspace",
    });

    expect(runOpenshell).toHaveBeenCalledWith(
      expect.arrayContaining(["provider", "get", attachment.providerName]),
      expect.objectContaining({
        replaceEnv: true,
        env: expect.objectContaining({
          OPENSHELL_GATEWAY: binding.gatewayName,
          OPENSHELL_WORKSPACE: "owned-workspace",
        }),
      }),
    );
  });
});
