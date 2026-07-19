// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HostAssessment } from "../../../onboard/preflight";
import type { Advisory, AdvisoryCheck } from "../../types";

export function hostAdvisory(
  check: AdvisoryCheck<HostAssessment>,
  details: Omit<Advisory, "id" | "phase" | "severity" | "resumeSafe">,
): Advisory {
  return {
    id: check.id,
    phase: check.phase,
    severity: check.severity,
    resumeSafe: check.resumeSafe,
    ...details,
  };
}
