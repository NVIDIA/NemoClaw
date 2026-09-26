// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

import { shellQuote } from "../../../src/lib/core/shell-quote.ts";

const ALLOWLISTED_APPROVAL_CONNECT_SH = readFileSync(
  new URL("./allowlisted-approval-connect.sh", import.meta.url),
  "utf8",
).trimEnd();

export function allowlistedApprovalConnectScript(cliPath: string, sandboxName: string): string {
  return ALLOWLISTED_APPROVAL_CONNECT_SH.replace(
    "__NEMOCLAW_ALLOWLISTED_CLI__",
    shellQuote(cliPath),
  ).replace("__NEMOCLAW_ALLOWLISTED_SANDBOX__", shellQuote(sandboxName));
}
