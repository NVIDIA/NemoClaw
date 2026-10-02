// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export class GatewayStateConflictError extends Error {
  readonly hasRecoveryGuidance: boolean;

  constructor(message: string, options: { hasRecoveryGuidance?: boolean } = {}) {
    super(message);
    this.name = "GatewayStateConflictError";
    this.hasRecoveryGuidance = options.hasRecoveryGuidance === true;
  }
}
