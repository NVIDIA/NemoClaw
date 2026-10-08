// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { COVERAGE_KEY, disableSourceCoverage, resetSourceCoverage } from "./source-coverage.cts";

export default {
  startCoverage: resetSourceCoverage,
  takeCoverage() {
    const coverage = structuredClone(globalThis[COVERAGE_KEY] ?? {});
    resetSourceCoverage();
    return coverage;
  },
  stopCoverage: disableSourceCoverage,
  async getProvider() {
    const { SourceCoverageProvider } = await import("./source-coverage-report.mts");
    return new SourceCoverageProvider();
  },
};
