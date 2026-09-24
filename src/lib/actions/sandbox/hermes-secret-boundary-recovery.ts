// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Legacy result reasons retained while callers remove stored recovery records. */
export type SecretBoundaryRefusalReason =
  | "raw-secret"
  | "exec-failed"
  | "validator-missing"
  | "unexpected-marker"
  | "agent-missing";
