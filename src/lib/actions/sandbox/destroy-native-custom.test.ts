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
  nativeCustomDestroyAuthorityStore,
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

async function fixture(attached = true, unreachable = false) {
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
    ...(unreachable
      ? { deleteStatus: 1, deleteOutput: "error trying to connect: connection refused" }
      : {}),
    registryEntryOverrides: {
      provider: "compatible-endpoint",
      nativeCustomProviderAttachment: attached ? receipt : undefined,
    },
  });
  nativeCustomDestroyAuthorityStore().setNativeCustomProviderAuthority("nemoclaw-19080", receipt);
  const retire = spyOnNativeCustomDestroyCleanup(async () => {
    harness.events.push("native-cleanup");
  });
  return { harness, retire, receipt };
}

it.each([true, false])(
  "retains native ownership during forced destroy with unreachable gateway and attachment %s (#12636)",
  async (attached) => {
    const { harness, retire } = await fixture(attached, true);
    await expect(harness.destroySandbox("alpha", { yes: true, force: true })).rejects.toThrow(
      "process.exit(1)",
    );
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
    expect(retire).not.toHaveBeenCalled();
    expect(
      nativeCustomDestroyAuthorityStore().listNativeCustomProviderAuthorities(
        "nemoclaw-19080",
        "alpha",
      ),
    ).toHaveLength(1);
    expect(harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "--force cannot discard native custom provider ownership",
    );
  },
);

it.each([true, false])(
  "retires owned native providers after confirmed deletion with attachment %s (#12636)",
  async (attached) => {
    const { harness, retire, receipt } = await fixture(attached);
    const session = harness.sessionStore;
    vi.mocked(session.loadSession).mockRestore();
    vi.mocked(session.acquireOnboardLock).mockRestore();
    vi.mocked(session.releaseOnboardLock).mockRestore();
    harness.compareAndSwapSessionSpy.mockRestore();
    session.saveSession(
      session.createSession({
        sandboxName: "alpha",
        provider: "compatible-endpoint",
        ...(attached ? { nativeCustomProviderAttachment: receipt } : {}),
      }),
    );
    await harness.destroySandbox("alpha", { yes: true, cleanupGateway: false });
    expect(session.loadSession()?.sandboxName).toBeNull();
    expect(retire).toHaveBeenCalledWith({ gatewayName: "nemoclaw-19080", sandboxName: "alpha" });
    expect(harness.events.indexOf("delete")).toBeLessThan(harness.events.indexOf("native-cleanup"));
    expect(retire.mock.invocationCallOrder[0]).toBeLessThan(
      harness.removeSandboxSpy.mock.invocationCallOrder[0]!,
    );
  },
);

it.each([true, false])(
  "retains recovery authority when native cleanup fails with attachment %s (#12636)",
  async (attached) => {
    const { harness, retire } = await fixture(attached);
    retire.mockRejectedValueOnce(new Error("private SDK diagnostic"));
    await expect(
      harness.destroySandbox("alpha", { yes: true, cleanupGateway: false }),
    ).rejects.toThrow("native custom provider cleanup could not be verified");
    expect(harness.events).toContain("delete");
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
    expect(
      nativeCustomDestroyAuthorityStore().listNativeCustomProviderAuthorities(
        "nemoclaw-19080",
        "alpha",
      ),
    ).toHaveLength(1);
  },
);

it("reports a redacted native cleanup cause and preserves authority after confirmed deletion (#12636)", async () => {
  const { harness, retire } = await fixture();
  retire.mockRejectedValueOnce(
    new Error("Provider identity changed; COMPATIBLE_API_KEY=private-cleanup-credential"),
  );
  const failure = await harness
    .destroySandbox("alpha", { yes: true, cleanupGateway: false })
    .catch((error: Error) => error.message);
  expect(failure).toContain("Provider identity changed; COMPATIBLE_API_KEY=<REDACTED>");
  expect(failure).not.toContain("private-cleanup-credential");
  expect(failure).toContain(
    "Reconcile provider identity or attachment conflicts without deleting unproven resources",
  );
  expect(harness.events).toContain("delete");
  expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
  expect(
    nativeCustomDestroyAuthorityStore().listNativeCustomProviderAuthorities(
      "nemoclaw-19080",
      "alpha",
    ),
  ).toHaveLength(1);
});
