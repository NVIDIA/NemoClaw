// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { shellQuote } from "../fixtures/clients/command.ts";

export function hermesSlackCredentialScanScript(options: {
  openshellCommandPath: string;
  remoteCommand: string;
  sandboxName: string;
}): string {
  return [
    "set -euo pipefail",
    [
      'printf "%s\\n%s\\n" "$SLACK_BOT_TOKEN" "$SLACK_APP_TOKEN"',
      "|",
      shellQuote(options.openshellCommandPath),
      "sandbox exec --name",
      shellQuote(options.sandboxName),
      "-- sh -lc",
      shellQuote(options.remoteCommand),
    ].join(" "),
  ].join("\n");
}
