// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export { openRegularFileNoFollow } from "../../adapters/fs/regular-file";
export { reclaimLockFileGenerationSync } from "../lock-generation/storage";
export {
  classifyOnboardLockContents,
  createOnboardLockRecord,
  MAX_ONBOARD_LOCK_BYTES,
  type OnboardLockIdentityProbes,
  type OnboardLockDisposition,
  type OnboardLockRecord,
} from "./lock-holder";
export * from "./retained-sandbox-recovery";
