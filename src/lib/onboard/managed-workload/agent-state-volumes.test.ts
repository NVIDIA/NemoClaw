// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";

import { removeManagedAgentStateVolumes } from "./agent-state-volumes";

function removedVolumeNames(agentName: string | null | undefined, workloadKind = "managed-image") {
  const runDocker = vi.fn((_args: readonly string[]) => ({
    status: 1,
    stdout: "",
    stderr: "Error: no such volume",
  }));
  removeManagedAgentStateVolumes(
    { agentName, runtimeProviderId: "docker", sandboxName: "alpha", workloadKind },
    { runDocker },
  );
  return runDocker.mock.calls.map(([args]) => args[args.length - 1]);
}

it.each([
  ["openclaw", "nemoclaw-openclaw-state-v1-alpha"],
  [null, "nemoclaw-openclaw-state-v1-alpha"],
  [undefined, "nemoclaw-openclaw-state-v1-alpha"],
  ["hermes", "nemoclaw-hermes-state-v1-alpha"],
])("derives the managed state volume for registry agent %s (#13595)", (agentName, volume) => {
  expect(removedVolumeNames(agentName)).toContain(volume);
});

it.each([
  ["an unknown agent", "not-an-agent", "managed-image"],
  ["a malformed agent", "", "managed-image"],
  ["a custom image", null, "external-image"],
])("selects no managed state volume for %s (#13595)", (_label, agentName, workloadKind) => {
  expect(removedVolumeNames(agentName, workloadKind)).toEqual([]);
});
