// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, it, vi } from "vitest";
import { switchyardBindingFixture } from "../../../test/helpers/hermes-switchyard";
import { managedStartupE2eProfile } from "../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { mockRootReplayFilesystem } from "../../../test/helpers/managed-startup-root-replay-filesystem";
import { createHermesSwitchyardRoutingIntent } from "../hermes-switchyard-routing";
import { encodeManagedStartupProfile } from "./managed-startup/profile";
import { createManagedStartupRootApplyRequest } from "./managed-startup/root-apply";
import * as sharedStateTransaction from "./managed-startup/shared-state-transaction";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn().mockReturnValue({ error: undefined, status: 0 }),
}));
const coordinatorMock = vi.hoisted(() => ({
  coordinateManagedStartupApplication: vi.fn(),
}));
vi.mock("./managed-startup/coordinator", () => coordinatorMock);
import { applyManagedStartupRootRequest } from "./managed-startup/image-runtime";

afterEach(() => vi.restoreAllMocks());

it("applies a routed root request without transporting workload credential references (#13863)", async () => {
  const routing = createHermesSwitchyardRoutingIntent({
    efficient: { provider: "nvidia-prod", model: "nvidia/nano" },
    capable: { provider: "openai-api", model: "gpt-5" },
  });
  const base = managedStartupE2eProfile("hermes");
  const profile = {
    ...base,
    agentConfig: {
      agent: "hermes" as const,
      webSearch: { enabled: false, provider: "tavily" as const },
      switchyardRouting: routing,
      switchyardBindings: switchyardBindingFixture(routing),
    },
  };
  const request = createManagedStartupRootApplyRequest({
    agent: "hermes",
    encodedProfile: encodeManagedStartupProfile(profile),
  });
  mockRootReplayFilesystem([]);
  vi.spyOn(process, "geteuid").mockReturnValue(0);
  vi.spyOn(sharedStateTransaction, "beginManagedStartupSharedStateTransaction").mockReturnValue(
    true,
  );
  const coordinatorFailure = new Error("coordinator boundary reached");
  coordinatorMock.coordinateManagedStartupApplication.mockRejectedValue(coordinatorFailure);

  await expect(
    applyManagedStartupRootRequest(request, {
      NVIDIA_INFERENCE_API_KEY: "openshell:resolve:env:v7_NVIDIA_INFERENCE_API_KEY",
      OPENAI_API_KEY: `openshell:resolve:env:s${"a".repeat(64)}_OPENAI_API_KEY`,
    }),
  ).rejects.toBe(coordinatorFailure);
  expect(coordinatorMock.coordinateManagedStartupApplication).toHaveBeenCalledTimes(1);
  const applicationInput = coordinatorMock.coordinateManagedStartupApplication.mock.calls[0][0];
  expect(applicationInput).toMatchObject({
    encodedProfile: request.encodedProfile,
    expectedAgent: "hermes",
  });
  expect(JSON.stringify(applicationInput)).not.toContain("openshell:resolve:env:");
});
