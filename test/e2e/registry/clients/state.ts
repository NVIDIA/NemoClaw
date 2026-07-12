// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface StateObservation {
  path?: string;
  exists?: boolean;
}

export class StateClient {
  observeState(): StateObservation {
    return {};
  }
}
