// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "../agent/defs";
import type { DockerUlimit } from "./docker-gpu-patch-types";

const DCODE_AGENT_NAME = "langchain-deepagents-code";

// DCode's managed entrypoint fails closed unless both limits are exact. When
// GPU compatibility already requires Docker recreation, set them on the new
// container as well. These overrides do not themselves require recreation.
export const DCODE_DOCKER_ULIMITS: readonly DockerUlimit[] = [
  { name: "nproc", soft: 512, hard: 512 },
  { name: "nofile", soft: 65_536, hard: 65_536 },
];

export function resolveDockerStartupCommandPatch(
  agent: AgentDefinition | null | undefined,
  dockerDriverGateway: boolean | null | undefined,
): {
  persistStartupCommand: boolean;
  requiredUlimits: readonly DockerUlimit[] | null;
} {
  if (dockerDriverGateway !== true) {
    return { persistStartupCommand: false, requiredUlimits: null };
  }
  const agentName = agent?.name ?? "openclaw";
  const requiredUlimits = agentName === DCODE_AGENT_NAME ? DCODE_DOCKER_ULIMITS : null;
  // OpenShell persists and relaunches its canonical process. Recreating the
  // container just to copy that command makes its planned exit terminal on
  // OpenShell 0.0.116. DCode's entrypoint, managed exec launcher, and login hooks
  // already apply the resource limits; DCode refuses to launch unless both
  // soft and hard limits match exactly. Keep the Docker overrides available
  // for independently selected GPU compatibility recreation.
  return { persistStartupCommand: false, requiredUlimits };
}
