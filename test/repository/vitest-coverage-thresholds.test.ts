// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import rootVitestConfig from "../vitest.config";
import {
  resolveVitestCoverageThresholds,
  securityCoverageThresholds,
} from "../helpers/vitest-coverage-thresholds";

type RootTestOptions = {
  coverage?: {
    thresholds?: unknown;
  };
};

describe("Vitest security coverage thresholds", () => {
  it.each([
    ["inline", ["--coverage", "--shard=1/8"]],
    ["separate", ["--coverage", "--shard", "1/8"]],
  ])("defers security floors until %s shard reports are merged (#6692)", (_syntax, argv) => {
    expect(resolveVitestCoverageThresholds(argv)).toBeUndefined();
  });
});
