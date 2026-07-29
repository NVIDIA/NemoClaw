// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Keep status's process inspection and recovery consumers behind one edge to
// the lifecycle module. This preserves the source-architecture fan-in budget
// while both text rendering and snapshot collection share the same guarded
// recovery implementation.
export {
  checkAndRecoverSandboxProcesses,
  isSandboxGatewayRunningForStatus,
} from "../process-recovery";
