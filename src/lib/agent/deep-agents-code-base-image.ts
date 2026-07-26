// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { dockerCapture } from "../adapters/docker";
import type { ResolveBaseImageOptions } from "../sandbox-base-image";
import type { AgentDefinition } from "./defs";

const DEEPAGENTS_CODE_DISTRIBUTION = "deepagents-code";

type DeepAgentsCodeResolutionOptions = Pick<
  ResolveBaseImageOptions,
  "inputPaths" | "validateImage" | "validationDescription"
>;

/**
 * Reject a published or cached Deep Agents Code base whose installed package
 * does not match the active manifest. The final image patchers intentionally
 * require this exact source pairing, so accepting a merely runnable older base
 * only defers the failure until the expensive final-image build (#6456).
 */
export function deepAgentsCodeBaseImageMatchesVersion(
  imageRef: string,
  expectedVersion: string,
): boolean {
  const output = dockerCapture(
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--read-only",
      "--entrypoint",
      "/opt/venv/bin/python3",
      imageRef,
      "-I",
      "-c",
      `import importlib.metadata; print(importlib.metadata.version("${DEEPAGENTS_CODE_DISTRIBUTION}"))`,
    ],
    { ignoreError: true, timeout: 20_000 },
  );
  const installedVersion = output.trim();
  if (!installedVersion) {
    console.warn(
      `  Warning: ${imageRef} returned no Deep Agents Code version output; ` +
        "the container or metadata probe may have failed. " +
        `Rejecting the base image (expected ${DEEPAGENTS_CODE_DISTRIBUTION}==${expectedVersion}).`,
    );
    return false;
  }
  return installedVersion === expectedVersion;
}

export function createDeepAgentsCodeBaseImageResolutionOptions(
  agent: AgentDefinition,
  dockerfilePath: string,
): DeepAgentsCodeResolutionOptions | undefined {
  if (agent.name !== "langchain-deepagents-code") return undefined;
  const expectedVersion = agent.expectedVersion;
  if (!expectedVersion) {
    throw new Error(
      `Agent '${agent.name}' (${agent.displayName}) manifest is missing expected_version ` +
        "required for base-image validation",
    );
  }
  const agentRoot = path.dirname(dockerfilePath);
  return {
    // Retain the resolver's pre-existing global inputs alongside these agent
    // inputs. Per-agent cache-policy isolation is a separate cross-agent change.
    inputPaths: [path.join(agentRoot, "manifest.yaml"), path.join(agentRoot, "requirements.lock")],
    validateImage: (imageRef) => deepAgentsCodeBaseImageMatchesVersion(imageRef, expectedVersion),
    validationDescription: `${DEEPAGENTS_CODE_DISTRIBUTION}==${expectedVersion}`,
  };
}
