// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

import { shellQuote } from "../../../src/lib/core/shell-quote.ts";

const ALLOWLISTED_APPROVAL_CONNECT_SH = readFileSync(
  new URL("./allowlisted-approval-connect.sh", import.meta.url),
  "utf8",
).trimEnd();
export const ALLOWLISTED_REQUEST_TRIGGER_SH = readFileSync(
  new URL("./allowlisted-request-trigger.sh", import.meta.url),
  "utf8",
).trimEnd();

export function allowlistedApprovalConnectScript(
  cliPath: string,
  sandboxName: string,
  requestId: string,
): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(requestId)
  ) {
    return "printf '%s\\n' 'allowlisted approval request ID is invalid' >&2; exit 97";
  }
  return ALLOWLISTED_APPROVAL_CONNECT_SH.replace(
    "__NEMOCLAW_ALLOWLISTED_CLI__",
    shellQuote(cliPath),
  )
    .replace("__NEMOCLAW_ALLOWLISTED_SANDBOX__", shellQuote(sandboxName))
    .replace("__NEMOCLAW_ALLOWLISTED_REQUEST_ID__", shellQuote(requestId.toLowerCase()));
}
