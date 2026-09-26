// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

import { shellQuote } from "../../../src/lib/core/shell-quote.ts";
import { ADMIN_REQUEST_SELECTOR_PY } from "./admin-request-selector.ts";

const ADMIN_APPROVAL_CONNECT_SH = readFileSync(
  new URL("./admin-approval-connect.sh", import.meta.url),
  "utf8",
).trimEnd();

export function adminApprovalConnectScript(
  cliPath: string,
  sandboxName: string,
  cronName: string,
  expectedRequestId?: string,
): string {
  const cli = shellQuote(cliPath);
  const sandbox = shellQuote(sandboxName);
  const body = ADMIN_APPROVAL_CONNECT_SH.replace(
    "__NEMOCLAW_ADMIN_CRON_NAME__",
    shellQuote(cronName),
  )
    .replace("__NEMOCLAW_ADMIN_EXPECTED_REQUEST_ID__", shellQuote(expectedRequestId ?? ""))
    .replace("__NEMOCLAW_ADMIN_REQUEST_SELECTOR_PY__", ADMIN_REQUEST_SELECTOR_PY);
  return [
    "set -euo pipefail",
    `cat <<'NEMOCLAW_ADMIN_APPROVAL' | ${cli} ${sandbox} connect`,
    body,
    "NEMOCLAW_ADMIN_APPROVAL",
  ].join("\n");
}
