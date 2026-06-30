// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface SandboxObservation {
  id?: string;
  status?: string;
}

export class SandboxClient {
  observeSandbox(): SandboxObservation {
    return {};
  }
}
