// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const LIFECYCLE_PROFILES = ["post-reboot-recovery", "dcode-rebuild-invalid-credential"] as const;
export type LifecycleProfile = (typeof LIFECYCLE_PROFILES)[number];

export function isLifecycleProfile(value: string | undefined): value is LifecycleProfile {
  return LIFECYCLE_PROFILES.some((profile) => profile === value);
}
