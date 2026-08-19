// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { handleSandboxState } from "./sandbox";
import { baseOptions, createDeps } from "./sandbox-test-fixtures";

vi.mock("../../messaging-channel-setup", () => ({
  detectMessagingChannelsFromEnv: vi.fn(() => []),
  detectUnconfiguredMessagingChannels: vi.fn(() => []),
}));

describe("Hermes portable sandbox endpoint provenance", () => {
  it("preserves the selected endpoint source for fresh Hermes portable creation (#9203)", async () => {
    const { deps, calls } = createDeps();

    await handleSandboxState({
      ...baseOptions(deps),
      fresh: true,
      agent: { name: "hermes" },
      endpointSource: null,
      hostLocalInferenceRouteOnly: false,
      hermesPortableLifecycle: true,
    });

    expect(calls.createSandbox.mock.calls[0]?.at(-1)).toMatchObject({ endpointSource: null });
    expect(calls.updateSandbox).toHaveBeenCalledWith(
      "my-assistant",
      expect.objectContaining({ endpointSource: null }),
    );
  });

  it("keeps ordinary fresh Hermes endpoint provenance unchanged (#9203)", async () => {
    const { deps, calls } = createDeps();

    await handleSandboxState({
      ...baseOptions(deps),
      fresh: true,
      agent: { name: "hermes" },
      endpointSource: null,
      hostLocalInferenceRouteOnly: false,
    });

    expect(calls.createSandbox.mock.calls[0]?.at(-1)).toMatchObject({
      endpointSource: "onboard",
    });
  });
});
