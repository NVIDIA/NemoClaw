// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function isOnboardAutoYesNonInteractive(
  autoYes: boolean,
  resume: boolean,
  terminal: { stdinIsTty: boolean; stdoutIsTty: boolean },
): boolean {
  return autoYes && resume && !terminal.stdinIsTty;
}
