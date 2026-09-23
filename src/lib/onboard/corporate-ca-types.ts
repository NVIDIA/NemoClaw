// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface ResolvedCorporateCa {
  /** Validated PEM text of the corporate CA bundle. */
  pem: string;
  /** Absolute-or-relative path the CA was read from. */
  sourcePath: string;
  /** Env var or source label the path came from. */
  sourceEnv: string;
}

export class CorporateCaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorporateCaValidationError";
  }
}
