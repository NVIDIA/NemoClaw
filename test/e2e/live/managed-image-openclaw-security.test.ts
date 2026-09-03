// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { openclawProtectedImage } from "./managed-image-openclaw-security-helpers.ts";
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
        "verify packaged configuration repair and refusal",
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
        "id -nG gateway | tr ' ' '\n' | grep -qx sandbox",
        "id -nG root | tr ' ' '\n' | grep -qx sandbox",
        "gateway_control_rc=0",
        "/usr/local/bin/nemoclaw-gateway-control probe '0000000000000000000000000000000000000000000000000000000000000000' >/tmp/gateway-control.out 2>&1 || gateway_control_rc=$?",
        '[ "$gateway_control_rc" -ne 0 ]',
        "grep -qx SUPERVISOR_UNAVAILABLE /tmp/gateway-control.out",
        '/usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- sh -c \'printf " " >>/sandbox/.openclaw/openclaw.json; printf " " >>/sandbox/.openclaw/.config-hash\'',
        'for directory in /sandbox/.nemoclaw/state /sandbox/.nemoclaw/migration /sandbox/.nemoclaw/snapshots /sandbox/.nemoclaw/staging; do /usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- sh -c \'probe="$1/.nemoclaw-write-probe"; : >"$probe"; rm -f "$probe"\' sh "$directory"; done',
        'for path in /sandbox/.nemoclaw /sandbox/.nemoclaw/blueprints /usr/local/bin/nemoclaw-gateway-control; do ! /usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- test -w "$path"; done',
        "! /usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- test -x /usr/local/bin/nemoclaw-gateway-control",
      ].join("\n"),
      "managed-image-openclaw-isolation",
    );

    progress.phase("verify packaged configuration repair and refusal");
    await runContainer(
      host,
      image,
      [
        'sandbox_uid="$(id -u sandbox)"',
        'sandbox_gid="$(id -g sandbox)"',
        "chmod 700 /sandbox/.openclaw",
        "chmod 600 /sandbox/.openclaw/openclaw.json /sandbox/.openclaw/.config-hash",
        '/usr/local/lib/nemoclaw/normalize_mutable_config_perms.py /sandbox/.openclaw "$sandbox_uid" "$sandbox_gid"',
        '[ "$(stat -c \'%a %U:%G\' /sandbox/.openclaw)" = "2770 sandbox:sandbox" ]',
        '[ "$(stat -c \'%a %U:%G\' /sandbox/.openclaw/openclaw.json)" = "660 sandbox:sandbox" ]',
        "cp /sandbox/.openclaw/openclaw.json /sandbox/.openclaw/openclaw.json.last-good",
        "chown sandbox:sandbox /sandbox/.openclaw/openclaw.json.last-good",
        "chmod 660 /sandbox/.openclaw/openclaw.json.last-good",
        ": >/sandbox/.openclaw/openclaw.json",
        '/usr/local/lib/nemoclaw/normalize_mutable_config_perms.py /sandbox/.openclaw "$sandbox_uid" "$sandbox_gid" recover',
        "test -s /sandbox/.openclaw/openclaw.json",
        "chown gateway:gateway /sandbox/.openclaw",
        "before=\"$(stat -c '%u:%g:%a' /sandbox/.openclaw)\"",
        "repair_rc=0",
        '/usr/local/lib/nemoclaw/normalize_mutable_config_perms.py /sandbox/.openclaw "$sandbox_uid" "$sandbox_gid" || repair_rc=$?',
        '[ "$repair_rc" -ne 0 ]',
        '[ "$before" = "$(stat -c \'%u:%g:%a\' /sandbox/.openclaw)" ]',
      ].join("\n"),
      "managed-image-openclaw-config-recovery",
    );

    progress.phase("verify post-stepdown capability boundary");
    const capabilities = await runContainer(
      host,
      image,
      [
        "source /usr/local/lib/nemoclaw/sandbox-init.sh",
        'cat >/tmp/check-capabilities.sh <<\'NEMOCLAW_CAPABILITY_CHECK\'\nsource /usr/local/lib/nemoclaw/sandbox-init.sh\ncap_bnd="$(awk \'/^CapBnd:/{print $2}\' /proc/self/status)"\ntest -z "$(dangerous_caps_in_capbnd "$cap_bnd")"\nfor bit in 7 6 3; do test $(((16#$cap_bnd >> bit) & 1)) -eq 0; done\nprintf "CapBnd: %s\\n" "$cap_bnd"\nNEMOCLAW_CAPABILITY_CHECK',
        "drop_capabilities /bin/bash -c 'source /usr/local/lib/nemoclaw/sandbox-init.sh; exec \"${STEP_DOWN_PREFIX_SANDBOX[@]}\" /bin/bash /tmp/check-capabilities.sh'",
      ].join("\n"),
      "managed-image-openclaw-capabilities",
      [
        "--cap-add=CAP_SYS_ADMIN",
        "--cap-add=CAP_SYS_PTRACE",
        "--cap-add=CAP_NET_RAW",
        "--cap-add=CAP_DAC_OVERRIDE",
        "--cap-add=CAP_SYS_CHROOT",
        "--cap-add=CAP_FSETID",
        "--cap-add=CAP_SETFCAP",
        "--cap-add=CAP_MKNOD",
        "--cap-add=CAP_AUDIT_WRITE",
        "--cap-add=CAP_NET_BIND_SERVICE",
      ],
    );
    const match = /^CapBnd:\s*([a-fA-F0-9]+)$/mu.exec(capabilities.stdout);
    expect(match, "post-stepdown process must report CapBnd").not.toBeNull();

    progress.phase("record managed-image security evidence");
    await artifacts.writeJson("managed-image-security.json", {
      image,
      gatewayUid: Number(gatewayUid),
      sandboxUid: Number(sandboxUid),
      capabilityBoundingSet: match?.[1]?.toLowerCase(),
      dangerousCapabilitiesAbsent: "entrypoint inventory plus setuid, setgid, and kill",
    });
    await artifacts.target.complete({
      id: "managed-image-openclaw-security",
      status: "passed",
      image,
    });
  },
);
