// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { openclawProtectedImage } from "./managed-image-openclaw-security.ts";
import { shellQuote } from "../../src/lib/core/shell-quote.ts";
import { buildStateFileRestoreCommand } from "../../src/lib/state/state-file-restore.ts";
import type { HostCliClient } from "../e2e/fixtures/clients/host.ts";
import { expect, test } from "../e2e/fixtures/e2e-test.ts";

const RUN_MANAGED_IMAGE_SECURITY = Boolean(
  process.env.NEMOCLAW_TEST_IMAGE ?? process.env.NEMOCLAW_PROTECTED_MANAGED_IMAGE_CONTRACT,
);

const DOCKER_OPERATION_TIMEOUT_MS = 45_000;
const MANAGED_IMAGE_SECURITY_TIMEOUT_MS = 4 * 60_000;

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
      image,
      "-eu",
      "-c",
      script,
    ],
    { artifactName, captureLimitBytes: 1024 * 1024, timeoutMs: DOCKER_OPERATION_TIMEOUT_MS },
  );
  expect(
    result.exitCode,
    `${artifactName} failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).toBe(0);
  return result;
}

test.runIf(RUN_MANAGED_IMAGE_SECURITY)(
  "enforces the OpenClaw managed-image sandbox boundary",
  {
    timeout: MANAGED_IMAGE_SECURITY_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "verify final image identities and runtime tools",
        "verify native configuration ownership and filesystem isolation",
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
        'sandbox_gid="$(id -g sandbox)"',
        '[ "$gateway_uid" != "$sandbox_uid" ]',
        "test -x /usr/bin/setpriv",
        "! command -v gosu",
        "test -x /usr/sbin/iptables",
        "test -x /usr/bin/chattr",
        "test -x /usr/local/bin/openclaw",
        `HOME=/sandbox openclaw config get agents.defaults.compaction --json | node -e 'const assert=require("node:assert/strict"); let input=""; process.stdin.on("data", chunk => input += chunk); process.stdin.on("end", () => assert.deepStrictEqual(JSON.parse(input), {mode:"safeguard",timeoutSeconds:120,recentTurnsPreserve:1,qualityGuard:{enabled:true,maxRetries:0},notifyUser:true}));'`,
        `python3 -c 'import json; assert "update" not in json.load(open("/sandbox/.openclaw/openclaw.json"))'`,
        'printf "%s:%s:%s\\n" "$gateway_uid" "$sandbox_uid" "$sandbox_gid"',
      ].join("\n"),
      "managed-image-openclaw-identities",
    );
    const imageUser = await host.command(
      "docker",
      ["image", "inspect", "--format", "{{.Config.User}}", image],
      {
        artifactName: "managed-image-openclaw-default-user",
        timeoutMs: DOCKER_OPERATION_TIMEOUT_MS,
      },
    );
    expect(imageUser.exitCode, imageUser.stderr).toBe(0);
    expect(imageUser.stdout.trim()).toBe("sandbox");

    const [gatewayUid, sandboxUid, sandboxGid] = identity.stdout.trim().split(":");
    expect(gatewayUid).toMatch(/^[0-9]+$/u);
    expect(sandboxUid).toMatch(/^[0-9]+$/u);
    expect(sandboxGid).toMatch(/^[0-9]+$/u);
    expect(gatewayUid).not.toBe(sandboxUid);

    progress.phase("verify native configuration ownership and filesystem isolation");
    await runContainer(
      host,
      image,
      [
        "test ! -e /sandbox/.openclaw/.config-hash",
        "test ! -e /sandbox/.openclaw/openclaw.json.last-good",
        "test ! -e /sandbox/.openclaw/openclaw.json.nemoclaw-baseline",
        "/usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- sh -c 'printf \" \" >>/sandbox/.openclaw/openclaw.json'",
        "printf secret >/tmp/auto-pair.log",
        "chown root:root /tmp/auto-pair.log",
        "chmod 600 /tmp/auto-pair.log",
        "! /usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- test -r /tmp/auto-pair.log",
        "printf '# proxy environment\\n' >/tmp/nemoclaw-proxy-env.sh",
        "chown root:root /tmp/nemoclaw-proxy-env.sh",
        "chmod 444 /tmp/nemoclaw-proxy-env.sh",
        "! /usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- sh -c 'printf x >>/tmp/nemoclaw-proxy-env.sh'",
        "! /usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- sh -c 'rm -f /tmp/nemoclaw-proxy-env.sh'",
      ].join("\n"),
      "managed-image-openclaw-native-config-isolation",
    );
    const restoreCommand = buildStateFileRestoreCommand("/sandbox/.openclaw", {
      path: "openclaw.json",
      strategy: "copy",
      missingTargetMode: "runtime-parent",
    });
    await runContainer(
      host,
      image,
      [
        "rm -f /sandbox/.openclaw/openclaw.json",
        `printf '%s\\n' '{"gateway":{"mode":"local"}}' | sh -c ${shellQuote(restoreCommand)}`,
        'test "$(stat -c %a /sandbox/.openclaw/openclaw.json)" = 660',
        "/usr/bin/setpriv --reuid=gateway --regid=gateway --init-groups -- sh -c 'printf \"\\n\" >>/sandbox/.openclaw/openclaw.json'",
      ].join("\n"),
      "managed-image-openclaw-missing-config-restore",
    );

    progress.phase("record managed-image security evidence");
    await artifacts.writeJson("managed-image-security.json", {
      image,
      gatewayUid: Number(gatewayUid),
      sandboxUid: Number(sandboxUid),
    });
  },
);
