// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { isDecisionSelected } from "../state/onboard-checkpoint-decision";
import {
  hasInvalidSessionHostMounts,
  hasInvalidSessionToolDisclosure,
} from "../state/onboard-session";
import type { SandboxHostMount } from "../state/registry/types";
import { normalizeToolDisclosure, type ToolDisclosure } from "../tool-disclosure";
import { preflightVllmModelEnvOrExit } from "./vllm-model-preflight";

const onboardProviders = require("./providers");

export interface ResumeSessionLike {
  sandboxName?: string | null;
  provider?: string | null;
  model?: string | null;
  vllmInstallModel?: string | null;
  agent?: string | null;
  toolDisclosure?: ToolDisclosure;
  observabilityEnabled?: boolean;
  metadata?: { fromDockerfile?: string | null; hostMounts?: SandboxHostMount[] } | null;
  steps?: { sandbox?: { status?: string | null } | null } | null;
  checkpoint?: {
    sandboxIdentity?: import("../state/onboard-checkpoint-types").CheckpointDecision<
      import("../state/onboard-checkpoint-types").CheckpointSandboxIdentity
    >;
  } | null;
}

export interface ResumeConfigConflict {
  field: string;
  requested: string | null;
  recorded: string | null;
}

function canonicalHostMounts(mounts: readonly SandboxHostMount[] | undefined): string {
  return JSON.stringify(
    (mounts ?? [])
      .map(({ source, target }) => ({ source, target, readOnly: true as const }))
      .sort((left, right) => {
        const leftKey = `${left.source}\0${left.target}`;
        const rightKey = `${right.source}\0${right.target}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      }),
  );
}

export function getRequestedSandboxNameHint(
  opts: { sandboxName?: string | null } = {},
): string | null {
  const raw =
    typeof opts.sandboxName === "string" && opts.sandboxName.length > 0
      ? opts.sandboxName
      : process.env.NEMOCLAW_SANDBOX_NAME;
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  return normalized || null;
}

export function getResumeSandboxConflict(
  session: ResumeSessionLike | null,
  opts: { sandboxName?: string | null } = {},
): { requestedSandboxName: string; recordedSandboxName: string } | null {
  // Use opts.sandboxName as the sole source — the caller has already
  // resolved it (--name first, NEMOCLAW_SANDBOX_NAME only when prompting
  // is impossible). Falling back to the env var here would fire spurious
  // conflicts for interactive resume runs whose shell happens to export
  // NEMOCLAW_SANDBOX_NAME but which never actually consult it.
  // #2753: only treat session.sandboxName as a conflict source if the
  // sandbox step actually completed. A pre-fix incomplete session would
  // otherwise reject a legitimate `--resume --name <new>` that the user
  // is supplying precisely to recover from the phantom.
  const raw = typeof opts.sandboxName === "string" ? opts.sandboxName.trim().toLowerCase() : "";
  const requestedSandboxName = raw || null;
  const checkpointIdentity = session?.checkpoint?.sandboxIdentity;
  const checkpointedSandboxName =
    checkpointIdentity && isDecisionSelected(checkpointIdentity)
      ? checkpointIdentity.value.name
      : null;
  const recordedSandboxName =
    checkpointedSandboxName ??
    (session?.steps?.sandbox?.status === "complete" ? (session?.sandboxName ?? null) : null);
  if (!requestedSandboxName || !recordedSandboxName) {
    return null;
  }
  return requestedSandboxName !== recordedSandboxName
    ? { requestedSandboxName, recordedSandboxName }
    : null;
}

export function getRequestedProviderHint(
  nonInteractive = false,
  allowHostedInferenceStaging = true,
): string | null {
  return onboardProviders.getRequestedProviderHint(nonInteractive, allowHostedInferenceStaging);
}

/**
 * Run the up-front, side-effect-free env validations onboarding performs before
 * preflight: the NEMOCLAW_PROVIDER hint check and the NEMOCLAW_VLLM_MODEL
 * preflight (#5207). Either may exit the process with a non-zero code on an
 * invalid value.
 */
export function preflightEarlyOnboardEnv(
  nonInteractive = false,
  allowHostedInferenceStaging = true,
): string | null {
  const providerHint = getRequestedProviderHint(nonInteractive, allowHostedInferenceStaging);
  preflightVllmModelEnvOrExit();
  return providerHint;
}

export function preflightEarlyOnboardEnvForResume(
  nonInteractive: boolean,
  authoritativeResumeConfig: boolean,
): string | null {
  return preflightEarlyOnboardEnv(
    authoritativeResumeConfig ? nonInteractive : false,
    !authoritativeResumeConfig,
  );
}

export function getRequestedModelHint(
  nonInteractive = false,
  allowHostedInferenceStaging = true,
): string | null {
  return onboardProviders.getRequestedModelHint(nonInteractive, allowHostedInferenceStaging);
}

export function getResumeConfigConflicts(
  session: ResumeSessionLike | null,
  opts: {
    nonInteractive?: boolean;
    fromDockerfile?: string | null;
    sandboxName?: string | null;
    agent?: string | null;
    toolDisclosure?: ToolDisclosure | null;
    observabilityEnabled?: boolean | null;
    hostMounts?: readonly SandboxHostMount[];
    /**
     * Internal rebuild-resume mode: the caller already rewrote the session from
     * validated registry state, so credential aliases must not synthesize a new
     * provider/model request while checking that session for conflicts.
     */
    authoritativeResumeConfig?: boolean;
  } = {},
): ResumeConfigConflict[] {
  const conflicts: ResumeConfigConflict[] = [];
  const nonInteractive = opts.nonInteractive ?? false;
  const allowHostedInferenceStaging = opts.authoritativeResumeConfig !== true;

  const sandboxConflict = getResumeSandboxConflict(session, { sandboxName: opts.sandboxName });
  if (sandboxConflict) {
    conflicts.push({
      field: "sandbox",
      requested: sandboxConflict.requestedSandboxName,
      recorded: sandboxConflict.recordedSandboxName,
    });
  }

  const requestedProvider = getRequestedProviderHint(nonInteractive, allowHostedInferenceStaging);
  const effectiveRequestedProvider =
    session?.vllmInstallModel && requestedProvider === "install-vllm"
      ? "vllm-local"
      : onboardProviders.getEffectiveProviderName(requestedProvider);
  const recordedProvider = session?.vllmInstallModel ? "vllm-local" : session?.provider;
  if (
    effectiveRequestedProvider &&
    recordedProvider &&
    effectiveRequestedProvider !== recordedProvider
  ) {
    conflicts.push({
      field: "provider",
      requested: effectiveRequestedProvider,
      recorded: recordedProvider,
    });
  }

  const requestedVllmModel = String(process.env.NEMOCLAW_VLLM_MODEL ?? "").trim();
  const requestedModel =
    session?.vllmInstallModel && requestedVllmModel
      ? requestedVllmModel
      : getRequestedModelHint(nonInteractive, allowHostedInferenceStaging);
  const recordedModel = session?.vllmInstallModel ?? session?.model;
  if (
    requestedModel &&
    recordedModel &&
    requestedModel.toLowerCase() !== recordedModel.toLowerCase()
  ) {
    conflicts.push({
      field: "model",
      requested: requestedModel,
      recorded: recordedModel,
    });
  }

  const requestedFrom = opts.fromDockerfile ? path.resolve(opts.fromDockerfile) : null;
  const recordedFrom = session?.metadata?.fromDockerfile
    ? path.resolve(session.metadata.fromDockerfile)
    : null;
  if (requestedFrom !== recordedFrom) {
    conflicts.push({
      field: "fromDockerfile",
      requested: requestedFrom,
      recorded: recordedFrom,
    });
  }

  const requestedHostMounts =
    opts.hostMounts === undefined ? null : canonicalHostMounts(opts.hostMounts);
  const recordedHostMounts = canonicalHostMounts(session?.metadata?.hostMounts);
  if (hasInvalidSessionHostMounts(session)) {
    conflicts.push({ field: "host mounts", requested: requestedHostMounts, recorded: "invalid" });
  } else if (requestedHostMounts !== null && requestedHostMounts !== recordedHostMounts) {
    conflicts.push({
      field: "host mounts",
      requested: requestedHostMounts,
      recorded: recordedHostMounts,
    });
  }

  const requestedToolDisclosure = normalizeToolDisclosure(opts.toolDisclosure);
  const recordedToolDisclosure = normalizeToolDisclosure(session?.toolDisclosure);
  if (hasInvalidSessionToolDisclosure(session)) {
    conflicts.push({
      field: "tool disclosure",
      requested: requestedToolDisclosure,
      recorded: "invalid",
    });
  } else if (
    requestedToolDisclosure &&
    recordedToolDisclosure &&
    requestedToolDisclosure !== recordedToolDisclosure
  ) {
    conflicts.push({
      field: "tool disclosure",
      requested: requestedToolDisclosure,
      recorded: recordedToolDisclosure,
    });
  }

  return conflicts;
}
