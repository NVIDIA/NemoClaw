// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Render an observability flag only when the operator explicitly requested that state. */
export function explicitObservabilityFlag(
  enabled: boolean,
  requestedExplicitly: boolean,
): "--observability" | "--no-observability" | null {
  if (!requestedExplicitly) return null;
  return enabled ? "--observability" : "--no-observability";
}
