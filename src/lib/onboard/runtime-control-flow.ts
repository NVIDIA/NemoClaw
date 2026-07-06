// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Session } from "../state/onboard-session";
import { isDcodeAgent } from "./observability-policy-presets";
import { applyOnboardToolDisclosureRequest } from "./tool-disclosure-flow";
import type { OnboardOptions } from "./types";

export interface RuntimeControlAgentDeps {
  error(message: string): void;
  exitProcess(code: number): never;
}

export function applyOnboardRuntimeControlRequests(
  opts: Pick<OnboardOptions, "toolDisclosure" | "observabilityEnabled">,
) {
  return {
    requestedToolDisclosure: applyOnboardToolDisclosureRequest(opts.toolDisclosure),
    requestedObservabilityEnabled:
      typeof opts.observabilityEnabled === "boolean" ? opts.observabilityEnabled : null,
  };
}

export function updateSessionAgent(
  session: Session,
  agentName: string | null | undefined,
  deps: RuntimeControlAgentDeps = {
    error: console.error,
    exitProcess: (code) => process.exit(code),
  },
): Session {
  session.agent = agentName ?? null;
  if (session.observabilityEnabled && !isDcodeAgent(agentName)) {
    deps.error("  --observability is supported only with --agent langchain-deepagents-code.");
    deps.exitProcess(1);
  }
  return session;
}
