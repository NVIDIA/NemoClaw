// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellGatewayTarget } from "./sandbox-observer";

export type OpenShellSandboxTransferRequest = Readonly<{
  direction: "upload" | "download";
  sandboxName: string;
  target: OpenShellGatewayTarget;
  source: string;
  destination: string;
}>;

export type OpenShellSandboxTransferOutcome =
  | Readonly<{ kind: "completed"; exitCode: number }>
  | Readonly<{
      kind: "failed";
      reason: "invalid_request" | "unavailable" | "invocation" | "interrupted" | "indeterminate";
    }>;

export type OpenShellSandboxTransferCompletion = Readonly<{
  /** Command completion does not verify the artifact or publish a download. */
  outcome: OpenShellSandboxTransferOutcome;
  /** Includes interruption during the caller's post-transfer verification. */
  wasInterrupted: () => boolean;
  /** Release only after artifact cleanup and the outer lifecycle lock settle. */
  release: () => void;
}>;

export interface OpenShellSandboxTransferExecutor {
  run(request: OpenShellSandboxTransferRequest): Promise<OpenShellSandboxTransferCompletion>;
}
