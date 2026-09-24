// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Keep OpenClaw restore consumers behind one edge to the process-recovery
// implementation, matching the agent-specific runtime facade in this folder.
import type { OpenShellRuntimeSelection } from "../../../adapters/openshell/runtime-selection";
import {
  beginOpenClawBackupQuiesce as beginOpenClawBackupQuiesceImpl,
  retireOpenClawPostRestoreDoctorForDelete as retireOpenClawPostRestoreDoctorForDeleteImpl,
  type OpenClawPostRestoreDoctorWindow,
} from "../process-recovery";

export {
  abortOpenClawPostRestoreDoctor,
  abortUnregisteredOpenClawPostRestoreDoctor,
  beginUnregisteredOpenClawBackupQuiesce,
  beginOpenClawPostRestoreDoctor,
  beginUnregisteredOpenClawPostRestoreDoctor,
  finishOpenClawPostRestoreDoctor,
  finishUnregisteredOpenClawPostRestoreDoctor,
  promoteUnregisteredOpenClawBackupQuiesceToPostRestoreDoctor,
  promoteOpenClawBackupQuiesceToPostRestoreDoctor,
  releaseOpenClawPostRestoreDoctorForDelete,
} from "../process-recovery";
export type { OpenClawPostRestoreDoctorWindow } from "../process-recovery";

export function beginOpenClawBackupQuiesce(
  sandboxName: string,
  runtimeSelection?: OpenShellRuntimeSelection,
) {
  return beginOpenClawBackupQuiesceImpl(sandboxName, runtimeSelection);
}

export function retireOpenClawPostRestoreDoctorForDelete(window: OpenClawPostRestoreDoctorWindow) {
  return retireOpenClawPostRestoreDoctorForDeleteImpl(window);
}
