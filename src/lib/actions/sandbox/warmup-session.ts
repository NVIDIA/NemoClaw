// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// NemoClaw's onboarding scope-upgrade warm-up currently runs through
// OpenClaw as a normal in-sandbox session. Until OpenClaw can pre-approve the
// full scope set or mark/prevent this internal session at the source, tag it
// with this prefix and hide it from default user-facing list/export-all output.
// Explicit session-key export remains allowed for debugging.
export const WARMUP_SESSION_ID_PREFIX = "nemoclaw-onboard-warmup-";

export function isWarmupSessionId(sessionId: string): boolean {
  return sessionId.startsWith(WARMUP_SESSION_ID_PREFIX);
}
