// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { AgentDefinition } from "../agent/defs";
import { resolveDockerStartupCommandPatch } from "./docker-startup-command-agent";

describe("resolveDockerStartupCommandPatch", () => {
  it("selects Jetson group preservation for OpenClaw and not Hermes (#7610)", () => {
    const agent = (name: string) => ({ name }) as AgentDefinition;

    expect(resolveDockerStartupCommandPatch(agent("openclaw"), true)).toMatchObject({
      preserveJetsonDeviceGroupMembership: true,
    });
    expect(resolveDockerStartupCommandPatch(agent("hermes"), true)).toMatchObject({
      preserveJetsonDeviceGroupMembership: false,
    });
    expect(resolveDockerStartupCommandPatch(agent("openclaw"), false)).toMatchObject({
      preserveJetsonDeviceGroupMembership: true,
    });
  });
});
