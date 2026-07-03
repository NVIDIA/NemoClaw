// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Older NemoClaw builds created internal OpenClaw sessions while warming up
// onboarding. Keep filtering that legacy prefix from default user-facing
// list/export-all output; explicit session-key export remains allowed for
// debugging existing sandboxes.
export const WARMUP_SESSION_ID_PREFIX = "nemoclaw-onboard-warmup-";

export function isWarmupSessionId(sessionId: string): boolean {
  return sessionId.startsWith(WARMUP_SESSION_ID_PREFIX);
}
