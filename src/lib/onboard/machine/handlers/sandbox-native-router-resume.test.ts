// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import * as managedProviderAdapter from "../../../adapters/openshell/managed-provider-adapter";
import * as providerCommand from "../../../adapters/openshell/provider-command";
import {
  createNativeLocalSetupHarness,
  nativeLocalSetupReceipt,
  withNativePolicyFixture,
} from "../../../../../test/support/native-local-setup-harness";
import { createSession } from "../../../state/onboard-session";
import type { SandboxEntry } from "../../../state/registry";
import { handleSandboxState } from "./sandbox";
import { baseOptions, createDeps } from "./sandbox-test-fixtures";

vi.mock("../../messaging-channel-setup", () => ({
  detectMessagingChannelsFromEnv: vi.fn(() => []),
  detectUnconfiguredMessagingChannels: vi.fn(() => []),
}));

function routerResumeHarness(attached = false) {
  const expected = nativeLocalSetupReceipt({
    agent: "openclaw",
    provider: "nvidia-router",
    sandboxName: "saved",
    gatewayName: "nemoclaw",
    endpointUrl: "http://host.openshell.internal:4000/v1",
    authMode: "authenticated",
  });
  const entry: SandboxEntry = {
    name: "saved",
    agent: "openclaw",
    provider: "nvidia-router",
    model: "model",
    endpointUrl: expected.endpointUrl,
    credentialEnv: "NVIDIA_INFERENCE_API_KEY",
    preferredInferenceApi: "openai-completions",
    gatewayName: "nemoclaw",
    nativeLocalProviderAttachment: expected,
    lifecycleGeneration: "generation-1",
    lifecycleLiveIdentityFingerprint: "live-1",
    toolDisclosure: "progressive",
  };
  const session = createSession({ sandboxName: "saved" });
  session.steps.sandbox.status = "complete";
  const native = createNativeLocalSetupHarness();
  native.seed(expected);
  let liveIdentity = "live-1";
  let sandboxLocked = false;
  let gatewayLocked = false;
  native.adapter.inspectProviderProfile.mockImplementation(async () => ({
    ok: true,
    value: { credentialKeys: [expected.credentialEnv] },
  }));
  native.adapter.listProviderAttachments.mockImplementation(async () => ({
    ok: true,
    value: { names: attached ? [expected.providerName] : [] },
  }));
  native.adapter.attachProvider.mockImplementation(async () => {
    expect(sandboxLocked).toBe(true);
    expect(gatewayLocked).toBe(true);
    attached = true;
    return { ok: true };
  });
  native.adapter.detachProvider.mockImplementation(async () => {
    attached = false;
    return { ok: true, value: { changed: true } };
  });
  const { deps, calls } = createDeps(
    {
      getSandboxReuseState: () => "ready",
      getSandboxRegistryEntry: () => entry,
      getSandboxRecreateObservation: () => ({
        state: "ready",
        liveIdentityFingerprint: liveIdentity,
      }),
      withSandboxMutationLock: async (_name, run) => {
        sandboxLocked = true;
        try {
          return await run();
        } finally {
          sandboxLocked = false;
        }
      },
      withGatewayRouteMutationLock: async (_name, run) => {
        gatewayLocked = true;
        try {
          return await run();
        } finally {
          gatewayLocked = false;
        }
      },
      nativeLocalProviderAdapter: native.adapter,
    },
    session,
  );
  const run = () =>
    withNativePolicyFixture(() =>
      handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "saved",
        agent: { name: "openclaw" },
        provider: "nvidia-router",
        endpointUrl: expected.endpointUrl,
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      }),
    );
  return {
    expected,
    entry,
    session,
    native,
    deps,
    calls,
    run,
    isAttached: () => attached,
    changeLiveIdentity: () => {
      liveIdentity = "replacement";
    },
  };
}

