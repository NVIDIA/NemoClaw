// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";

import { openclawProtectedImage } from "./managed-image-openclaw-security.ts";
import type { HostCliClient } from "../e2e/fixtures/clients/host.ts";
import { expect, test } from "../e2e/fixtures/e2e-test.ts";

function managedImageCohort(): string {
  return (
    process.env.NEMOCLAW_PROTECTED_MANAGED_IMAGE_COHORT ??
    process.env.NEMOCLAW_MANAGED_IMAGE_SECURITY_COHORT ??
    `local-${process.pid}`
  );
}
async function runContainer(
  host: HostCliClient,
  image: string,
  script: string,
  artifactName: string,
  extraArgs: string[] = [],
) {
  const result = await host.command(
    "docker",
    [
      "run",
      "--rm",
      "--label",
      `io.nvidia.nemoclaw.managed-image.cohort=${managedImageCohort()}`,
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
  expect(
    result.exitCode,
    `${artifactName} failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).toBe(0);
  return result;
}

async function runDefaultContainer(
  host: HostCliClient,
  image: string,
  dockerArgs: string[],
  command: string[],
  artifactName: string,
  expectedExitCode = 0,
) {
  const result = await host.command(
    "docker",
    [
      "run",
      "--rm",
      "--label",
      `io.nvidia.nemoclaw.managed-image.cohort=${managedImageCohort()}`,
      ...dockerArgs,
      image,
      ...command,
    ],
    { artifactName, captureLimitBytes: 1024 * 1024, timeoutMs: 120_000 },
  );
  expect(
    result.exitCode,
    `${artifactName} failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).toBe(expectedExitCode);
  return result;
}

test(
  "enforces the OpenClaw managed-image sandbox boundary",
  {
    timeout: 120_000,
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
        `grep -Fqx 'export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"' /usr/local/bin/nemoclaw-start`,
        "cd /sandbox/.openclaw && sha256sum -c .config-hash >/dev/null",
        `python3 -c 'import json; assert json.load(open("/sandbox/.openclaw/openclaw.json"))["update"]["checkOnStart"] is False'`,
        'printf "%s:%s\\n" "$gateway_uid" "$sandbox_uid"',
      ].join("\n"),
      "managed-image-openclaw-identities",
    );
    const imageUser = await host.command(
      "docker",
      ["image", "inspect", "--format", "{{.Config.User}}", image],
      { artifactName: "managed-image-openclaw-default-user" },
    );
    expect(imageUser.exitCode, imageUser.stderr).toBe(0);
    expect(["sandbox", "root"]).toContain(imageUser.stdout.trim());
    await runDefaultContainer(
      host,
      image,
      ["--security-opt", "no-new-privileges"],
      ["true"],
      "managed-image-openclaw-no-new-privileges",
    );

    const [gatewayUid, sandboxUid] = identity.stdout.trim().split(":");
    expect(gatewayUid).toMatch(/^[0-9]+$/u);
    expect(sandboxUid).toMatch(/^[0-9]+$/u);
    expect(gatewayUid).not.toBe(sandboxUid);
    await runContainer(
      host,
      image,
      `printf %s aW1wb3J0IGZzIGZyb20gIm5vZGU6ZnMiOwppbXBvcnQgb3MgZnJvbSAibm9kZTpvcyI7CmltcG9ydCBwYXRoIGZyb20gIm5vZGU6cGF0aCI7CmltcG9ydCB7IGNyZWF0ZVJlcXVpcmUgfSBmcm9tICJub2RlOm1vZHVsZSI7CmNvbnN0IHJlcXVpcmUgPSBjcmVhdGVSZXF1aXJlKCIvb3B0L25lbW9jbGF3LyIpOwpjb25zdCBZQU1MID0gcmVxdWlyZSgieWFtbCIpOwpjb25zdCBibHVlcHJpbnQgPSBZQU1MLnBhcnNlKGZzLnJlYWRGaWxlU3luYygiL29wdC9uZW1vY2xhdy1ibHVlcHJpbnQvYmx1ZXByaW50LnlhbWwiLCAidXRmOCIpKTsKaWYgKGJsdWVwcmludC52ZXJzaW9uICE9PSAiMC4xLjAiKSB0aHJvdyBuZXcgRXJyb3IoInVuZXhwZWN0ZWQgYmx1ZXByaW50IHZlcnNpb24iKTsKY29uc3QgcHJvZmlsZXMgPSBibHVlcHJpbnQuY29tcG9uZW50cz8uaW5mZXJlbmNlPy5wcm9maWxlcyA/PyB7fTsKZm9yIChjb25zdCBuYW1lIG9mIGJsdWVwcmludC5wcm9maWxlcyA/PyBbXSkgaWYgKCFwcm9maWxlc1tuYW1lXSkgdGhyb3cgbmV3IEVycm9yKGBtaXNzaW5nIHByb2ZpbGU6ICR7bmFtZX1gKTsKY29uc3QgcG9saWN5ID0gWUFNTC5wYXJzZShmcy5yZWFkRmlsZVN5bmMoIi9vcHQvbmVtb2NsYXctYmx1ZXByaW50L3BvbGljaWVzL29wZW5jbGF3LXNhbmRib3gueWFtbCIsICJ1dGY4IikpOwppZiAoIXBvbGljeS52ZXJzaW9uIHx8ICFwb2xpY3kubmV0d29ya19wb2xpY2llcykgdGhyb3cgbmV3IEVycm9yKCJpbnZhbGlkIHBhY2thZ2VkIHBvbGljeSIpOwpjb25zdCBmaXh0dXJlID0gZnMubWtkdGVtcFN5bmMocGF0aC5qb2luKG9zLnRtcGRpcigpLCAiYmx1ZXByaW50LXBsYW4tIikpOwpmcy53cml0ZUZpbGVTeW5jKHBhdGguam9pbihmaXh0dXJlLCAiYmx1ZXByaW50LnlhbWwiKSwgImNvbXBvbmVudHM6XG4gIGluZmVyZW5jZTpcbiAgICBwcm9maWxlczpcbiAgICAgIGRlZmF1bHQ6IHt9XG4iKTsKcHJvY2Vzcy5lbnYuTkVNT0NMQVdfQkxVRVBSSU5UX1BBVEggPSBmaXh0dXJlOwpjb25zdCB7IG1haW4gfSA9IGF3YWl0IGltcG9ydCgiL29wdC9uZW1vY2xhdy9kaXN0L2JsdWVwcmludC9ydW5uZXIuanMiKTsKbGV0IGV4cGVjdGVkRmFpbHVyZSA9IGZhbHNlOwp0cnkgeyBhd2FpdCBtYWluKFsicGxhbiIsICItLXByb2ZpbGUiLCAiZGVmYXVsdCIsICItLWRyeS1ydW4iXSk7IH0gY2F0Y2ggKGVycm9yKSB7CiAgZXhwZWN0ZWRGYWlsdXJlID0gU3RyaW5nKGVycm9yPy5tZXNzYWdlKS5pbmNsdWRlcygib3BlbnNoZWxsIENMSSBub3QgZm91bmQiKTsKfQppZiAoIWV4cGVjdGVkRmFpbHVyZSkgdGhyb3cgbmV3IEVycm9yKCJwYWNrYWdlZCBydW5uZXIgZGlkIG5vdCByZWFjaCBleHBlY3RlZCBPcGVuU2hlbGwgcHJlcmVxdWlzaXRlIik7CmNvbnN0IGhvbWUgPSBmcy5ta2R0ZW1wU3luYyhwYXRoLmpvaW4ob3MudG1wZGlyKCksICJzbmFwc2hvdC1ob21lLSIpKTsKcHJvY2Vzcy5lbnYuSE9NRSA9IGhvbWU7CmNvbnN0IHN0YXRlID0gcGF0aC5qb2luKGhvbWUsICIub3BlbmNsYXciKTsKZnMubWtkaXJTeW5jKHN0YXRlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTsKZnMud3JpdGVGaWxlU3luYyhwYXRoLmpvaW4oc3RhdGUsICJvcGVuY2xhdy5qc29uIiksICd7ImZpeHR1cmUiOnRydWV9XG4nKTsKY29uc3QgeyBjcmVhdGVTbmFwc2hvdCwgbGlzdFNuYXBzaG90cywgcm9sbGJhY2tGcm9tU25hcHNob3QgfSA9IGF3YWl0IGltcG9ydCgiL29wdC9uZW1vY2xhdy9kaXN0L2JsdWVwcmludC9zbmFwc2hvdC5qcyIpOwpjb25zdCBzbmFwc2hvdCA9IGNyZWF0ZVNuYXBzaG90KCk7CmlmICghc25hcHNob3QgfHwgbGlzdFNuYXBzaG90cygpLmxlbmd0aCAhPT0gMSkgdGhyb3cgbmV3IEVycm9yKCJwYWNrYWdlZCBzbmFwc2hvdCBjcmVhdGlvbiBmYWlsZWQiKTsKZnMud3JpdGVGaWxlU3luYyhwYXRoLmpvaW4oc3RhdGUsICJvcGVuY2xhdy5qc29uIiksICd7ImNvcnJ1cHRlZCI6dHJ1ZX1cbicpOwppZiAoIXJvbGxiYWNrRnJvbVNuYXBzaG90KHNuYXBzaG90KSkgdGhyb3cgbmV3IEVycm9yKCJwYWNrYWdlZCBzbmFwc2hvdCByb2xsYmFjayBmYWlsZWQiKTsKaWYgKEpTT04ucGFyc2UoZnMucmVhZEZpbGVTeW5jKHBhdGguam9pbihzdGF0ZSwgIm9wZW5jbGF3Lmpzb24iKSwgInV0ZjgiKSkuZml4dHVyZSAhPT0gdHJ1ZSkgdGhyb3cgbmV3IEVycm9yKCJzbmFwc2hvdCBjb250ZW50IHdhcyBub3QgcmVzdG9yZWQiKTsK | base64 -d >/tmp/packaged-image-contract.mjs; node /tmp/packaged-image-contract.mjs`,
      "managed-image-openclaw-packaged-blueprint-contract",
    );

    progress.phase("verify cross-user process and filesystem isolation");
    await runContainer(
      host,
      image,
      [
        "{ sed -n '/^_nemoclaw_safe_replace_tmp_file() {$/,/^}$/p' /usr/local/bin/nemoclaw-start; sed -n '/^_nemoclaw_safe_create_tmp_file() {$/,/^}$/p' /usr/local/bin/nemoclaw-start; sed -n '/^prepare_auto_pair_log() {$/,/^}$/p' /usr/local/bin/nemoclaw-start; } >/tmp/prepare-auto-pair-files.sh",
        "source /tmp/prepare-auto-pair-files.sh",
        "prepare_auto_pair_log",
        "printf 'export NEMOCLAW_PROXY_PROBE=https://probe.invalid:9999\n' >/tmp/nemoclaw-proxy-env.sh",
        "chown root:root /tmp/nemoclaw-proxy-env.sh",
        "chmod 444 /tmp/nemoclaw-proxy-env.sh",
        "! /usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- test -r /tmp/auto-pair.log",
        "/usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- sh -c 'printf %s eyJzY2hlbWFWZXJzaW9uIjoxLCJzdGF0ZSI6ImFwcHJvdmFsLWNvbXBsZXRlZCJ9 | base64 -d >/tmp/nemoclaw-auto-pair-status.json'",
        `grep -Fqx '{"schemaVersion":1,"state":"approval-completed"}' /tmp/nemoclaw-auto-pair-status.json`,
        `[ "$(bash -ic 'echo $NEMOCLAW_PROXY_PROBE' 2>/dev/null)" = "https://probe.invalid:9999" ]`,
        `[ "$(bash -lc 'echo $NEMOCLAW_PROXY_PROBE' 2>/dev/null)" = "https://probe.invalid:9999" ]`,
        `[ "$(/usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- bash -ic 'echo $NEMOCLAW_PROXY_PROBE' 2>/dev/null)" = "https://probe.invalid:9999" ]`,
        `[ "$(/usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- bash -lc 'echo $NEMOCLAW_PROXY_PROBE' 2>/dev/null)" = "https://probe.invalid:9999" ]`,
        "! grep -Eiq 'proxy|nemoclaw-proxy-env' /sandbox/.bashrc /sandbox/.profile",
      ].join("\n"),
      "managed-image-openclaw-packaged-entrypoint-boundaries",
    );

    await runContainer(
      host,
      image,
      [
        "/usr/bin/setpriv --reuid=gateway --regid=gateway --init-groups -- sleep 60 &",
        "gateway_pid=$!",
        'if /usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- kill "$gateway_pid" 2>/dev/null; then exit 20; fi',
        'kill "$gateway_pid"',
        "printf secret >/tmp/auto-pair.log",
        "chown root:root /tmp/auto-pair.log",
        "chmod 600 /tmp/auto-pair.log",
        "printf '{}\n' >/tmp/nemoclaw-auto-pair-status.json",
        "chown sandbox:sandbox /tmp/nemoclaw-auto-pair-status.json",
        "chmod 600 /tmp/nemoclaw-auto-pair-status.json",
        "printf '# proxy environment\n' >/tmp/nemoclaw-proxy-env.sh",
        "chown root:root /tmp/nemoclaw-proxy-env.sh",
        "chmod 444 /tmp/nemoclaw-proxy-env.sh",
        `[ "$(stat -c '%F %U:%G %a' /tmp/nemoclaw-proxy-env.sh)" = "regular file root:root 444" ]`,
        "! /usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- test -r /tmp/auto-pair.log",
        `/usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- sh -c 'printf "{}\n" >/tmp/nemoclaw-auto-pair-status.json'`,
        "! /usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- sh -c 'printf x >>/tmp/nemoclaw-proxy-env.sh'",
        "! /usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- sh -c 'rm -f /tmp/nemoclaw-proxy-env.sh'",
        "gateway_control_rc=0",
        "/usr/local/bin/nemoclaw-gateway-control probe '0000000000000000000000000000000000000000000000000000000000000000' >/tmp/gateway-control.out 2>&1 || gateway_control_rc=$?",
        '[ "$gateway_control_rc" -ne 0 ]',
        "grep -qx SUPERVISOR_UNAVAILABLE /tmp/gateway-control.out",
        '/usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- sh -c \'printf " " >>/sandbox/.openclaw/openclaw.json; printf " " >>/sandbox/.openclaw/.config-hash\'',
        'for directory in /sandbox/.nemoclaw/state /sandbox/.nemoclaw/migration /sandbox/.nemoclaw/snapshots /sandbox/.nemoclaw/staging; do /usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- sh -c \'probe="$1/.nemoclaw-write-probe"; : >"$probe"; rm -f "$probe"\' sh "$directory"; done',
        `/usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- sh -c 'original=$(cat /sandbox/.nemoclaw/config.json); printf "{}\n" >/sandbox/.nemoclaw/config.json; printf "%s" "$original" >/sandbox/.nemoclaw/config.json'`,
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

    await runContainer(
      host,
      image,
      [
        '{ sed -n "/^resolve_mutable_config_normalizer() {$/,/^}$/p" /usr/local/bin/nemoclaw-start; sed -n "/^normalize_mutable_config_perms() {$/,/^}$/p" /usr/local/bin/nemoclaw-start; sed -n "/^recover_openclaw_config_if_empty() {$/,/^}$/p" /usr/local/bin/nemoclaw-start; } >/tmp/normalize.sh',
        "source /tmp/normalize.sh",
        "/usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- sh -c 'printf baseline > /sandbox/.openclaw/openclaw.json.nemoclaw-baseline; chmod 600 /sandbox/.openclaw/openclaw.json.nemoclaw-baseline; : > /sandbox/.openclaw/openclaw.json; chmod 600 /sandbox/.openclaw/openclaw.json /sandbox/.openclaw/.config-hash; chmod 700 /sandbox/.openclaw'",
        "normalize_mutable_config_perms",
        "recover_openclaw_config_if_empty",
        '[ "$(stat -c \'%a %U:%G\' /sandbox/.openclaw)" = "2770 sandbox:sandbox" ]',
        '[ "$(stat -c \'%a %U:%G\' /sandbox/.openclaw/openclaw.json)" = "660 sandbox:sandbox" ]',
        '[ "$(stat -c \'%a %U:%G\' /sandbox/.openclaw/.config-hash)" = "660 sandbox:sandbox" ]',
        "grep -qx baseline /sandbox/.openclaw/openclaw.json",
        "/usr/bin/setpriv --reuid=gateway --regid=gateway --init-groups -- sh -c 'printf \" \" >>/sandbox/.openclaw/openclaw.json'",
      ].join("\n"),
      "managed-image-openclaw-dac-recovery",
      ["--cap-drop=CAP_DAC_OVERRIDE"],
    );

    await runContainer(
      host,
      image,
      [
        "normalizer=/usr/local/lib/nemoclaw/normalize_mutable_config_perms.py",
        "printf protected >/sandbox/protected-target",
        "chown root:root /sandbox/protected-target",
        "chmod 600 /sandbox/protected-target",
        "rm -f /sandbox/.openclaw/openclaw.json",
        "ln -s /sandbox/protected-target /sandbox/.openclaw/openclaw.json",
        "before=\"$(stat -c '%u:%g:%a' /sandbox/protected-target):$(cat /sandbox/protected-target)\"",
        'if "$normalizer" /sandbox/.openclaw "$(id -u sandbox)" "$(id -g sandbox)"; then exit 31; fi',
        '[ "$before" = "$(stat -c \'%u:%g:%a\' /sandbox/protected-target):$(cat /sandbox/protected-target)" ]',
        "[ -L /sandbox/.openclaw/openclaw.json ]",
        "rm /sandbox/.openclaw/openclaw.json",
        "printf protected >/sandbox/hardlink-target",
        "chown sandbox:sandbox /sandbox/hardlink-target",
        "chmod 600 /sandbox/hardlink-target",
        "ln /sandbox/hardlink-target /sandbox/.openclaw/openclaw.json",
        "before=\"$(stat -c '%u:%g:%a:%h' /sandbox/hardlink-target):$(cat /sandbox/hardlink-target)\"",
        'if "$normalizer" /sandbox/.openclaw "$(id -u sandbox)" "$(id -g sandbox)"; then exit 32; fi',
        '[ "$before" = "$(stat -c \'%u:%g:%a:%h\' /sandbox/hardlink-target):$(cat /sandbox/hardlink-target)" ]',
      ].join("\n"),
      "managed-image-openclaw-link-refusal",
    );

    await runContainer(
      host,
      image,
      [
        '{ sed -n "/^resolve_mutable_config_normalizer() {$/,/^}$/p" /usr/local/bin/nemoclaw-start | sed "s#/usr/local/lib/nemoclaw/normalize_mutable_config_perms.py#/tmp/missing-normalizer.py#"; sed -n "/^normalize_mutable_config_perms() {$/,/^}$/p" /usr/local/bin/nemoclaw-start; } >/tmp/normalize.sh',
        "source /tmp/normalize.sh",
        'printf \'from pathlib import Path\nPath("/tmp/untrusted-normalizer-ran").write_text("unsafe\\n")\n\' >/tmp/untrusted-normalizer.py',
        "export NEMOCLAW_MUTABLE_CONFIG_NORMALIZER=/tmp/untrusted-normalizer.py",
        "rc=0; normalize_mutable_config_perms || rc=$?",
        '[ "$rc" -eq 1 ]',
        "[ ! -e /tmp/untrusted-normalizer-ran ]",
      ].join("\n"),
      "managed-image-openclaw-helper-refusal",
    );

    await runContainer(
      host,
      image,
      [
        "printf '{}\\n' >/sandbox/.openclaw/openclaw.json",
        "printf 'hash\\n' >/sandbox/.openclaw/.config-hash",
        "chmod 600 /sandbox/.openclaw/openclaw.json /sandbox/.openclaw/.config-hash",
        "before=\"$(stat -c '%u:%g:%a' /sandbox/.openclaw /sandbox/.openclaw/openclaw.json /sandbox/.openclaw/.config-hash)\"",
        'rc=0; /usr/local/lib/nemoclaw/normalize_mutable_config_perms.py /sandbox/.openclaw "$(id -u sandbox)" "$(id -g sandbox)" || rc=$?',
        '[ "$rc" -ne 0 ]',
        '[ "$before" = "$(stat -c \'%u:%g:%a\' /sandbox/.openclaw /sandbox/.openclaw/openclaw.json /sandbox/.openclaw/.config-hash)" ]',
      ].join("\n"),
      "managed-image-openclaw-mounted-tree-refusal",
      ["--tmpfs", "/sandbox/.openclaw:rw,mode=700,uid=0,gid=0"],
    );

    await runContainer(
      host,
      image,
      [
        "printf %s ZnJvbSBwYXRobGliIGltcG9ydCBQYXRoCnNvdXJjZSA9IFBhdGgoIi91c3IvbG9jYWwvbGliL25lbW9jbGF3L25vcm1hbGl6ZV9tdXRhYmxlX2NvbmZpZ19wZXJtcy5weSIpLnJlYWRfdGV4dCgpCm5lZWRsZSA9ICIgICAgICAgICAgICByaWdodHNfZmRzID0gW3Jvb3RfZmRdXG4iCnJlcGxhY2VtZW50ID0gIiIiICAgICAgICAgICAgZm9yIHJlcXVpcmVkX25hbWUgaW4gKCJvcGVuY2xhdy5qc29uIiwgIi5jb25maWctaGFzaCIpOgogICAgICAgICAgICAgICAgb3MudW5saW5rKG9zLnBhdGguam9pbihjb25maWdfZGlyLCByZXF1aXJlZF9uYW1lKSkKICAgICAgICAgICAgb3Mucm1kaXIoY29uZmlnX2RpcikKICAgICAgICAgICAgb3MubWtkaXIoY29uZmlnX2RpciwgMG83MDApCiAgICAgICAgICAgIGZvciBuYW1lLCBjb250ZW50IGluICgoIm9wZW5jbGF3Lmpzb24iLCAie31cXG4iKSwgKCIuY29uZmlnLWhhc2giLCAiaGFzaFxcbiIpKToKICAgICAgICAgICAgICAgIHBhdGggPSBvcy5wYXRoLmpvaW4oY29uZmlnX2RpciwgbmFtZSkKICAgICAgICAgICAgICAgIHdpdGggb3BlbihwYXRoLCAidyIsIGVuY29kaW5nPSJ1dGYtOCIpIGFzIHJlcGxhY2VtZW50X2ZpbGU6CiAgICAgICAgICAgICAgICAgICAgcmVwbGFjZW1lbnRfZmlsZS53cml0ZShjb250ZW50KQogICAgICAgICAgICAgICAgb3MuY2htb2QocGF0aCwgMG82MDApCiAgICAgICAgICAgIHJpZ2h0c19mZHMgPSBbcm9vdF9mZF0KIiIiCmlmIHNvdXJjZS5jb3VudChuZWVkbGUpICE9IDE6CiAgICByYWlzZSBTeXN0ZW1FeGl0KCJoYW5kb2ZmIGluamVjdGlvbiBwb2ludCBjaGFuZ2VkIikKUGF0aCgiL3RtcC9ub3JtYWxpemVyLWhhbmRvZmYtcmFjZS5weSIpLndyaXRlX3RleHQoc291cmNlLnJlcGxhY2UobmVlZGxlLCByZXBsYWNlbWVudCkpCg== | base64 -d | python3 -",
        "find /sandbox/.openclaw -mindepth 1 -delete",
        '/usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- sh -c \'printf "{}\\n" > /sandbox/.openclaw/openclaw.json; printf "hash\\n" > /sandbox/.openclaw/.config-hash; chmod 600 /sandbox/.openclaw/openclaw.json /sandbox/.openclaw/.config-hash; chmod 700 /sandbox/.openclaw\'',
        'rc=0; python3 -I /tmp/normalizer-handoff-race.py /sandbox/.openclaw "$(id -u sandbox)" "$(id -g sandbox)" || rc=$?',
        '[ "$rc" -ne 0 ]',
        "[ \"$(stat -c '%a' /sandbox/.openclaw)\" = 700 ]",
        "[ \"$(stat -c '%a' /sandbox/.openclaw/openclaw.json)\" = 600 ]",
        "[ ! -e /sandbox/.openclaw/openclaw.json.nemoclaw-baseline ]",
      ].join("\n"),
      "managed-image-openclaw-replacement-refusal",
    );

    const cohort = managedImageCohort();
    const uniqueSuffix = randomUUID();
    const repairVolume = `nemoclaw-entrypoint-repair-${cohort}-${uniqueSuffix}`;
    const refusalVolume = `nemoclaw-entrypoint-refusal-${cohort}-${uniqueSuffix}`;
    let repairVolumeCreated = false;
    let refusalVolumeCreated = false;
    try {
      const repairCreate = await host.command(
        "docker",
        [
          "volume",
          "create",
          "--label",
          `io.nvidia.nemoclaw.managed-image.cohort=${cohort}`,
          repairVolume,
        ],
        { artifactName: "managed-image-openclaw-create-repair-volume" },
      );
      expect(repairCreate.exitCode).toBe(0);
      const repairLabel = await host.command(
        "docker",
        [
          "volume",
          "inspect",
          "--format",
          '{{ index .Labels "io.nvidia.nemoclaw.managed-image.cohort" }}',
          repairVolume,
        ],
        { artifactName: "managed-image-openclaw-inspect-repair-volume" },
      );
      expect(repairLabel.stdout.trim()).toBe(cohort);
      repairVolumeCreated = true;
      const refusalCreate = await host.command(
        "docker",
        [
          "volume",
          "create",
          "--label",
          `io.nvidia.nemoclaw.managed-image.cohort=${cohort}`,
          refusalVolume,
        ],
        { artifactName: "managed-image-openclaw-create-refusal-volume" },
      );
      expect(refusalCreate.exitCode).toBe(0);
      const refusalLabel = await host.command(
        "docker",
        [
          "volume",
          "inspect",
          "--format",
          '{{ index .Labels "io.nvidia.nemoclaw.managed-image.cohort" }}',
          refusalVolume,
        ],
        { artifactName: "managed-image-openclaw-inspect-refusal-volume" },
      );
      expect(refusalLabel.stdout.trim()).toBe(cohort);
      refusalVolumeCreated = true;
      await runContainer(
        host,
        image,
        [
          "rm -f /sandbox/.openclaw/openclaw.json.nemoclaw-baseline /sandbox/.openclaw/openclaw.json.last-good",
          "printf '{}\n' >/sandbox/.openclaw/openclaw.json",
          "chown -R sandbox:sandbox /sandbox/.openclaw",
          "chmod 600 /sandbox/.openclaw/openclaw.json /sandbox/.openclaw/.config-hash",
          "chmod 2770 /sandbox/.openclaw",
          "mkdir -p /sandbox/.openclaw/bin",
          `printf %s dGVzdCAiJChpZCAtdW4pIiA9IHNhbmRib3gKdGVzdCAiJChzdGF0IC1jICclYSAlVTolRycgL3NhbmRib3gvLm9wZW5jbGF3KSIgPSAnMjc3MCBzYW5kYm94OnNhbmRib3gnCnRlc3QgIiQoc3RhdCAtYyAnJWEgJVU6JUcnIC9zYW5kYm94Ly5vcGVuY2xhdy9vcGVuY2xhdy5qc29uKSIgPSAnNjYwIHNhbmRib3g6c2FuZGJveCcKZ3JlcCAtcXggJ3t9JyAvc2FuZGJveC8ub3BlbmNsYXcvb3BlbmNsYXcuanNvbgpjYXBfYm5kPSQoYXdrICcvXkNhcEJuZDove3ByaW50ICQyfScgL3Byb2Mvc2VsZi9zdGF0dXMpCnRlc3QgIiRjYXBfYm5kIiA9IDAwMDAwMDAwMDAwMDAxMDAK | base64 -d >/sandbox/.openclaw/bin/entrypoint-security-proof`,
          "chmod 755 /sandbox/.openclaw/bin/entrypoint-security-proof",
        ].join("\n"),
        "managed-image-openclaw-prepare-entrypoint-repair",
        ["--volume", `${repairVolume}:/sandbox/.openclaw`],
      );
      await runDefaultContainer(
        host,
        image,
        ["--user", "root", "--volume", `${repairVolume}:/sandbox/.openclaw`],
        ["/sandbox/.openclaw/bin/entrypoint-security-proof"],
        "managed-image-openclaw-default-entrypoint-repair",
      );

      await runContainer(
        host,
        image,
        [
          "rm -f /sandbox/.openclaw/openclaw.json",
          "printf protected >/sandbox/.openclaw/protected-target",
          "ln -s protected-target /sandbox/.openclaw/openclaw.json",
        ].join("\n"),
        "managed-image-openclaw-prepare-entrypoint-refusal",
        ["--volume", `${refusalVolume}:/sandbox/.openclaw`],
      );
      const refused = await host.command(
        "docker",
        [
          "run",
          "--rm",
          "--user",
          "root",
          "--label",
          `io.nvidia.nemoclaw.managed-image.cohort=${cohort}`,
          "--volume",
          `${refusalVolume}:/sandbox/.openclaw`,
          image,
          "/bin/true",
        ],
        { artifactName: "managed-image-openclaw-default-entrypoint-refusal", timeoutMs: 120_000 },
      );
      expect(refused.exitCode).not.toBe(0);
      await runContainer(
        host,
        image,
        '[ -L /sandbox/.openclaw/openclaw.json ]; [ "$(cat /sandbox/.openclaw/protected-target)" = protected ]',
        "managed-image-openclaw-verify-entrypoint-refusal",
        ["--volume", `${refusalVolume}:/sandbox/.openclaw`],
      );
    } finally {
      const repairRemoved = await host.command(
        "docker",
        repairVolumeCreated ? ["volume", "rm", "-f", repairVolume] : ["volume", "ls", "--quiet"],
        { artifactName: "managed-image-openclaw-remove-repair-volume" },
      );
      const refusalRemoved = await host.command(
        "docker",
        refusalVolumeCreated ? ["volume", "rm", "-f", refusalVolume] : ["volume", "ls", "--quiet"],
        { artifactName: "managed-image-openclaw-remove-refusal-volume" },
      );
      expect(repairRemoved.exitCode).toBe(0);
      expect(refusalRemoved.exitCode).toBe(0);
    }

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
