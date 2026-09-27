// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Private complete native-state capture retained only through a stopped rebuild. */
export interface PreparedStoppedNativeState {
  readonly sandboxName: string;
  /** Complete extracted native home/workspace root. */
  readonly nativeDirectory: string;
  /** OpenClaw configuration root used by the bounded MCP reader. */
  readonly directory: string;
  readonly cleanupDirectory: string;
  assertCurrent(): void;
  dispose(): void;
}
