// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";

import { ROOT } from "../../state/paths";

// Allow container and interpreter startup/teardown outside the native
// five-minute lease window. The observer itself still waits at most 300 seconds.
export const OPENCLAW_OWNER_LEASE_EXECUTION_TIMEOUT_MS = 330_000;

/**
 * Ship the shared native observer so installed images need no new helper API.
 * Older reviewed images retain the conservative descriptor-pinned lease wait.
 * Neither path reclaims locks or releases the startup hold.
 */
export function buildOpenClawOwnerLeaseObserver(): string {
  const reader = readFileSync(
    path.join(ROOT, "scripts", "lib", "openclaw_pairing_state.py"),
    "utf8",
  );
  const nativeObserver = stripTypeScriptTypes(
    readFileSync(path.join(ROOT, "scripts", "lib", "openclaw-gateway-owner.mts"), "utf8"),
  );
  const nativeProgram = `${nativeObserver}
try {
  await waitForOpenClawGatewayOwner("/usr/local/lib/node_modules/openclaw", { budgetMs: 300_000 });
} catch {
  process.stderr.write("OpenClaw native ownership inspection failed\\n");
  process.exitCode = 1;
}
`;
  return `${reader}
import pwd
account = pwd.getpwnam("sandbox")
if os.geteuid() == 0:
    os.setgroups([])
    os.setgid(account.pw_gid)
    os.setuid(account.pw_uid)
# Never load runtime modules with root privileges or a host environment.
with open("/usr/local/lib/node_modules/openclaw/package.json", encoding="utf8") as package:
    runtime = json.load(package)
if runtime.get("name") != "openclaw":
    raise RuntimeError("Unexpected ownership runtime")
if runtime.get("version") == "2026.10.5":
    import subprocess
    subprocess.run(
        ["/usr/local/bin/node", "--input-type=module", "-"],
        input=${JSON.stringify(nativeProgram)}, text=True, check=True, timeout=315,
        env={"HOME": "/sandbox", "OPENCLAW_STATE_DIR": "/sandbox/.openclaw",
             "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"},
    )
elif runtime.get("version") in ("2026.9.2", "2026.9.5", "2026.9.7"):
    wait_for_openclaw_owner_lease("/sandbox/.openclaw")
else:
    raise RuntimeError("Unreviewed ownership runtime")
`;
}
