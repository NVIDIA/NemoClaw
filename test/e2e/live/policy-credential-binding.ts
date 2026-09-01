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
policy_file="$(mktemp)"
trap 'rm -f "$policy_file"' EXIT
"$1" policy get --base "$2" >"$policy_file"
node --import tsx "$7" "$policy_file" "$3" "$4" "$5" "$6"
"$1" policy set --policy "$policy_file" --wait "$2"`,
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
