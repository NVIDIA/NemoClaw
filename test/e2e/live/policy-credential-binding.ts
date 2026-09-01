// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { assertExitZero } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";

export async function applyPolicyCredentialBinding(options: {
  host: Pick<HostCliClient, "command" | "openshellCommandPath">;
  sandboxName: string;
  providerName: string;
  endpointHost: string;
  endpointPort: string | number;
  protocol: "rest" | "websocket";
  env: NodeJS.ProcessEnv;
  redactionValues: string[];
  artifactName: string;
}): Promise<void> {
  const result = await options.host.command(
    "bash",
    [
      "-lc",
      String.raw`set -eu
original_policy="$(mktemp)"
desired_policy="$(mktemp)"
rechecked_policy="$(mktemp)"
applied_policy="$(mktemp)"
trap 'rm -f "$original_policy" "$desired_policy" "$rechecked_policy" "$applied_policy"' EXIT
"$1" policy get --base "$2" >"$original_policy"
cp "$original_policy" "$desired_policy"
node --import tsx "$7" "$desired_policy" "$3" "$4" "$5" "$6"
"$1" policy get --base "$2" >"$rechecked_policy"
node --import tsx "$7" --assert-equal "$original_policy" "$rechecked_policy" \
  "sandbox base policy changed while preparing the credential binding; refusing to apply a stale policy"
"$1" policy set --policy "$desired_policy" --wait "$2"
"$1" policy get --base "$2" >"$applied_policy"
node --import tsx "$7" --assert-equal "$desired_policy" "$applied_policy" \
  "applied policy did not match the requested credential binding"`,
      "bind-policy-endpoint-credential",
      options.host.openshellCommandPath,
      options.sandboxName,
      options.providerName,
      options.endpointHost,
      String(options.endpointPort),
      options.protocol,
      path.join(REPO_ROOT, "test/e2e/fixtures/policy-credential-binding.ts"),
    ],
    {
      artifactName: options.artifactName,
      cwd: REPO_ROOT,
      env: options.env,
      redactionValues: options.redactionValues,
      timeoutMs: 120_000,
    },
  );
  assertExitZero(result, options.artifactName);
}
