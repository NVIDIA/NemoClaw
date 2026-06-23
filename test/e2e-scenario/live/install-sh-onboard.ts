// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical install.sh arguments for live Vitest scenarios that auto-onboard.
 *
 * Live scenario retries must not inherit a failed persisted onboarding session
 * from an earlier failed attempt. `--fresh` makes install.sh bypass the failed
 * session classifier and lets the CLI clear stale session state before creating
 * the new session.
 */
export function installShOnboardArgs(): string[] {
  return ["install.sh", "--non-interactive", "--yes-i-accept-third-party-software", "--fresh"];
}
