// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isWebSearchEnabled } from "../inference/web-search";

/**
 * Single source of truth for "the user opted in to Brave Search at runtime."
 * Returning true on a config whose `fetchEnabled` is false would cause
 * `createSandbox` to push a Brave provider/token and trip the BRAVE_API_KEY-
 * required abort even when the feature is off, while the downstream
 * finalization/verifier paths already gate on `fetchEnabled`. Keep every gate
 * routed through this helper so they stay aligned.
 */
export function shouldEnableWebSearch(
  webSearchConfig: { fetchEnabled?: boolean | null } | null | undefined,
): boolean {
  return isWebSearchEnabled(webSearchConfig as { fetchEnabled: boolean } | null | undefined);
}
