// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Internal capture capability; never populated from command arguments or a persisted manifest. */
export interface CapturedAgentState {
  readonly sandboxName: string;
  readonly agentName: "openclaw" | "langchain-deepagents-code";
  /** Agent configuration root used by the bounded MCP reader. */
  readonly directory: string;
  assertCurrent(): void;
}

/** Private complete native-state capture retained only through a stopped rebuild. */
export interface PreparedStoppedNativeState extends CapturedAgentState {
  /** Complete extracted native home/workspace root. */
  readonly nativeDirectory: string;
  readonly cleanupDirectory: string;
  dispose(): void;
}
