// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export { openRegularFileNoFollow } from "../../adapters/fs/regular-file";
export {
  classifyOnboardLockContents,
  createOnboardLockRecord,
  MAX_ONBOARD_LOCK_BYTES,
  type OnboardLockDisposition,
  type OnboardLockRecord,
} from "./lock-holder";
export { withOnboardLockReclamationGuard } from "./reclamation-guard";
export * from "./retained-sandbox-recovery";
