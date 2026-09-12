// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WorkflowE2eTarget } from "../target-inventory.mts";

export const workflowTargets: readonly WorkflowE2eTarget[] = [
  {
    id: "staging-brev-launchable",
    workflow: ".github/workflows/e2e.yaml",
    targetId: null,
    defaultEnabled: true,
    gatewayRuntimes: ["docker"],
    testFiles: [],
    owningPaths: [],
    coverage: [
      {
        row: {
          id: "staging-brev-launchable",
          variant: "",
          source: "staging",
          agentRuntime: "openclaw",
          observableOutcome: "The staging image boots and completes the full E2E scenario",
          environmentOrInferenceEndpoint: "Brev Launchable Docker host; NVIDIA hosted inference",
          unresolvedReason: "",
        },
        gatewayRuntimes: ["docker"],
      },
    ],
  },
  {
    id: "staging-brev-launchable-identity",
    workflow: ".github/workflows/e2e.yaml",
    targetId: null,
    defaultEnabled: false,
    gatewayRuntimes: "agnostic",
    testFiles: [],
    owningPaths: [],
    coverage: [
      {
        row: {
          id: "staging-brev-launchable-identity",
          variant: "",
          source: "staging",
          agentRuntime: "none",
          observableOutcome:
            "The staging image boots, passes the SSH access probe, and matches the baked runtime identity",
          environmentOrInferenceEndpoint: "Brev Launchable host; no inference endpoint",
          unresolvedReason: "",
        },
        gatewayRuntimes: "agnostic",
      },
    ],
  },
  {
    id: "openshell-gateway-auth-contract",
    workflow: ".github/workflows/e2e.yaml",
    targetId: "openshell-gateway-auth-contract",
    defaultEnabled: true,
    gatewayRuntimes: ["docker"],
    testFiles: ["test/e2e/live/openshell-gateway-auth-source-contract.test.ts"],
    owningPaths: ["test/e2e/live/openshell-gateway-auth-source-contract.test.ts"],
    coverage: [
      {
        row: {
          id: "openshell-gateway-auth-contract",
          variant: "",
          source: "retained-workflow",
          agentRuntime: "none",
          observableOutcome: "Gateway mTLS and sandbox JWT authentication boundaries hold",
          environmentOrInferenceEndpoint: "Ubuntu Docker host; no inference endpoint",
          unresolvedReason: "",
        },
        gatewayRuntimes: ["docker"],
      },
    ],
  },
  {
    id: "external-gateway-health",
    workflow: ".github/workflows/e2e.yaml",
    targetId: "external-gateway-health",
    defaultEnabled: false,
    gatewayRuntimes: "agnostic",
    testFiles: ["test/e2e/live/external-gateway-health.test.ts"],
    owningPaths: ["test/e2e/live/external-gateway-health.test.ts"],
    coverage: [
      {
        row: {
          id: "external-gateway-health",
          variant: "",
          source: "retained-workflow",
          agentRuntime: "none",
          observableOutcome:
            "The exact Blueprint Runner observes public gateway health over explicit HTTPS and CA",
          environmentOrInferenceEndpoint:
            "Ubuntu host with OpenShell 0.0.116; no inference endpoint",
          unresolvedReason: "",
        },
        gatewayRuntimes: "agnostic",
      },
    ],
  },
  {
    id: "mcp-bridge",
    workflow: ".github/workflows/e2e.yaml",
    targetId: "mcp-bridge",
    defaultEnabled: true,
    gatewayRuntimes: ["docker", "podman"],
    testFiles: ["test/e2e/live/mcp-bridge.test.ts"],
    owningPaths: ["test/e2e/live/mcp-bridge.test.ts"],
    coverage: [
      {
        row: {
          id: "mcp-bridge",
          variant: "openclaw",
          source: "retained-workflow",
          agentRuntime: "openclaw",
          observableOutcome: "Stable OpenShell MCP bridge reaches tools and inference",
          environmentOrInferenceEndpoint:
            "Ubuntu managed runtime host; local compatible inference and MCP endpoint",
          unresolvedReason: "",
        },
        gatewayRuntimes: ["docker", "podman"],
      },
      {
        row: {
          id: "mcp-bridge",
          variant: "hermes",
          source: "retained-workflow",
          agentRuntime: "hermes",
          observableOutcome: "Stable OpenShell MCP bridge reaches tools and inference",
          environmentOrInferenceEndpoint:
            "Ubuntu managed runtime host; local compatible inference and MCP endpoint",
          unresolvedReason: "",
        },
        gatewayRuntimes: ["docker", "podman"],
      },
      {
        row: {
          id: "mcp-bridge",
          variant: "deepagents",
          source: "retained-workflow",
          agentRuntime: "langchain-deepagents-code",
          observableOutcome: "Stable OpenShell MCP bridge reaches tools and inference",
          environmentOrInferenceEndpoint:
            "Ubuntu managed runtime host; local compatible inference and MCP endpoint",
          unresolvedReason: "",
        },
        gatewayRuntimes: ["docker", "podman"],
      },
    ],
  },
  {
    id: "openshell-credential-generation-window",
    workflow: ".github/workflows/e2e.yaml",
    targetId: "openshell-credential-generation-window",
    defaultEnabled: true,
    gatewayRuntimes: ["docker", "podman"],
    testFiles: ["test/e2e/live/openshell-credential-generation-window.test.ts"],
    owningPaths: ["test/e2e/live/openshell-credential-generation-window.test.ts"],
    coverage: [
      {
        row: {
          id: "openshell-credential-generation-window",
          variant: "",
          source: "retained-workflow",
          agentRuntime: "openclaw",
          observableOutcome:
            "Stable-handle refresh, revocation, detach, re-add, and rebuild preserve authorization epochs",
          environmentOrInferenceEndpoint:
            "Ubuntu managed runtime host; local compatible inference and MCP endpoint",
          unresolvedReason: "",
        },
        gatewayRuntimes: ["docker", "podman"],
      },
    ],
  },
  {
    id: "mcp-bridge-dev",
    workflow: ".github/workflows/e2e.yaml",
    targetId: "mcp-bridge-dev",
    defaultEnabled: false,
    gatewayRuntimes: ["docker", "podman"],
    testFiles: ["test/e2e/live/mcp-bridge.test.ts"],
    owningPaths: ["test/e2e/live/mcp-bridge.test.ts"],
    coverage: [
      {
        row: {
          id: "mcp-bridge-dev",
          variant: "openclaw",
          source: "retained-workflow",
          agentRuntime: "openclaw",
          observableOutcome: "Development OpenShell MCP bridge reaches tools and inference",
          environmentOrInferenceEndpoint:
            "Ubuntu managed runtime host; local compatible inference and MCP endpoint",
          unresolvedReason: "",
        },
        gatewayRuntimes: ["docker", "podman"],
      },
      {
        row: {
          id: "mcp-bridge-dev",
          variant: "hermes",
          source: "retained-workflow",
          agentRuntime: "hermes",
          observableOutcome: "Development OpenShell MCP bridge reaches tools and inference",
          environmentOrInferenceEndpoint:
            "Ubuntu managed runtime host; local compatible inference and MCP endpoint",
          unresolvedReason: "",
        },
        gatewayRuntimes: ["docker", "podman"],
      },
      {
        row: {
          id: "mcp-bridge-dev",
          variant: "deepagents",
          source: "retained-workflow",
          agentRuntime: "langchain-deepagents-code",
          observableOutcome: "Development OpenShell MCP bridge reaches tools and inference",
          environmentOrInferenceEndpoint:
            "Ubuntu managed runtime host; local compatible inference and MCP endpoint",
          unresolvedReason: "",
        },
        gatewayRuntimes: ["docker", "podman"],
      },
    ],
  },
  {
    id: "managed-image-multiarch-startup",
    workflow: ".github/workflows/e2e.yaml",
    targetId: "managed-image-multiarch-startup",
    defaultEnabled: true,
    gatewayRuntimes: ["docker"],
    testFiles: ["test/e2e/live/managed-image-multiarch-startup.test.ts"],
    owningPaths: ["test/e2e/live/managed-image-multiarch-startup.test.ts"],
    coverage: [
      {
        row: {
          id: "managed-image-multiarch-startup",
          variant: "linux-amd64",
          source: "retained-workflow",
          agentRuntime: "openclaw + hermes + langchain-deepagents-code",
          observableOutcome: "Exact managed images start directly on the native architecture",
          environmentOrInferenceEndpoint: "AMD64 Ubuntu; exact managed image startup",
          unresolvedReason: "",
        },
        gatewayRuntimes: ["docker"],
      },
      {
        row: {
          id: "managed-image-multiarch-startup",
          variant: "linux-arm64",
          source: "retained-workflow",
          agentRuntime: "openclaw + hermes + langchain-deepagents-code",
          observableOutcome: "Exact managed images start directly on the native architecture",
          environmentOrInferenceEndpoint: "Arm64 Ubuntu; exact managed image startup",
          unresolvedReason: "",
        },
        gatewayRuntimes: ["docker"],
      },
    ],
  },
  {
    id: "managed-image-protected-runtime",
    workflow: ".github/workflows/e2e.yaml",
    targetId: "managed-image-protected-runtime",
    defaultEnabled: true,
    gatewayRuntimes: ["docker"],
    testFiles: ["test/e2e/live/managed-image-protected-runtime.test.ts"],
    owningPaths: ["test/e2e/live/managed-image-protected-runtime.test.ts"],
    coverage: [
      {
        row: {
          id: "managed-image-protected-runtime",
          variant: "",
          source: "retained-workflow",
          agentRuntime: "openclaw + hermes + langchain-deepagents-code",
          observableOutcome: "Protected GPU runtime supports Ollama vLLM NIM rollback and cleanup",
          environmentOrInferenceEndpoint: "NVIDIA GPU runner; local and hosted inference services",
          unresolvedReason: "",
        },
        gatewayRuntimes: ["docker"],
      },
    ],
  },
  {
    id: "hermes-e2e",
    workflow: ".github/workflows/e2e.yaml",
    targetId: "hermes-e2e",
    defaultEnabled: true,
    gatewayRuntimes: ["docker", "podman"],
    testFiles: ["test/e2e/live/hermes-e2e.test.ts"],
    owningPaths: [
      "src/lib/acp/command.ts",
      "src/lib/acp/main.ts",
      "src/lib/adapters/openshell/hermes-acp-ssh-cli.ts",
      "src/lib/adapters/openshell/hermes-acp-ssh.ts",
      "test/e2e/live/hermes-e2e.test.ts",
    ],
    coverage: [
      {
        row: {
          id: "hermes-e2e",
          variant: "",
          source: "retained-workflow",
          agentRuntime: "hermes",
          observableOutcome:
            "Install onboarding health inference lifecycle dashboard and security succeed",
          environmentOrInferenceEndpoint: "Ubuntu; mock or NVIDIA hosted inference",
          unresolvedReason: "",
        },
        gatewayRuntimes: ["docker", "podman"],
      },
    ],
  },
  {
    id: "hermes-gpu-startup",
    workflow: ".github/workflows/e2e.yaml",
    targetId: "hermes-gpu-startup",
    defaultEnabled: true,
    gatewayRuntimes: ["docker", "podman"],
    testFiles: ["test/e2e/live/hermes-gpu-startup.test.ts"],
    owningPaths: [
      "test/e2e/live/hermes-gpu-startup-proof.ts",
      "test/e2e/live/hermes-gpu-startup.test.ts",
      "test/helpers/openshell-gateway-start-output.ts",
    ],
    coverage: [
      {
        row: {
          id: "hermes-gpu-startup",
          variant: "native",
          source: "retained-workflow",
          agentRuntime: "hermes",
          observableOutcome: "Hermes GPU startup reaches the stable Ready route",
          environmentOrInferenceEndpoint: "NVIDIA GPU runner; local GPU inference",
          unresolvedReason: "",
        },
        gatewayRuntimes: ["docker", "podman"],
      },
      {
        row: {
          id: "hermes-gpu-startup",
          variant: "fallback",
          source: "retained-workflow",
          agentRuntime: "hermes",
          observableOutcome: "Hermes GPU startup reaches the stable Ready route",
          environmentOrInferenceEndpoint: "NVIDIA GPU runner; local GPU inference",
          unresolvedReason: "",
        },
        gatewayRuntimes: ["docker"],
      },
      {
        row: {
          id: "hermes-gpu-startup",
          variant: "compatibility-only",
          source: "retained-workflow",
          agentRuntime: "hermes",
          observableOutcome: "Hermes GPU startup reaches the stable Ready route",
          environmentOrInferenceEndpoint: "NVIDIA GPU runner; local GPU inference",
          unresolvedReason: "",
        },
        gatewayRuntimes: ["docker"],
      },
    ],
  },
  {
    id: "cloud-onboard",
    workflow: ".github/workflows/e2e.yaml",
    targetId: "cloud-onboard",
    defaultEnabled: true,
    gatewayRuntimes: ["docker", "podman"],
    testFiles: ["test/e2e/live/cloud-onboard.test.ts"],
    owningPaths: ["test/e2e/live/cloud-onboard.test.ts"],
    coverage: [
      {
        row: {
          id: "cloud-onboard",
          variant: "",
          source: "retained-workflow",
          agentRuntime: "openclaw",
          observableOutcome:
            "Public install onboarding hosted inference and security checks succeed",
          environmentOrInferenceEndpoint: "Ubuntu; NVIDIA hosted inference",
          unresolvedReason: "",
        },
        gatewayRuntimes: ["docker", "podman"],
      },
    ],
  },
  {
    id: "messaging-providers",
    workflow: ".github/workflows/e2e.yaml",
    targetId: "messaging-providers",
    defaultEnabled: true,
    gatewayRuntimes: ["docker", "podman"],
    testFiles: ["test/e2e/live/messaging-providers.test.ts"],
    owningPaths: ["test/e2e/lib/fake-wechat-api.mts", "test/e2e/live/messaging-providers.test.ts"],
    coverage: [
      {
        row: {
          id: "messaging-providers",
          variant: "",
          source: "retained-workflow",
          agentRuntime: "openclaw",
          observableOutcome: "Provider configuration redaction and optional real sends succeed",
          environmentOrInferenceEndpoint: "Ubuntu; NVIDIA hosted inference and messaging providers",
          unresolvedReason: "",
        },
        gatewayRuntimes: ["docker", "podman"],
      },
    ],
  },
  {
    id: "openclaw-plugin-runtime-exdev",
    workflow: ".github/workflows/e2e.yaml",
    targetId: "openclaw-plugin-runtime-exdev",
    defaultEnabled: true,
    gatewayRuntimes: ["docker"],
    testFiles: ["test/e2e/live/openclaw-plugin-runtime-exdev.test.ts"],
    owningPaths: [
      "test/e2e/fixtures/openclaw-plugin-runtime-exdev-onboard.ts",
      "test/e2e/live/openclaw-plugin-runtime-exdev-trusted-prebuild.ts",
      "test/e2e/live/openclaw-plugin-runtime-exdev.test.ts",
    ],
    coverage: [
      {
        row: {
          id: "openclaw-plugin-runtime-exdev",
          variant: "",
          source: "retained-workflow",
          agentRuntime: "openclaw",
          observableOutcome:
            "OpenClaw installs the custom plugin across devices; plugin behavior survives restart and recreation",
          environmentOrInferenceEndpoint: "Ubuntu; current package; no inference endpoint",
          unresolvedReason: "",
        },
        gatewayRuntimes: ["docker"],
      },
    ],
  },
];
