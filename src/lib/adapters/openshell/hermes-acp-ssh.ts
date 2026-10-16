// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Readable, Writable } from "node:stream";

export const HERMES_ACP_EXECUTABLE = "/usr/local/bin/hermes-acp";

export type HermesAcpSshFailureKind =
  | "cancelled"
  | "cleanup"
  | "client_disconnect"
  | "incompatible"
  | "invocation"
  | "timeout"
  | "transport"
  | "unavailable";

export type HermesAcpSshCleanupError = Readonly<{
  kind: "cleanup";
  message: string;
}>;

export type HermesAcpSshOutcome = Readonly<
  (
    | { kind: "completed"; exitCode: number; signal?: NodeJS.Signals | null }
    | {
        kind: "failed";
        error: Readonly<{
          kind: HermesAcpSshFailureKind;
          message: string;
        }>;
        exitCode: number;
      }
  ) & { cleanupError?: HermesAcpSshCleanupError }
>;

export type HermesAcpSshRequest = Readonly<{
  gatewayName: string;
  sandboxName: string;
  streams: Readonly<{
    input: Readable;
    output: Writable;
    diagnostics: Writable;
  }>;
  /** Release the host lifecycle fence after the remote adapter process starts. */
  onSessionStarted?: () => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}>;

/** Typed duplex SSH capability used only by the packaged Hermes ACP adapter. */
export interface HermesAcpSshTransport {
  run(request: HermesAcpSshRequest): Promise<HermesAcpSshOutcome>;
}
