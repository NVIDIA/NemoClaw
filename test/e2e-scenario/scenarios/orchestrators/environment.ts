// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { PhaseOrchestrator } from "./phase.ts";

export class EnvironmentOrchestrator extends PhaseOrchestrator {
  constructor() {
    super("environment");
  }
}
