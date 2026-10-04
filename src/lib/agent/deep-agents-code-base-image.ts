// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { dockerCapture } from "../adapters/docker";
import type { ResolveBaseImageOptions } from "../sandbox-base-image";
import { sandboxBaseImageHasSecurityInventory } from "../sandbox-base-image/security-inventory";
import type { AgentDefinition } from "./defs";

const DEEPAGENTS_CODE_DISTRIBUTION = "deepagents-code";
const DEEPAGENTS_CODE_DOS2UNIX_PROBE_OK = "nemoclaw-dcode-dos2unix-ok";
const DEEPAGENTS_CODE_BASE_IMAGE_PROBE_GUARDS = [
  "--network",
  "none",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--read-only",
] as const;

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
      ...DEEPAGENTS_CODE_BASE_IMAGE_PROBE_GUARDS,
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

/**
 * Reject a published or cached Deep Agents Code base image that omits
 * dos2unix, which workspace and repository workflows require.
 */
export function deepAgentsCodeBaseImageHasDos2Unix(imageRef: string): boolean {
  const output = dockerCapture(
    [
      "run",
      "--rm",
      ...DEEPAGENTS_CODE_BASE_IMAGE_PROBE_GUARDS,
      "--user",
      "999:999",
      "--entrypoint",
      "/bin/sh",
      imageRef,
      "-eu",
      "-c",
      [
        "test -x /usr/bin/dos2unix",
        'test "$(command -v dos2unix)" = /usr/bin/dos2unix',
        "dos2unix --version >/dev/null",
        `printf '%s\\n' "${DEEPAGENTS_CODE_DOS2UNIX_PROBE_OK}"`,
      ].join("; "),
    ],
    { ignoreError: true, timeout: 20_000 },
  );
  return output.trim() === DEEPAGENTS_CODE_DOS2UNIX_PROBE_OK;
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
    validateImage: (imageRef) =>
      deepAgentsCodeBaseImageMatchesVersion(imageRef, expectedVersion) &&
      deepAgentsCodeBaseImageHasDos2Unix(imageRef) &&
      sandboxBaseImageHasSecurityInventory(imageRef),
    validationDescription:
      `${DEEPAGENTS_CODE_DISTRIBUTION}==${expectedVersion}, dos2unix, and ` +
      "the immutable security package inventory",
  };
}
