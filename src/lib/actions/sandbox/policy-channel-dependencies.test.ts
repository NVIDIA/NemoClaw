// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SandboxEntry } from "../../state/registry";
import * as registry from "../../state/registry";
import { revalidateMessagingProviderAttachmentTarget } from "./policy-channel";
import { policyChannelDependencies } from "./policy-channel-dependencies";

const FINGERPRINT = "a".repeat(64);

function sandboxEntry(overrides: Partial<SandboxEntry> = {}): SandboxEntry {
  return {
    name: "alpha",
    gatewayName: "nemoclaw",
    lifecycleGeneration: "generation-1",
    lifecycleLiveIdentityFingerprint: FINGERPRINT,
    ...overrides,
  } as SandboxEntry;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("messaging provider attachment target validation", () => {
  it("confirms live identity and unchanged lifecycle state", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue(sandboxEntry());
    const inspectIdentity = vi
      .spyOn(policyChannelDependencies, "inspectMessagingProviderAttachmentTarget")
      .mockReturnValue(FINGERPRINT);

    expect(() => revalidateMessagingProviderAttachmentTarget("alpha", "nemoclaw")).not.toThrow();

    expect(inspectIdentity).toHaveBeenCalledWith("alpha", "nemoclaw");
    expect(registry.getSandbox).toHaveBeenCalledTimes(2);
  });

  it("rejects a live sandbox identity mismatch", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue(sandboxEntry());
    vi.spyOn(policyChannelDependencies, "inspectMessagingProviderAttachmentTarget").mockReturnValue(
      "b".repeat(64),
    );

    expect(() => revalidateMessagingProviderAttachmentTarget("alpha", "nemoclaw")).toThrow(
      "changed before messaging provider attachment completed",
    );
  });

  it("rejects a lifecycle change during identity inspection", () => {
    vi.spyOn(registry, "getSandbox")
      .mockReturnValueOnce(sandboxEntry())
      .mockReturnValueOnce(sandboxEntry({ lifecycleGeneration: "generation-2" }));
    vi.spyOn(policyChannelDependencies, "inspectMessagingProviderAttachmentTarget").mockReturnValue(
      FINGERPRINT,
    );

    expect(() => revalidateMessagingProviderAttachmentTarget("alpha", "nemoclaw")).toThrow(
      "changed before messaging provider attachment completed",
    );
  });

  it("rejects incomplete lifecycle identity before inspecting OpenShell", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue(
      sandboxEntry({ lifecycleLiveIdentityFingerprint: undefined }),
    );
    const inspectIdentity = vi.spyOn(
      policyChannelDependencies,
      "inspectMessagingProviderAttachmentTarget",
    );

    expect(() => revalidateMessagingProviderAttachmentTarget("alpha", "nemoclaw")).toThrow(
      "incomplete lifecycle identity",
    );
    expect(inspectIdentity).not.toHaveBeenCalled();
  });
});
