// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  OPENSHELL_MANAGED_BY_LABEL,
  OPENSHELL_SANDBOX_ID_LABEL,
  OPENSHELL_SANDBOX_NAME_LABEL,
} from "../../onboard/openshell-docker-sandbox-containers";
import { dockerRun } from "./run";

/** Workspace label OpenShell stamps on every managed sandbox container. */
export const OPENSHELL_SANDBOX_WORKSPACE_LABEL = "openshell.ai/sandbox-workspace";

const DOCKER_IDENTITY_PROBE_TIMEOUT_MS = 30_000;

/** One container carrying the destroy target's `sandbox-name` label. */
export type SandboxNameLabeledContainer = {
  id: string;
  managedBy: string;
  workspace: string;
  sandboxId: string;
};

/**
 * Result of probing Docker for every container carrying a given `sandbox-name`.
 *
 * - `ok` — Docker answered; `rows` is every labeled container (possibly empty).
 * - `probe-failed` — Docker could not be queried, so identity can neither be
 *   proven nor ruled out. The classifier turns this into a fail-closed verdict.
 */
export type SandboxIdentityProbe =
  | { status: "ok"; rows: SandboxNameLabeledContainer[] }
  | { status: "probe-failed"; detail: string };

export type ProbeSandboxNameContainersDeps = {
  dockerRun?: typeof dockerRun;
};

const IDENTITY_FORMAT = [
  "{{.ID}}",
  `{{.Label "${OPENSHELL_MANAGED_BY_LABEL}"}}`,
  `{{.Label "${OPENSHELL_SANDBOX_WORKSPACE_LABEL}"}}`,
  `{{.Label "${OPENSHELL_SANDBOX_ID_LABEL}"}}`,
].join("\t");

function resultText(result: {
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
}): string {
  return `${String(result.stderr || "")} ${String(result.stdout || "")}`.trim();
}

function parseIdentityRows(stdout: string): SandboxNameLabeledContainer[] {
  return stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id = "", managedBy = "", workspace = "", sandboxId = ""] = line.split("\t");
      return {
        id: id.trim(),
        managedBy: managedBy.trim(),
        workspace: workspace.trim(),
        sandboxId: sandboxId.trim(),
      };
    })
    .filter((row) => row.id.length > 0);
}

/**
 * Query every Docker container carrying `openshell.ai/sandbox-name=<name>` and
 * return the parsed identity rows (or a probe failure).
 *
 * The lookup deliberately filters ONLY on the mutable `sandbox-name` label —
 * not on `managed-by=openshell` — so a foreign container that borrows the name
 * without the managed marker stays visible to the classifier. This adapter owns
 * the host/process boundary (the `docker ps` call and its output parsing); the
 * classification decision over these rows is a separate pure function.
 */
export function probeSandboxNameContainers(
  sandboxName: string,
  deps: ProbeSandboxNameContainersDeps = {},
): SandboxIdentityProbe {
  const run = deps.dockerRun ?? dockerRun;
  const result = run(
    [
      "ps",
      "-a",
      "--no-trunc",
      "--filter",
      `label=${OPENSHELL_SANDBOX_NAME_LABEL}=${sandboxName}`,
      "--format",
      IDENTITY_FORMAT,
    ],
    {
      ignoreError: true,
      suppressOutput: true,
      timeout: DOCKER_IDENTITY_PROBE_TIMEOUT_MS,
    },
  );
  if (Number(result.status ?? 1) !== 0) {
    return {
      status: "probe-failed",
      detail: resultText(result) || "docker ps did not complete successfully",
    };
  }
  return { status: "ok", rows: parseIdentityRows(String(result.stdout ?? "")) };
}
