// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RebuildBail } from "../rebuild-credential-preflight";
export type { RebuildBail, RebuildLog } from "../rebuild-credential-preflight";
export { printRebuildPreflightFailure } from "../rebuild-preflight-error";
export { redactBoundedRebuildTerminalDiagnostic } from "../rebuild-preflight-confirmation";

export class DeferredRebuildCliExit extends Error {
  constructor(
    message: string,
    readonly code: number | undefined,
    readonly exit: RebuildBail,
  ) {
    super(message);
  }
}