describe("native Model Router sandbox resume", () => {
  afterEach(() => vi.restoreAllMocks());
  it("restores the recorded attachment before completing Ready sandbox reuse (#13560)", async () => {
    const h = routerResumeHarness();
    await expect(h.run()).resolves.toMatchObject({ sandboxName: "saved" });
    expect(h.isAttached()).toBe(true);
    expect(h.native.adapter.attachProvider).toHaveBeenCalledExactlyOnceWith({
      target: { kind: "named", gatewayName: "nemoclaw" },
      sandboxName: "saved",
      providerName: h.expected.providerName,
    });
    expect(h.calls.createSandbox).not.toHaveBeenCalled();
    expect(h.calls.recordSkip).toHaveBeenCalledOnce();
    expect(h.calls.recordSkip.mock.invocationCallOrder[0]).toBeGreaterThan(
      h.native.adapter.attachProvider.mock.invocationCallOrder[0]!,
    );
  });

  it("verifies an already-attached provider without attaching it again (#13560)", async () => {
    const h = routerResumeHarness(true);
    await h.run();
    expect(h.isAttached()).toBe(true);
    expect(h.native.adapter.attachProvider).not.toHaveBeenCalled();
    expect(h.native.adapter.inspectProviderProfile).toHaveBeenCalled();
    expect(h.native.adapter.listProviderAttachments).toHaveBeenCalled();
    expect(h.calls.recordSkip).toHaveBeenCalledOnce();
  });

  it("refuses missing recorded authority before attaching or completing resume (#13560)", async () => {
    const h = routerResumeHarness();
    delete h.entry.nativeLocalProviderAttachment;
    await expect(h.run()).rejects.toThrow("recorded sandbox attachment authority");
    expect(h.native.adapter.attachProvider).not.toHaveBeenCalled();
    expect(h.calls.recordSkip).not.toHaveBeenCalled();
    expect(h.calls.createSandbox).not.toHaveBeenCalled();
  });

  it("refuses a changed native endpoint boundary before attachment (#13560)", async () => {
    const h = routerResumeHarness();
    h.entry.nativeLocalProviderAttachment = nativeLocalSetupReceipt({
      ...h.expected,
      endpointUrl: "http://host.openshell.internal:5000/v1",
    });
    await expect(h.run()).rejects.toThrow("recorded sandbox attachment authority");
    expect(h.native.adapter.attachProvider).not.toHaveBeenCalled();
    expect(h.calls.recordSkip).not.toHaveBeenCalled();
  });

  it("rejects an altered profile before attaching (#13560)", async () => {
    const h = routerResumeHarness();
    h.native.adapter.inspectProviderProfile.mockImplementation(async () => ({
      ok: false,
      error: { kind: "schema", message: "profile boundary changed" },
    }));
    await expect(h.run()).rejects.toThrow("profile does not match");
    expect(h.native.adapter.attachProvider).not.toHaveBeenCalled();
    expect(h.calls.recordSkip).not.toHaveBeenCalled();
  });

  it("rejects a replaced provider rather than attaching its reused name (#13560)", async () => {
    const h = routerResumeHarness();
    const [key, provider] = [...h.native.providers.entries()][0]!;
    h.native.providers.set(key, {
      ...provider,
      revision: { id: "replacement-provider", resourceVersion: 1 },
    });
    await expect(h.run()).rejects.toThrow("changed identity before attachment");
    expect(h.native.adapter.attachProvider).not.toHaveBeenCalled();
    expect(h.calls.recordSkip).not.toHaveBeenCalled();
  });

  it("keeps resume incomplete when attachment is refused (#13560)", async () => {
    const h = routerResumeHarness();
    h.native.adapter.attachProvider.mockImplementation(async () => ({
      ok: false,
      error: { kind: "command", reason: "failed", message: "attachment refused" },
    }));
    await expect(h.run()).rejects.toThrow("Could not attach");
    expect(h.isAttached()).toBe(false);
    expect(h.calls.recordSkip).not.toHaveBeenCalled();
    expect(h.calls.createSandbox).not.toHaveBeenCalled();
  });

  it("requires observed attachment after a successful command (#13560)", async () => {
    const h = routerResumeHarness();
    h.native.adapter.attachProvider.mockImplementation(async () => ({ ok: true }));
    await expect(h.run()).rejects.toThrow("does not have its native");
    expect(h.isAttached()).toBe(false);
    expect(h.calls.recordSkip).not.toHaveBeenCalled();
  });

  it("rejects missing sandbox identity authority before attachment (#13560)", async () => {
    const h = routerResumeHarness();
    delete h.entry.lifecycleGeneration;
    await expect(h.run()).rejects.toThrow("requires a verified sandbox identity");
    expect(h.native.adapter.attachProvider).not.toHaveBeenCalled();
    expect(h.calls.recordSkip).not.toHaveBeenCalled();
  });

  it("refuses a live sandbox replacement before attachment (#13560)", async () => {
    const h = routerResumeHarness();
    h.changeLiveIdentity();
    await expect(h.run()).rejects.toThrow("live identity");
    expect(h.native.adapter.attachProvider).not.toHaveBeenCalled();
    expect(h.calls.recordSkip).not.toHaveBeenCalled();
  });

  it("keeps resume incomplete when attachment authority changes during recovery (#13560)", async () => {
    const h = routerResumeHarness();
    const attach = h.native.adapter.attachProvider.getMockImplementation()!;
    h.native.adapter.attachProvider.mockImplementation(async (input) => {
      const result = await attach(input);
      h.entry.nativeLocalProviderAttachment = { ...h.expected, providerId: "changed-authority" };
      return result;
    });
    await expect(h.run()).rejects.toThrow("attachment authority changed");
    expect(h.calls.recordSkip).not.toHaveBeenCalled();
  });

  it("rechecks sandbox identity immediately before the attachment command (#13560)", async () => {
    const h = routerResumeHarness();
    h.deps.nativeLocalProviderAdapter = undefined;
    const command = vi
      .spyOn(providerCommand, "runOpenshellProviderCommand")
      .mockImplementation(() => {
        throw new Error("Unexpected provider command after sandbox replacement");
      });
    const attached = h.native.adapter.attachProvider.getMockImplementation()!;
    vi.spyOn(managedProviderAdapter, "createManagedProviderAdapter").mockImplementation((run) => {
      h.native.adapter.attachProvider.mockImplementation(async (request) => {
        h.changeLiveIdentity();
        run!(["provider", "attach"], {
          ignoreError: true,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 1000,
        });
        return attached(request);
      });
      return h.native.adapter;
    });
    await expect(h.run()).rejects.toThrow("live identity");
    expect(command).not.toHaveBeenCalled();
    expect(h.isAttached()).toBe(false);
    expect(h.calls.recordSkip).not.toHaveBeenCalled();
  });
});
