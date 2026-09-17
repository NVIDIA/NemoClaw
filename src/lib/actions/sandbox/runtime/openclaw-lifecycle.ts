// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Keep OpenClaw restore consumers behind one edge to the process-recovery
// implementation, matching the agent-specific runtime facade in this folder.
export {
  abortOpenClawPostRestoreDoctor,
  abortUnregisteredOpenClawPostRestoreDoctor,
  beginOpenClawBackupQuiesce,
  beginOpenClawPostRestoreDoctor,
  beginUnregisteredOpenClawPostRestoreDoctor,
  finishOpenClawPostRestoreDoctor,
  finishUnregisteredOpenClawPostRestoreDoctor,
  releaseOpenClawPostRestoreDoctorForDelete,
  retireOpenClawPostRestoreDoctorForDelete,
} from "../process-recovery";
export type { OpenClawPostRestoreDoctorWindow } from "../process-recovery";
