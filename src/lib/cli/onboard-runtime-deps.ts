// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OnboardActionRuntimeDeps } from "../actions/onboard";
import { createGooglechatTunnelRuntimeDeps } from "../messaging/channels/googlechat/hooks/runtime-deps";

export function createOnboardActionRuntimeDeps(): OnboardActionRuntimeDeps {
  return { googlechatTunnelRuntime: createGooglechatTunnelRuntimeDeps() };
}
