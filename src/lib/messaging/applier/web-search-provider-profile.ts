// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import {
  TAVILY_POLICY_BINDING_PROVIDER_PROFILE_ID,
  type WebSearchProviderProfileId,
} from "../../inference/web-search/provider-profile";

export function webSearchProviderProfilePath(
  root: string,
  provider: WebSearchProviderProfileId,
): string {
  const directory =
    provider === TAVILY_POLICY_BINDING_PROVIDER_PROFILE_ID
      ? path.join(root, "managed-inference", "provider-profiles")
      : path.join(root, "nemoclaw-blueprint", "provider-profiles");
  return path.join(directory, `${provider}.yaml`);
}
