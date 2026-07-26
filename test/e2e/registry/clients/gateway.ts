// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface GatewayObservation {
  reachable: boolean | null;
  status?: string;
}

export class GatewayClient {
  observeHealth(): GatewayObservation {
    return { reachable: null };
  }
}
