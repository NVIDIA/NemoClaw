// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ExternalWorkflowE2eTarget } from "../target-inventory.mts";

// Workflow jobs retain scheduling, prerequisites, artifact identity, and cleanup ownership.
export const externalWorkflowTargets: readonly ExternalWorkflowE2eTarget[] = [
  {
    id: "e2e-managed-image-multiarch-package-contracts",
    workflow: ".github/workflows/e2e.yaml",
    job: "managed-image-multiarch-startup",
    tests: [
      { file: "test/e2e-runtime/managed-image-openclaw-security.test.ts", project: "integration" },
      {
        file: "test/e2e-runtime/image-compatibility-docker-lifecycle.test.ts",
        project: "integration",
      },
    ],
  },
  {
    id: "e2e-jetson-nvmap-gpu",
    entrypoint: "tools/e2e/jetson-dispatch-client.mts",
    workflow: ".github/workflows/e2e.yaml",
    job: "jetson-nvmap-gpu",
    tests: [{ file: "test/e2e/live/jetson-nvmap-gpu.test.ts", project: "e2e-live" }],
  },
  {
    id: "candidate-compatibility-live",
    workflow: ".github/workflows/candidate-compatibility.yaml",
    job: "live",
    tests: [
      {
        file: "test/e2e/live/openshell-gateway-auth-source-contract.test.ts",
        project: "e2e-live",
      },
    ],
  },
  {
    id: "e2e-native-runtime-qualification-producer",
    workflow: ".github/workflows/e2e.yaml",
    job: "native-runtime-qualification-producer",
    tests: [
      {
        file: "test/e2e/live/native-runtime-qualification-case.test.ts",
        project: "e2e-live",
      },
    ],
  },
  {
    id: "managed-images-pr-managed-activation",
    workflow: ".github/workflows/managed-images.yaml",
    job: "pr-managed-activation",
    tests: [
      {
        file: "test/e2e/live/managed-image-activation-e2e.test.ts",
        project: "e2e-live",
      },
    ],
  },
  {
    id: "platform-vitest-main-macos-live-e2e",
    workflow: ".github/workflows/platform-vitest-main.yaml",
    job: "macos-live-e2e",
    tests: [
      {
        file: "test/e2e/live/full-e2e.test.ts",
        project: "e2e-live",
      },
    ],
  },
  {
    id: "platform-vitest-main-wsl-vitest",
    workflow: ".github/workflows/platform-vitest-main.yaml",
    job: "wsl-vitest",
    tests: [
      {
        file: "test/e2e/live/full-e2e.test.ts",
        project: "e2e-live",
      },
    ],
  },
  {
    id: "podman-cpu-proof-podman-cpu-lifecycle",
    workflow: ".github/workflows/podman-cpu-proof.yaml",
    job: "podman-cpu-lifecycle",
    tests: [
      {
        file: "test/e2e/live/podman-cpu-lifecycle.test.ts",
        project: "e2e-live",
      },
      {
        file: "test/e2e/live/podman-portable-uninstall.test.ts",
        project: "e2e-live",
      },
    ],
  },
  {
    id: "portable-profile-e2e-rootless-linux",
    workflow: ".github/workflows/portable-profile-e2e.yaml",
    job: "rootless-linux",
    tests: [
      {
        file: "test/e2e/live/portable-profile-rootless-linux.test.ts",
        project: "e2e-live",
      },
    ],
  },
  {
    id: "portable-profile-e2e-portable-launch",
    workflow: ".github/workflows/portable-profile-e2e.yaml",
    job: "portable-launch",
    tests: [
      {
        file: "test/e2e/live/full-e2e.test.ts",
        project: "e2e-live",
      },
    ],
  },
  {
    id: "pr-self-hosted-llama-cpp-generic-gpu",
    workflow: ".github/workflows/pr-self-hosted.yaml",
    job: "llama-cpp-generic-gpu",
    tests: [
      {
        file: "test/e2e/live/llama-cpp-generic-gpu.test.ts",
        project: "e2e-live",
      },
    ],
  },
  {
    id: "pr-self-hosted-managed-image-openclaw-security",
    workflow: ".github/workflows/pr-self-hosted.yaml",
    job: "managed-image-openclaw-security",
    tests: [
      {
        file: "test/e2e-runtime/managed-image-openclaw-security.test.ts",
        project: "integration",
      },
      {
        file: "test/e2e-runtime/image-compatibility-docker-lifecycle.test.ts",
        project: "integration",
      },
    ],
  },
  {
    id: "sandbox-images-test-hermes-sandbox-image",
    workflow: ".github/workflows/sandbox-images.yaml",
    job: "test-hermes-sandbox-image",
    tests: [
      {
        file: "test/e2e/live/hermes-sandbox-secret-boundary.test.ts",
        project: "e2e-live",
      },
      {
        file: "test/e2e/live/hermes-root-entrypoint-smoke.test.ts",
        project: "e2e-live",
      },
    ],
  },
  {
    id: "sandbox-images-runtime-overrides",
    workflow: ".github/workflows/sandbox-images.yaml",
    job: "runtime-overrides",
    tests: [
      {
        file: "test/e2e/live/runtime-overrides.test.ts",
        project: "e2e-live",
      },
    ],
  },
  {
    id: "sandbox-images-managed-image-openclaw-security",
    workflow: ".github/workflows/sandbox-images.yaml",
    job: "managed-image-openclaw-security",
    tests: [
      {
        file: "test/e2e-runtime/managed-image-openclaw-security.test.ts",
        project: "integration",
      },
      {
        file: "test/e2e-runtime/image-compatibility-docker-lifecycle.test.ts",
        project: "integration",
      },
    ],
  },
  {
    id: "staging-launchable-full-test",
    workflow: ".github/workflows/staging-launchable-full.yaml",
    job: "test",
    tests: [
      {
        file: "test/e2e/live/issue-9880-staging-launchable.test.ts",
        project: "e2e-live",
      },
      {
        file: "test/e2e/live/brev-workspace-cleanup.test.ts",
        project: "e2e-live",
      },
    ],
  },
  {
    id: "podman-cpu-proof-portable-cpu-delegation",
    entrypoint: "scripts/checks/run-portable-cpu-delegation-proof.mts",
    workflow: ".github/workflows/podman-cpu-proof.yaml",
    job: "portable-cpu-delegation",
    tests: [
      {
        file: "test/e2e/live/portable-cpu-delegation-proof.test.ts",
        project: "e2e-live",
      },
    ],
  },
];
