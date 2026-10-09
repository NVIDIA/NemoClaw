// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createDestroyHarness,
  resetDestroyModuleCache,
  spyOnNativeCustomDestroyCleanup,
} from "../../../../test/helpers/destroy-flow-test-harness";
import {
  prepareNativeCustomProfile,
  customAttachmentFromPrepared,
} from "../../inference/native-custom";

let temporaryHome: string;
let originalGateway: string | undefined;
beforeEach(() => {
  originalGateway = process.env.OPENSHELL_GATEWAY;
  temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-destroy-"));
  vi.stubEnv("HOME", temporaryHome);
  vi.spyOn(process, "exit").mockImplementation(((code: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
});
afterEach(() => {
  originalGateway === undefined
    ? delete process.env.OPENSHELL_GATEWAY
    : (process.env.OPENSHELL_GATEWAY = originalGateway);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetDestroyModuleCache();
  fs.rmSync(temporaryHome, { recursive: true, force: true });
});

async function fixture() {
  const prepared = await prepareNativeCustomProfile({
    sandboxName: "alpha",
    provider: "compatible-endpoint",
    endpointUrl: "http://8.8.8.8/v1",
    api: "openai-completions",
  });
  const receipt = customAttachmentFromPrepared(prepared, {
    schemaVersion: 1,
    profileId: prepared.profile.id,
    providerName: prepared.providerName,
    providerId: "owned-id",
  });
  const harness = createDestroyHarness({
    registryEntryOverrides: {
      provider: "compatible-endpoint",
      nativeCustomProviderAttachment: receipt,
    },
  });
  const retire = spyOnNativeCustomDestroyCleanup(async () => {
    harness.events.push("native-cleanup");
  });
  return { harness, retire };
}

it("retires native custom providers only after confirmed sandbox deletion (#12636)", async () => {
  const { harness, retire } = await fixture();
  await harness.destroySandbox("alpha", { yes: true, cleanupGateway: false });
  expect(retire).toHaveBeenCalledWith({ gatewayName: "nemoclaw-19080", sandboxName: "alpha" });
  expect(harness.events.indexOf("delete")).toBeLessThan(harness.events.indexOf("native-cleanup"));
  expect(retire.mock.invocationCallOrder[0]).toBeLessThan(
    harness.removeSandboxSpy.mock.invocationCallOrder[0]!,
  );
});

it("retains the registry recovery record when post-delete native cleanup is unverified (#12636)", async () => {
  const { harness, retire } = await fixture();
  retire.mockRejectedValueOnce(new Error("private SDK diagnostic"));
  await expect(
    harness.destroySandbox("alpha", { yes: true, cleanupGateway: false }),
  ).rejects.toThrow("native custom provider cleanup could not be verified");
  expect(harness.events).toContain("delete");
  expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
});
