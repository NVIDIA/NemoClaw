// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { AgentDefinition } from "../agent/defs";
import {
  DCODE_DOCKER_ULIMITS,
  resolveDockerStartupCommandPatch,
} from "./docker-startup-command-agent";
import { resolveAgentCreateInput } from "./sandbox-gpu-create-flow";

const PORTABLE_ENV: NodeJS.ProcessEnv = { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" };

const agent = (name: string) => ({ name }) as AgentDefinition;

describe("resolveDockerStartupCommandPatch", () => {
  it.each(["openclaw", "hermes", "langchain-deepagents-code"])(
    "uses OpenShell startup and retains only the required Docker limits for %s",
    (name) => {
      expect(resolveDockerStartupCommandPatch(agent(name), true)).toEqual({
        persistStartupCommand: false,
        requiredUlimits: name === "langchain-deepagents-code" ? DCODE_DOCKER_ULIMITS : null,
      });
    },
  );

  it.each([false, null, undefined])(
    "disables Docker overrides when the Docker gateway flag is %s",
    (flag) => {
      expect(resolveDockerStartupCommandPatch(agent("langchain-deepagents-code"), flag)).toEqual({
        persistStartupCommand: false,
        requiredUlimits: null,
      });
    },
  );

  it("treats a missing agent as OpenClaw", () => {
    expect(resolveDockerStartupCommandPatch(null, true)).toEqual({
      persistStartupCommand: false,
      requiredUlimits: null,
    });
  });
});

describe("resolveAgentCreateInput portable persistence", () => {
  it("keeps portable non-OpenClaw agents off the Docker recreation path (#9462)", () => {
    expect(resolveAgentCreateInput(agent("hermes"), true, PORTABLE_ENV)).toMatchObject({
      portableLifecycle: false,
      persistStartupCommand: false,
    });
    expect(
      resolveAgentCreateInput(agent("langchain-deepagents-code"), true, PORTABLE_ENV),
    ).toMatchObject({
      portableLifecycle: false,
      persistStartupCommand: false,
    });
  });
});
