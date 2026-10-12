// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import type { WebSearchProviderProfileId } from "../../inference/web-search/provider-profile";

export function webSearchProviderProfilePath(
  root: string,
  provider: WebSearchProviderProfileId,
): string {
  return path.join(root, "nemoclaw-blueprint", "provider-profiles", `${provider}.yaml`);
}
