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
const DEFAULT_ENV: NodeJS.ProcessEnv = {};

const agent = (name: string) => ({ name }) as AgentDefinition;

describe("resolveDockerStartupCommandPatch", () => {
  it.each(["openclaw", "hermes", "langchain-deepagents-code"])(
    "keeps restart-safe persistence for %s on a default-profile docker-driver gateway",
    (name) => {
      expect(resolveDockerStartupCommandPatch(agent(name), true, DEFAULT_ENV)).toMatchObject({
        persistStartupCommand: true,
      });
    },
  );

  it.each(["openclaw", "hermes", "langchain-deepagents-code"])(
    "disables the Docker restart-safe recreation for %s under the portable profile (#9462)",
    (name) => {
      expect(resolveDockerStartupCommandPatch(agent(name), true, PORTABLE_ENV)).toMatchObject({
        persistStartupCommand: false,
      });
    },
  );

  it("keeps the DCode ulimit contract visible under the portable profile", () => {
    expect(
      resolveDockerStartupCommandPatch(agent("langchain-deepagents-code"), true, PORTABLE_ENV)
        .requiredUlimits,
    ).toEqual(DCODE_DOCKER_ULIMITS);
  });

  it("stays fully disabled off the docker-driver gateway regardless of profile", () => {
    expect(resolveDockerStartupCommandPatch(agent("hermes"), false, PORTABLE_ENV)).toEqual({
      persistStartupCommand: false,
      requiredUlimits: null,
    });
    expect(resolveDockerStartupCommandPatch(agent("hermes"), false, DEFAULT_ENV)).toEqual({
      persistStartupCommand: false,
      requiredUlimits: null,
    });
  });

  it("treats a missing agent as OpenClaw for the portable gate", () => {
    expect(resolveDockerStartupCommandPatch(null, true, PORTABLE_ENV)).toMatchObject({
      persistStartupCommand: false,
    });
    expect(resolveDockerStartupCommandPatch(null, true, DEFAULT_ENV)).toMatchObject({
      persistStartupCommand: true,
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
