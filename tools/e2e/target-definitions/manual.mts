// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ManualE2eTarget } from "../target-inventory.mts";

// Tests and their instructions retain prerequisite checks and resource ownership.
export const manualTargets: readonly ManualE2eTarget[] = [
  {
    id: "inference-routing-provider-smoke",
    tests: [
      {
        file: "test/e2e/live/inference-routing-provider-smoke.test.ts",
        project: "e2e-live",
      },
    ],
    instructions: "test/e2e/live/inference-routing-provider-smoke.test.ts",
  },
  {
    id: "issue-4434-tui-unreachable-inference",
    tests: [
      {
        file: "test/e2e/live/issue-4434-tui-unreachable-inference.test.ts",
        project: "e2e-live",
      },
    ],
    instructions: "test/e2e/live/issue-4434-tui-unreachable-inference.test.ts",
  },
  {
    id: "launch-readiness-lease-acceptance",
    tests: [
      {
        file: "test/e2e/live/launch-readiness-lease-acceptance.test.ts",
        project: "e2e-live",
      },
    ],
    instructions: "scripts/test-launch-readiness-lease.sh",
  },
  {
    id: "overlayfs-autofix",
    tests: [
      {
        file: "test/e2e/live/overlayfs-autofix.test.ts",
        project: "e2e-live",
      },
    ],
    instructions: "test/e2e/live/overlayfs-autofix.test.ts",
  },
  {
    id: "spark-express-vllm",
    tests: [
      {
        file: "test/e2e/live/spark-express-vllm.test.ts",
        project: "e2e-live",
      },
    ],
    instructions: "test/e2e/README.md#dgx-spark-express-vllm",
  },
  {
    id: "windows-mxc-openclaw-process-container",
    tests: [
      {
        file: "test/e2e/live/windows-mxc-openclaw-process-container.test.ts",
        project: "e2e-live",
      },
    ],
    instructions: "test/e2e/README.md#inactive-windows-mxc-openclaw-qualification",
  },
  {
    id: "historical-openclaw-security-revision-container-e2e",
    tests: [
      {
        file: "test/e2e-runtime/historical-openclaw-security-revision-container-e2e.test.ts",
        project: "integration",
      },
    ],
    instructions: "test/e2e-runtime/historical-openclaw-security-revision-container-e2e.test.ts",
  },
  {
    id: "repro-4538-raw-doctor-perms",
    tests: [
      {
        file: "test/e2e-runtime/repro-4538-raw-doctor-perms.test.ts",
        project: "integration",
      },
    ],
    instructions: "test/e2e-runtime/repro-4538-raw-doctor-perms.test.ts",
  },
];
