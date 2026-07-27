// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import * as registry from "../../../state/registry";
import { handleSandboxState } from "./sandbox";
import { baseOptions, createDeps } from "./sandbox-test-fixtures";

vi.mock("../../messaging-channel-setup", () => ({
  detectMessagingChannelsFromEnv: vi.fn(() => []),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleSandboxState baseline exclusions", () => {
  it("carries complete records into the pre-destructive create intent", async () => {
    const exclusion = {
      version: 1 as const,
      agent: "openclaw",
      key: "nous_research",
      digest: "abc",
      acknowledgedAt: "2026-07-19T00:00:00.000Z",
      appliedAgentVersion: null,
    };
    vi.spyOn(registry, "getBaselineExclusions").mockReturnValue([exclusion]);
    const { deps, calls } = createDeps();

    await handleSandboxState(baseOptions(deps));

    expect(calls.resolveCreateIntent).toHaveBeenCalledWith(
      expect.objectContaining({ baselineExclusions: [exclusion] }),
    );
    const createIntent = calls.createSandbox.mock.calls[0]?.at(-1) as unknown as {
      resolved?: { policy?: { options?: { baselineExclusions?: unknown[] } } };
    };
    expect(createIntent.resolved?.policy?.options?.baselineExclusions).toEqual([exclusion]);
  });
});
