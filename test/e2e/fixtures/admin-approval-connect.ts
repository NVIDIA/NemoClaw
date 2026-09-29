// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

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
  verifyCronConsumer = true,
): string {
  const cli = shellQuote(cliPath);
  const sandbox = shellQuote(sandboxName);
  const body = ADMIN_APPROVAL_CONNECT_SH.replace(
    "__NEMOCLAW_ADMIN_CRON_NAME__",
    shellQuote(cronName),
  )
    .replace("__NEMOCLAW_ADMIN_EXPECTED_REQUEST_ID__", shellQuote(expectedRequestId ?? ""))
    .replace("__NEMOCLAW_ADMIN_VERIFY_CRON__", verifyCronConsumer ? "1" : "0")
    .replace("__NEMOCLAW_ADMIN_REQUEST_SELECTOR_PY__", ADMIN_REQUEST_SELECTOR_PY);
  const digest = createHash("sha256").update(body).digest("hex");
  // Read once and verify those bytes before evaluating them in the prepared
  // shell. A replaced temporary file must never become an approval command.
  const readVerifiedScript = `python3 -c ${shellQuote(
    `import hashlib, sys; raw=open(sys.argv[1], "rb").read(${Buffer.byteLength(body) + 2}); raw=raw.removesuffix(b"\\n"); hashlib.sha256(raw).hexdigest() == sys.argv[2] or sys.exit("ADMIN_SCRIPT_INTEGRITY_FAILED"); sys.stdout.buffer.write(raw)`,
  )}`;
  const connectPrefix = `approval_body=$(${readVerifiedScript} `;
  // The body owns an EXIT trap and calls exit. A subshell inherits the prepared
  // functions without letting that exit unwind the interactive shell's eval.
  const connectSuffix = ` ${shellQuote(digest)}) && ( eval "$approval_body" ); exit $?`;
  return [
    "set -euo pipefail",
    // Connect allocates an interactive terminal. Its line editor can corrupt a
    // bulk heredoc, so transfer the script through exec's non-terminal stdin.
    "approval_script=$(",
    `cat <<'NEMOCLAW_ADMIN_APPROVAL' | ${cli} ${sandbox} exec --stdin -- python3 -c ${shellQuote(
      [
        "import os, sys, tempfile",
        'fd, name = tempfile.mkstemp(prefix="nemoclaw-admin-approval-", suffix=".sh", dir="/tmp")',
        "try:",
        '    with os.fdopen(fd, "wb") as script: script.write(sys.stdin.buffer.read())',
        "except BaseException:",
        "    os.unlink(name)",
        "    raise",
        "print(name)",
      ].join("\n"),
    )}`,
    body,
    "NEMOCLAW_ADMIN_APPROVAL",
    ")",
    '[[ "$approval_script" =~ ^/tmp/nemoclaw-admin-approval-[a-zA-Z0-9_]+[.]sh$ ]] || exit 31',
    "cleanup_admin_script() {",
    "  approval_status=$?",
    "  trap - EXIT",
    `  if ! ${cli} ${sandbox} exec -- rm -f -- "$approval_script"; then`,
    '    echo "ADMIN_SCRIPT_CLEANUP_FAILED" >&2',
    "    exit 32",
    "  fi",
    '  exit "$approval_status"',
    "}",
    "trap cleanup_admin_script EXIT",
    // Only the validated generated path is expanded on the host. The script
    // body and status variables belong to the prepared shell, not this shell.
    `printf '%s%s%s\n' ${shellQuote(connectPrefix)} "$approval_script" ${shellQuote(connectSuffix)} | ${cli} ${sandbox} connect`,
  ].join("\n");
}
