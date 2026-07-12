// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface ProviderObservation {
  provider?: string;
  reachable?: boolean;
}

export class ProviderClient {
  observeProvider(): ProviderObservation {
    return {};
  }
}
