// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const CURRENT_LIFECYCLE_PHASES = [
  "confirm Docker CLI and clear the current plugin sandbox",
  "clone and prepare the current plugin fixture",
  "install and validate current OpenShell",
  "build and onboard plugin v1",
  "restart the gateway and confirm plugin v1",
  "recreate the sandbox with plugin v2",
  "prove cross-device runtime dependency replacement",
] as const;

export type WeatherFixtureVersion = "v1" | "v2";

type LifecycleCommand = {
  command: "node";
  args: string[];
};

export function currentLifecycleCommands(input: {
  cliEntrypoint: string;
  dockerfilePath: string;
  sandboxName: string;
}): {
  onboard: LifecycleCommand;
  recreate: LifecycleCommand;
  restart: LifecycleCommand;
} {
  return {
    onboard: {
      command: "node",
      args: [
        input.cliEntrypoint,
        "onboard",
        "--fresh",
        "--non-interactive",
        "--yes-i-accept-third-party-software",
        "--agent",
        "openclaw",
        "--from",
        input.dockerfilePath,
      ],
    },
    recreate: {
      command: "node",
      args: [
        input.cliEntrypoint,
        "onboard",
        "--fresh",
        "--recreate-sandbox",
        "--non-interactive",
        "--yes",
        "--yes-i-accept-third-party-software",
        "--name",
        input.sandboxName,
        "--agent",
        "openclaw",
        "--from",
        input.dockerfilePath,
      ],
    },
    restart: {
      command: "node",
      args: [input.cliEntrypoint, input.sandboxName, "gateway", "restart"],
    },
  };
}
