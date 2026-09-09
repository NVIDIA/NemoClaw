// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { REPOSITORY_ROOT } from "../../core/repository-root";
import {
  importCliOpenShellProviderProfile,
  type CapturedProviderCommandResult,
  type CliOpenShellProviderProfileResult,
} from "./provider-adapter-cli";
import { endpointlessProviderProfilePath } from "./provider-profile";

export type EndpointlessProviderProfileRunner = (
  args: string[],
  options: {
    readonly ignoreError: true;
    readonly suppressOutput?: boolean;
    readonly stdio: ["ignore", "pipe", "pipe"];
    readonly timeout: number;
  },
) => {
  readonly status?: number | null;
  readonly output?: unknown;
  readonly stdout?: unknown;
  readonly stderr?: unknown;
  readonly error?: unknown;
};

function capturedResult(
  result: ReturnType<EndpointlessProviderProfileRunner>,
): CapturedProviderCommandResult {
  return {
    status: result.status ?? null,
    output: result.output,
    stdout:
      typeof result.stdout === "string" || Buffer.isBuffer(result.stdout) ? result.stdout : null,
    stderr:
      typeof result.stderr === "string" || Buffer.isBuffer(result.stderr) ? result.stderr : null,
    ...(result.error instanceof Error ? { error: result.error } : {}),
  };
}

/** Normalize a legacy runner and delegate the registration protocol to the CLI adapter owner. */
export function registerCheckedInProviderProfile(input: {
  readonly profilePath: string;
  readonly runOpenshell: EndpointlessProviderProfileRunner;
  readonly readProfileFile?: (profilePath: string) => string;
}): CliOpenShellProviderProfileResult {
  return importCliOpenShellProviderProfile(
    { profilePath: input.profilePath, target: { kind: "selected" } },
    {
      readProfileFile: input.readProfileFile,
      run: (args, options) => capturedResult(input.runOpenshell(args, options)),
    },
  );
}

export type EndpointlessProviderProfileFailureReason =
  | "export-failed"
  | "import-failed"
  | "incompatible";

/** OpenShell provider type registered for every OpenAI-surface inference route. */
export const OPENAI_GATEWAY_PROVIDER_TYPE = "openai";

export type OpenAiProviderProfileCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly messages: readonly string[] };

/** Return the recovery guidance for an endpointless OpenAI profile failure. */
export function endpointlessProviderProfileFailureMessages(
  reason: EndpointlessProviderProfileFailureReason,
): readonly string[] {
  if (reason === "import-failed") {
    return [
      `\n  ✗ OpenShell could not import the checked-in '${OPENAI_GATEWAY_PROVIDER_TYPE}' inference provider profile.`,
      "    Confirm OpenShell is available and authorized, then retry this command.",
    ];
  }
  if (reason === "export-failed") {
    return [
      `\n  ✗ OpenShell provider profile '${OPENAI_GATEWAY_PROVIDER_TYPE}' could not be read for validation.`,
      "    Confirm OpenShell is available, authorized, and the profile is readable, then retry this command.",
    ];
  }
  return [
    `\n  ✗ OpenShell provider profile '${OPENAI_GATEWAY_PROVIDER_TYPE}' already exists but does not match NemoClaw's endpointless inference contract.`,
    "    Remove the conflicting profile, then retry this command.",
  ];
}

function endpointlessFailureReason(
  result: Extract<CliOpenShellProviderProfileResult, { readonly ok: false }>,
): EndpointlessProviderProfileFailureReason {
  if (result.error.kind === "command" && result.error.reason === "profile_incompatible") {
    return "incompatible";
  }
  return result.operation === "import" ? "import-failed" : "export-failed";
}

/** Validate or import the endpointless OpenAI profile through the shared CLI adapter protocol. */
export function checkOpenAiInferenceProviderProfile(deps: {
  readonly runOpenshell: EndpointlessProviderProfileRunner;
  readonly root?: string;
}): OpenAiProviderProfileCheck {
  const result = registerCheckedInProviderProfile({
    profilePath: endpointlessProviderProfilePath(
      deps.root ?? REPOSITORY_ROOT,
      OPENAI_GATEWAY_PROVIDER_TYPE,
    ),
    runOpenshell: deps.runOpenshell,
  });
  if (result.ok) return { ok: true };
  return {
    ok: false,
    messages: endpointlessProviderProfileFailureMessages(endpointlessFailureReason(result)),
  };
}
