// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";

import { parseCheckedInProviderProfileContract } from "../../adapters/openshell/provider-profile";
import { parseOpenShellPolicy } from "../../adapters/openshell/policy-boundary";
import { NVIDIA_HOSTED_NATIVE_PROFILE_ID } from "./contract";
import { nativeNvidiaProviderProfilePath } from "./index";

const NATIVE_NVIDIA_INFERENCE_POLICY_KEY = "native_nvidia_inference";

/** Keep native access scoped to the same checked-in profile that owns its credential. */
export function buildNativeNvidiaSandboxPolicy(basePolicy: string): string {
  const parsed = { ...parseOpenShellPolicy(basePolicy).policy };
  const profile = parseCheckedInProviderProfileContract(
    fs.readFileSync(nativeNvidiaProviderProfilePath(), "utf8"),
  );
  if (
    !profile ||
    profile.profileId !== NVIDIA_HOSTED_NATIVE_PROFILE_ID ||
    !profile.boundary.inference_capable
  ) {
    throw new Error(
      "Cannot prepare native NVIDIA access; the checked-in provider profile is invalid.",
    );
  }
  const entry = {
    name: NATIVE_NVIDIA_INFERENCE_POLICY_KEY,
    endpoints: profile.boundary.endpoints,
    binaries: profile.boundary.binaries.map((path) => ({ path })),
  };
  const networkPolicies = parsed.network_policies ?? {};
  const existing = networkPolicies[NATIVE_NVIDIA_INFERENCE_POLICY_KEY];
  if (existing !== undefined && !isDeepStrictEqual(existing, entry)) {
    throw new Error(
      "Cannot prepare native NVIDIA access; the existing native inference policy conflicts with the selected provider profile.",
    );
  }
  if (existing !== undefined) return basePolicy;
  parsed.network_policies = { ...networkPolicies, [NATIVE_NVIDIA_INFERENCE_POLICY_KEY]: entry };
  return YAML.stringify(parsed);
}
