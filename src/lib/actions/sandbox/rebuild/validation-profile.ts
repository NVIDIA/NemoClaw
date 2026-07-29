// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  cloneDcodeValidationProfile,
  DCODE_VALIDATION_PROFILE_DISABLED,
  type DcodeValidationProfile,
  loadDcodeValidationProfile,
} from "../../../onboard/dcode/validation-profile";
import type { SandboxEntry } from "../../../state/registry/types";
import { DCODE_AGENT_NAME } from "../rebuild-dcode-target";

export function resolveDcodeValidationProfileForRebuild(
  sandboxName: string,
  requested: string | undefined,
  entry: Pick<SandboxEntry, "agent" | "dcodeValidationProfile">,
): DcodeValidationProfile | null {
  if (entry.agent !== DCODE_AGENT_NAME) {
    if (
      requested === DCODE_VALIDATION_PROFILE_DISABLED &&
      entry.dcodeValidationProfile !== undefined
    ) {
      return null;
    }
    if (requested === undefined && entry.dcodeValidationProfile === undefined) return null;
    throw new Error(
      "--dcode-validation-profile is supported only for managed LangChain Deep Agents Code sandboxes.",
    );
  }
  if (requested === DCODE_VALIDATION_PROFILE_DISABLED) return null;
  if (requested) return loadDcodeValidationProfile(requested, sandboxName);
  return cloneDcodeValidationProfile(entry.dcodeValidationProfile, sandboxName) ?? null;
}
