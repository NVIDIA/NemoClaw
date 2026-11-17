// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";
import { readYaml } from "../helpers/e2e-workflow-contract.ts";

type RegistrationWorkflow = {
  on: Record<string, unknown>;
  permissions: Record<string, unknown>;
  jobs: Record<string, { if?: string | boolean; environment?: unknown }>;
};

// source-shape-contract: security -- The default-branch registration must never allocate a runner or access a protected environment.
it("keeps default-branch SSH registration non-executing", () => {
  const workflow = readYaml<RegistrationWorkflow>(".github/workflows/colossus-connectivity.yml");
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  expect(workflow.on.workflow_dispatch ?? {}).toEqual({});
  expect(workflow.permissions).toEqual({});
  const jobs = Object.values(workflow.jobs);
  expect(jobs).toHaveLength(1);
  const job = jobs[0];
  const disabled = job?.if === false || /^\$\{\{\s*false\s*\}\}$/u.test(String(job?.if));
  expect(disabled, "registration must be unconditionally skipped").toBe(true);
  expect(job?.environment).toBeUndefined();
});
