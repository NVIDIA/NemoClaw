// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import path from "node:path";

import { ROOT } from "../../state/paths";

// Allow container execution and Python startup/teardown outside the native
// five-minute lease window. The observer itself still waits at most 300 seconds.
export const OPENCLAW_OWNER_LEASE_EXECUTION_TIMEOUT_MS = 330_000;

/**
 * Ship the host's canonical state reader, as pairing recovery does, so existing
 * images need no new Python API. The native gateway owns lease reclamation;
 * this read-only observer retains startup hold until native expiry.
 */
export function buildOpenClawOwnerLeaseObserver(): string {
  const reader = readFileSync(
    path.join(ROOT, "scripts", "lib", "openclaw_pairing_state.py"),
    "utf8",
  );
  return `${reader}
import pwd
account = pwd.getpwnam("sandbox")
if os.geteuid() == 0:
    os.setgroups([])
    os.setgid(account.pw_gid)
    os.setuid(account.pw_uid)
wait_for_openclaw_owner_lease("/sandbox/.openclaw")
`;
}
