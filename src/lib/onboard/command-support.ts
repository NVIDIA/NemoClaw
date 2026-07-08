// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags } from "@oclif/core";
import { TOOL_DISCLOSURE_VALUES, type ToolDisclosure } from "../tool-disclosure";
import { describeAgentFlag } from "./agent-flag-help";
import { NOTICE_ACCEPT_FLAG, NOTICE_ACCEPT_FLAG_NAME } from "./usage-notice";

type AgentRegistryReader = () => readonly string[];

let agentRegistryReaderForTest: AgentRegistryReader | null = null;

export function setAgentRegistryReaderForTest(reader: AgentRegistryReader | null): void {
  agentRegistryReaderForTest = reader;
}

function readAgentRegistryNames(): readonly string[] {
  if (agentRegistryReaderForTest) return agentRegistryReaderForTest();
  const { listAgents } = require("../agent/defs") as typeof import("../agent/defs");
  return listAgents();
}

function prioritizeDefaultAgent(names: readonly string[]): string[] {
  return [...names].sort((left, right) => {
    if (left === "openclaw") return -1;
    if (right === "openclaw") return 1;
    return left.localeCompare(right);
  });
}

// Resolve the installed agent runtimes for the `--agent` help, falling back to
// the generic description if the agent registry can't be read (#5779). The
// agent registry is loaded lazily via require (not a top-level import) so this
// module — evaluated at command-class load via `static flags = ...` — does not
// pull the agent/defs -> runner chain into the module-linking graph, matching
// how other onboard modules consume agent/defs and avoiding a load cycle.
// Remove this fallback only after command-class load no longer crosses the
// agent/defs -> runner chain, or after the agent registry exposes a side-effect
// free metadata reader for command help.
function agentFlagDescription(): string {
  try {
    return describeAgentFlag(prioritizeDefaultAgent(readAgentRegistryNames()));
  } catch {
    return describeAgentFlag([]);
  }
}

export const onboardUsage = [
  `onboard [--non-interactive] [--resume | --fresh] [--recreate-sandbox] [--gpu | --no-gpu] [--from <Dockerfile>] [--name <sandbox>] [--sandbox-gpu | --no-sandbox-gpu] [--sandbox-gpu-device <device>] [--agent <name>] [--agents <agents.yaml>] [--tool-disclosure <progressive|direct>] [--observability | --no-observability] [--control-ui-port <N>] [--yes | -y] [--no-ollama-autostart] [${NOTICE_ACCEPT_FLAG}]`,
];

export const onboardExamples = [
  "<%= config.bin %> onboard",
  "<%= config.bin %> onboard --name alpha",
  "<%= config.bin %> onboard --resume",
  "<%= config.bin %> onboard --fresh",
  "<%= config.bin %> onboard --from ./Dockerfile --name alpha",
  "<%= config.bin %> onboard --agents ./agents.yaml",
  "<%= config.bin %> onboard --sandbox-gpu --sandbox-gpu-device nvidia.com/gpu=0",
  `<%= config.bin %> onboard --non-interactive --yes --name alpha ${NOTICE_ACCEPT_FLAG}`,
];

export type OnboardFlags = {
  "non-interactive"?: boolean;
  resume?: boolean;
  fresh?: boolean;
  "recreate-sandbox"?: boolean;
  gpu?: boolean;
  "no-gpu"?: boolean;
  from?: string;
  name?: string;
  "sandbox-gpu"?: boolean;
  "no-sandbox-gpu"?: boolean;
  "sandbox-gpu-device"?: string;
  agent?: string;
  agents?: string;
  "tool-disclosure"?: ToolDisclosure;
  observability?: boolean;
  "control-ui-port"?: number;
  yes?: boolean;
  "no-ollama-autostart"?: boolean;
  [NOTICE_ACCEPT_FLAG_NAME]?: boolean;
};

export function buildOnboardFlags(): Record<string, any> {
  return {
    "non-interactive": Flags.boolean({ description: "Run without interactive prompts" }),
    resume: Flags.boolean({
      description: "Resume an interrupted onboarding session",
      exclusive: ["fresh"],
    }),
    fresh: Flags.boolean({
      description: "Ignore any saved onboarding session",
      exclusive: ["resume"],
    }),
    "recreate-sandbox": Flags.boolean({ description: "Delete and recreate an existing sandbox" }),
    gpu: Flags.boolean({
      description: "Require OpenShell GPU passthrough for the gateway and sandbox",
      exclusive: ["no-gpu", "no-sandbox-gpu"],
    }),
    "no-gpu": Flags.boolean({
      description: "Disable GPU passthrough even when an NVIDIA GPU is detected",
      exclusive: ["gpu", "sandbox-gpu"],
    }),
    from: Flags.string({ description: "Path to a Dockerfile to use as the sandbox image source" }),
    name: Flags.string({ description: "Sandbox name" }),
    "sandbox-gpu": Flags.boolean({
      description: "Enable direct NVIDIA GPU access inside the sandbox",
      exclusive: ["no-gpu", "no-sandbox-gpu"],
    }),
    "no-sandbox-gpu": Flags.boolean({
      description:
        "Force CPU sandbox behavior (equivalent to NEMOCLAW_SANDBOX_GPU=0; alternative to --no-gpu when Docker Desktop WSL CDI injection fails)",
      exclusive: ["gpu", "sandbox-gpu"],
    }),
    "sandbox-gpu-device": Flags.string({
      description:
        "OpenShell GPU device selector to pass to sandbox create; requires --sandbox-gpu",
      dependsOn: ["sandbox-gpu"],
    }),
    agent: Flags.string({ description: agentFlagDescription() }),
    agents: Flags.string({
      description:
        "Path to a YAML manifest declaring secondary OpenClaw agents, agents.defaults, and main-agent overrides; baked into the sandbox image",
    }),
    "tool-disclosure": Flags.string({
      description:
        "Choose progressive tool discovery or direct exposure of all session-authorized tools",
      options: [...TOOL_DISCLOSURE_VALUES],
    }),
    observability: Flags.boolean({
      allowNo: true,
      description:
        "Export bounded prompt, response, tool argument, and tool result content to a local OTLP collector (Deep Agents Code only)",
    }),
    "control-ui-port": Flags.integer({
      description: "Host port for the local control UI",
      max: 65535,
      min: 1024,
    }),
    yes: Flags.boolean({
      char: "y",
      description: "Auto-confirm prompts that are safe for unattended onboarding",
    }),
    "no-ollama-autostart": Flags.boolean({
      description:
        "Skip the wizard's eager Ollama auto-start during inference-provider selection so onboard surfaces the unreachable-Ollama warning and the default fallback model; later setup steps still expect a reachable Ollama, and on Linux/systemd hosts the loopback-override path may still restart the daemon",
    }),
    [NOTICE_ACCEPT_FLAG_NAME]: Flags.boolean({
      description: "Accept the third-party software notice",
    }),
  } as Record<string, any>;
}
