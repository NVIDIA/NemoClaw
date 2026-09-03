// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  absentDangerousCapabilityBits,
  DANGEROUS_CAPABILITY_BITS,
  openclawProtectedImage,
} from "./managed-image-openclaw-security-helpers.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
async function runContainer(
  host: HostCliClient,
  image: string,
  script: string,
  artifactName: string,
  extraArgs: string[] = [],
) {
  return host.command(
    "docker",
    [
      "run",
      "--rm",
      "--user",
      "root",
      "--entrypoint",
      "/bin/bash",
      ...extraArgs,
      image,
      "-eu",
      "-c",
      script,
    ],
    { artifactName, captureLimitBytes: 1024 * 1024, timeoutMs: 120_000 },
  );
}

test(
  "enforces the OpenClaw managed-image sandbox boundary",
  {
    meta: {
      e2ePhases: [
        "verify final image identities and runtime tools",
        "verify cross-user process and filesystem isolation",
        "verify post-stepdown capability boundary",
        "record managed-image security evidence",
      ],
    },
  },
  async ({ artifacts, host, progress }) => {
    const image = openclawProtectedImage();

    progress.phase("verify final image identities and runtime tools");
    const identity = await runContainer(
      host,
      image,
      [
        'gateway_uid="$(id -u gateway)"',
        'sandbox_uid="$(id -u sandbox)"',
        '[ "$gateway_uid" != "$sandbox_uid" ]',
        "test -x /usr/bin/setpriv",
        "! command -v gosu",
        "test -x /usr/sbin/iptables",
        "test -x /usr/bin/chattr",
        "test -x /usr/local/bin/openclaw",
        'printf "%s:%s\\n" "$gateway_uid" "$sandbox_uid"',
      ].join("\n"),
      "managed-image-openclaw-identities",
    );
    const [gatewayUid, sandboxUid] = identity.stdout.trim().split(":");
    expect(gatewayUid).toMatch(/^[0-9]+$/u);
    expect(sandboxUid).toMatch(/^[0-9]+$/u);
    expect(gatewayUid).not.toBe(sandboxUid);

    progress.phase("verify cross-user process and filesystem isolation");
    await runContainer(
      host,
      image,
      [
        "/usr/bin/setpriv --reuid=gateway --regid=gateway --init-groups -- sleep 60 &",
        "gateway_pid=$!",
        'if /usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- kill "$gateway_pid" 2>/dev/null; then exit 20; fi',
        'kill "$gateway_pid"',
        'test "$(stat -c \'%U:%G %a\' /usr/local/bin/nemoclaw-gateway-control)" = "root:root 700"',
        'test "$(stat -c \'%U:%G %a\' /usr/local/lib/nemoclaw/managed-gateway-control.py)" = "root:root 500"',
        'test "$(stat -c \'%U:%G %a\' /usr/local/lib/nemoclaw/openclaw-config-guard.py)" = "root:root 500"',
        'test "$(stat -c \'%U:%G %a\' /usr/local/lib/nemoclaw/gateway-supervisor.sh)" = "root:root 444"',
        'test "$(stat -c \'%U:%G %a\' /usr/local/lib/nemoclaw/normalize_mutable_config_perms.py)" = "root:root 555"',
        "test -w /sandbox/.openclaw/openclaw.json",
        "test -w /sandbox/.openclaw/.config-hash",
        "test -w /sandbox/.nemoclaw/state",
        "test -w /sandbox/.nemoclaw/migration",
        "test -w /sandbox/.nemoclaw/snapshots",
        "test -w /sandbox/.nemoclaw/staging",
        "! /usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- test -w /sandbox/.nemoclaw",
        "! /usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- test -w /sandbox/.nemoclaw/blueprints",
        "! /usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- test -x /usr/local/bin/nemoclaw-gateway-control",
      ].join("\n"),
      "managed-image-openclaw-isolation",
    );

    progress.phase("verify post-stepdown capability boundary");
    const capabilities = await runContainer(
      host,
      image,
      [
        "source /usr/local/lib/nemoclaw/sandbox-init.sh",
        "drop_capabilities /bin/bash -c 'source /usr/local/lib/nemoclaw/sandbox-init.sh; exec \"${STEP_DOWN_PREFIX_SANDBOX[@]}\" grep ^CapBnd: /proc/self/status'",
      ].join("\n"),
      "managed-image-openclaw-capabilities",
      ["--cap-add=CAP_SYS_ADMIN", "--cap-add=CAP_SYS_PTRACE"],
    );
    const match = /^CapBnd:\s*([a-fA-F0-9]+)$/mu.exec(capabilities.stdout);
    expect(match, "post-stepdown process must report CapBnd").not.toBeNull();
    const bounding = BigInt("0x" + (match?.[1] ?? "0"));
    expect(absentDangerousCapabilityBits(bounding)).toEqual(DANGEROUS_CAPABILITY_BITS);

    progress.phase("record managed-image security evidence");
    await artifacts.writeJson("managed-image-security.json", {
      image,
      gatewayUid: Number(gatewayUid),
      sandboxUid: Number(sandboxUid),
      capabilityBoundingSet: match?.[1]?.toLowerCase(),
      dangerousCapabilityBitsAbsent: DANGEROUS_CAPABILITY_BITS,
    });
    await artifacts.target.complete({
      id: "managed-image-openclaw-security",
      status: "passed",
      image,
    });
  },
);
