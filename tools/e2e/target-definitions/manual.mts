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
    prerequisites: [
      "A live OpenShell host and the provider credentials required by each selected case.",
      "The NVIDIA isolation case requires NVIDIA_INFERENCE_API_KEY.",
      "OpenAI and Anthropic cases require their API keys and NEMOCLAW_INFERENCE_ROUTING_PROVIDER_SMOKE=openai, anthropic, or all.",
    ],
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
    prerequisites: [
      "NEMOCLAW_ISSUE_4434_LIVE=1 and inference that is not gateway-managed.",
      "A Linux Docker host with passwordless sudo, iptables, expect, curl, and the cloud onboarding prerequisites.",
      "The test changes host DOCKER-USER rules and removes its rules during cleanup.",
    ],
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
    prerequisites: [
      "An existing locked-image OpenClaw sandbox with final state mounts, policy, and network provisioning.",
      "Linux with util-linux script, GNU timeout, and writable runtime authority under /run/user/<numeric-uid>.",
      "Run the helper as the numeric user that owns the sandbox state and later runs launch.",
    ],
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
    prerequisites: [
      "A runtime path that still uses the cluster overlayfs repair; the Linux Docker driver path skips this test.",
      "Docker with containerd snapshotter support, passwordless sudo, and NVIDIA_INFERENCE_API_KEY.",
      "The test changes /etc/docker/daemon.json and restarts Docker; cleanup restores the previous configuration.",
    ],
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
    prerequisites: [
      "A physical DGX Spark with Docker, NVIDIA Container Toolkit, OpenShell prerequisites, and storage for the pinned image and model.",
      "A local Docker socket and default context; no pre-existing target sandbox or nemoclaw-vllm container.",
      "E2E_JOB=1, E2E_TARGET_ID=spark-express-vllm, and NEMOCLAW_RUN_LIVE_E2E=1.",
    ],
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
    prerequisites: [
      "NEMOCLAW_RUN_WINDOWS_MXC_OPENCLAW_E2E=1 on a prepared Windows MXC host.",
      "All declared OpenShell, OpenClaw, Node.js, relay, and wxc-exec artifact identities must match the supplied artifacts.",
      "This qualification covers an inactive process_container candidate; it does not activate a runtime provider.",
    ],
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
    prerequisites: [
      "Docker and a canonical image reference in NEMOCLAW_HISTORICAL_OPENCLAW_SECURITY_REVISION_IMAGE.",
      "NEMOCLAW_RUN_HISTORICAL_OPENCLAW_SECURITY_REVISION_CONTAINER_E2E=1 or E2E_TARGET_ID=historical-openclaw-security-revision-container-e2e.",
      "Access to the integrity-checked historical plugin archive used by the test.",
    ],
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
    prerequisites: [
      "NEMOCLAW_RUN_DOCTOR_PERMS_DOCKER_E2E=1 and a reachable Docker daemon.",
      "A local sandbox image, selected through NEMOCLAW_DOCTOR_PERMS_E2E_IMAGE or the existing image fallbacks.",
      "Only the gated Docker cases require live execution; deterministic cases remain ordinary integration tests.",
    ],
  },
];
