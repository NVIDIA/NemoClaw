// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { AgentDefinition } from "../agent/defs";
import type { CheckpointPortableRuntimeAuthority } from "../state/onboard-checkpoint-types";
import {
  resolveAgentCreateInput,
  resolveExportedPortableRuntimeAuthority,
  resolvePortableLifecycleMode,
} from "./sandbox-gpu-create-flow";

const PORTABLE_RUNTIME_AUTHORITY: CheckpointPortableRuntimeAuthority = {
  schemaVersion: 1,
  kind: "podman",
  ownership: "current-user",
  uid: 1001,
  homeDir: "/home/tester",
  configHome: "/home/tester/.config",
  runtimeDir: "/run/user/1001",
  socketPath: "/run/user/1001/podman/podman.sock",
};

describe("resolveAgentCreateInput", () => {
  it("selects portable lifecycle ownership only for OpenClaw (#9068)", () => {
    const env = { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" };

    expect(resolveAgentCreateInput(null, true, env)).toMatchObject({
      persistStartupCommand: false,
      portableLifecycle: true,
    });
    expect(resolveAgentCreateInput({ name: "hermes" } as AgentDefinition, true, env)).toMatchObject(
      {
        persistStartupCommand: false,
        portableLifecycle: false,
        hermesPortableLifecycle: true,
      },
    );
    expect(resolvePortableLifecycleMode(null, env)).toBe(true);
    expect(resolvePortableLifecycleMode({ name: "hermes" } as AgentDefinition, env)).toBe(false);
  });
});

describe("resolveExportedPortableRuntimeAuthority", () => {
  it("passes checkpoint-owned authority to exported portable creation (#9070)", () => {
    expect(
      resolveExportedPortableRuntimeAuthority(
        { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" },
        () => ({
          checkpoint: {
            profile: { kind: "selected", value: "portable" },
            runtimeAuthority: { kind: "selected", value: PORTABLE_RUNTIME_AUTHORITY },
          },
        }),
      ),
    ).toEqual(PORTABLE_RUNTIME_AUTHORITY);
  });

  it("rejects exported portable creation before effects when authority is absent (#9070)", () => {
    expect(() =>
      resolveExportedPortableRuntimeAuthority(
        { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" },
        () => ({
          checkpoint: {
            profile: { kind: "selected", value: "portable" },
            runtimeAuthority: { kind: "unset" },
          },
        }),
      ),
    ).toThrow("requires checkpoint-owned Podman runtime authority before creation begins");
  });
});
