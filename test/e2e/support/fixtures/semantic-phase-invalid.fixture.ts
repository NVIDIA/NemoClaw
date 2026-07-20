// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from "../../fixtures/e2e-test.ts";

const selectedPhase = "exercise fixture behavior";
const bodyExecutionError = "semantic phase rejection fixture body executed";

test("missing semantic phase metadata", () => {
  throw new Error(bodyExecutionError);
});

test("invalid semantic phase transitions", {
  meta: {
    e2ePhases: ["prepare fixture behavior", "exercise fixture behavior"],
  },
}, ({ progress }) => {
  progress.phase(selectedPhase);
  progress.phase("undeclared fixture behavior");
  progress.phase("exercise fixture behavior");
  throw new Error(bodyExecutionError);
});
