// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { assertExitZero } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";

type RebuildHermesPolicyProbeOptions = {
  env: NodeJS.ProcessEnv;
  host: HostCliClient;
  openshellBin: string;
  redactionValues: string[];
  sandboxName: string;
  timeoutMs: number;
};

export async function applyRebuildHermesHostPolicyEdit(
  options: RebuildHermesPolicyProbeOptions,
): Promise<void> {
  const result = await options.host.command(
    options.openshellBin,
    [
      "policy",
      "update",
      options.sandboxName,
      "--add-endpoint",
      "host-edit-rebuild-hermes.example.com:443:read-only:rest:enforce",
      "--rule-name",
      "host_edit_rebuild_hermes_e2e",
      "--binary",
      "/usr/bin/curl",
      "--wait",
    ],
    {
      artifactName: "phase-5-host-policy-edit-before-rebuild",
      env: options.env,
      redactionValues: options.redactionValues,
      timeoutMs: options.timeoutMs,
    },
  );
  assertExitZero(result, "apply host policy edit before Hermes rebuild");
}

export async function assertRebuildHermesHostPolicyEditSurvives(
  options: RebuildHermesPolicyProbeOptions,
): Promise<void> {
  const result = await options.host.command(
    options.openshellBin,
    ["policy", "get", "--full", options.sandboxName],
    {
      artifactName: "phase-7-policy-after-rebuild",
      env: options.env,
      redactionValues: options.redactionValues,
      timeoutMs: options.timeoutMs,
    },
  );
  assertExitZero(result, "read Hermes policy after rebuild");
  assert.match(result.stdout, /host_edit_rebuild_hermes_e2e/u);
}
