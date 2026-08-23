// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  CheckpointOnboardProfile,
  CheckpointPortableRuntimeAuthority,
  OnboardCheckpoint,
} from "../../state/onboard-checkpoint-types";
import { requireReadOnlyHostMountRuntimeSupport } from "../host-mount";
import {
  assertLockedResumeIntentSnapshot,
  createDefaultResumeProfileEnvironmentScope,
  createPortableOnboardEnvironmentScope,
  preparePortableExperimentalHost,
  type PortableOnboardEnvironmentScope,
  type PortableOnboardRuntimeContext,
} from "../session-bootstrap";
import type { OnboardOptions } from "../types";
import { ensureUsageNoticeConsent } from "../usage-notice";

export interface LockedOnboardRuntimePreparation {
  readonly checkpointProfile: CheckpointOnboardProfile;
  readonly environmentScope: PortableOnboardEnvironmentScope | null;
  readonly portableRuntimeContext: PortableOnboardRuntimeContext | null;
}

async function ensureNoticeAccepted(
  options: OnboardOptions,
  nonInteractive: boolean,
): Promise<void> {
  const accepted = await ensureUsageNoticeConsent({
    nonInteractive,
    acceptedByFlag: options.acceptThirdPartySoftware === true,
    writeLine: console.error,
  });
  if (!accepted) process.exit(1);
}

function resolveCheckpointProfile(
  options: OnboardOptions,
  resume: boolean,
  loadSession: () => { readonly checkpoint?: OnboardCheckpoint | null } | null,
): {
  checkpointProfile: CheckpointOnboardProfile;
  expectedPortableAuthority: CheckpointPortableRuntimeAuthority | null;
} {
  if (resume && options.resumeIntentSnapshot) {
    assertLockedResumeIntentSnapshot(options.resumeIntentSnapshot);
  }
  const storedCheckpoint = (resume ? loadSession() : null)?.checkpoint ?? null;
  if (resume && !storedCheckpoint) {
    throw new Error(
      "This onboarding checkpoint predates recorded runtime authority and cannot be resumed safely. Start a new onboarding attempt with the `--fresh` option.",
    );
  }
  const checkpointProfile =
    storedCheckpoint?.profile.value ??
    (options.experimentalProfile === "portable" ? "portable" : "default");
  if (
    resume &&
    options.experimentalProfile !== null &&
    options.experimentalProfile !== undefined &&
    options.experimentalProfile !== checkpointProfile
  ) {
    throw new Error(
      `The requested onboarding profile '${options.experimentalProfile}' does not match checkpoint profile '${checkpointProfile}'.`,
    );
  }
  const expectedPortableAuthority =
    storedCheckpoint?.runtimeAuthority.kind === "selected"
      ? storedCheckpoint.runtimeAuthority.value
      : null;
  if (resume && checkpointProfile === "portable" && !expectedPortableAuthority) {
    throw new Error(
      "Portable onboarding resume requires recorded runtime authority. Start a new onboarding attempt with the `--fresh` option.",
    );
  }
  if (resume && checkpointProfile === "portable" && !options.resumeIntentSnapshot) {
    throw new Error("Portable onboarding resume requires a validated checkpoint snapshot.");
  }
  return { checkpointProfile, expectedPortableAuthority };
}

function prepareEnvironment(
  options: OnboardOptions,
  resume: boolean,
  checkpointProfile: CheckpointOnboardProfile,
  expectedPortableAuthority: CheckpointPortableRuntimeAuthority | null,
): {
  environmentScope: PortableOnboardEnvironmentScope | null;
  portableRuntimeContext: PortableOnboardRuntimeContext | null;
} {
  if (checkpointProfile !== "portable") {
    return {
      environmentScope: resume ? createDefaultResumeProfileEnvironmentScope(process.env) : null,
      portableRuntimeContext: null,
    };
  }
  const environmentScope = createPortableOnboardEnvironmentScope(
    process.env,
    options.portableInferenceActivation ?? null,
    { resume },
  );
  try {
    const prepared = (options.preparePortableHost ?? preparePortableExperimentalHost)(
      process.env,
      {},
      expectedPortableAuthority,
    );
    if (!prepared) throw new Error("Portable runtime preparation did not run.");
    environmentScope.installRuntime({
      containersConf: prepared.containersConf,
      socketPath: prepared.authority.socketPath,
    });
    return {
      environmentScope,
      portableRuntimeContext: { authority: prepared.authority, environmentScope },
    };
  } catch (error) {
    environmentScope.restore();
    throw error;
  }
}

export async function prepare(
  options: OnboardOptions,
  resume: boolean,
  nonInteractive: boolean,
  loadSession: () => {
    readonly checkpoint?: OnboardCheckpoint | null;
    readonly metadata?: { readonly hostMounts?: OnboardOptions["hostMounts"] };
  } | null,
): Promise<LockedOnboardRuntimePreparation> {
  const storedSession = resume ? loadSession() : null;
  const { checkpointProfile, expectedPortableAuthority } = resolveCheckpointProfile(
    options,
    resume,
    () => storedSession,
  );
  requireReadOnlyHostMountRuntimeSupport(
    options.hostMounts?.length ? options.hostMounts : storedSession?.metadata?.hostMounts,
    { experimentalProfile: checkpointProfile === "portable" ? "portable" : null },
  );
  let environmentScope: PortableOnboardEnvironmentScope | null = null;
  try {
    // Fresh runs obtain consent before bounded host preparation writes. Resumes
    // requalify recorded authority first, before any other write.
    if (!resume) await ensureNoticeAccepted(options, nonInteractive);
    const prepared = prepareEnvironment(
      options,
      resume,
      checkpointProfile,
      expectedPortableAuthority,
    );
    environmentScope = prepared.environmentScope;
    if (resume) await ensureNoticeAccepted(options, nonInteractive);
    return { checkpointProfile, ...prepared };
  } catch (error) {
    environmentScope?.restore();
    throw error;
  }
}
