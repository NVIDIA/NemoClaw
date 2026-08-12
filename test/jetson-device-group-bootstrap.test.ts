// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { dockerSpawnSync } from "../src/lib/adapters/docker/exec";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const BOOTSTRAP_SCRIPT = path.join(REPO_ROOT, "scripts", "jetson-device-group-bootstrap.sh");
const FIXTURE_BASE_IMAGE =
  "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:16b01f6d7e0b843a72331538f3bf690b6112840064e7d8b81e361a61277bebf7";
const SUPERVISOR = "/opt/openshell/bin/openshell-sandbox";
const CONTAINER_TIMEOUT_MS = 20_000;

type BootstrapRunOptions = {
  environment?: Record<string, string>;
  groupDatabase?: "regular" | "symlink";
};

type BootstrapRun = {
  after: FixtureState;
  before: FixtureState;
  status: number | null;
  stderr: string;
  stdout: string;
};

type FixtureState = {
  groupAddLog: string;
  groupMap: string;
  memberships: string;
  supervisorArgv: Buffer | null;
  usermodLog: string;
};

const fixtureParent = process.platform === "darwin" ? "/private/tmp" : os.tmpdir();
const fixtureId = `${String(process.pid)}-${String(Date.now())}`;
const fixtureImage = `nemoclaw-jetson-bootstrap-test:${fixtureId}`;
let containerFixtureRoot = path.join(
  fixtureParent,
  `nemoclaw-jetson-bootstrap-not-created-${fixtureId}`,
);

const GROUP_DATABASE_DOCKER_ARGS = {
  regular: [],
  symlink: ["--tmpfs", "/etc:rw,nosuid,nodev,noexec,size=1m"],
} as const satisfies Record<NonNullable<BootstrapRunOptions["groupDatabase"]>, readonly string[]>;

function writeExecutable(filePath: string, source: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source, { mode: 0o755 });
}

const INITIAL_STATE: FixtureState = {
  groupAddLog: "",
  groupMap: "44:video\n",
  memberships: "1000 44\n",
  supervisorArgv: null,
  usermodLog: "",
};

function createContainerFixture(): string {
  const root = fs.mkdtempSync(path.join(fixtureParent, "nemoclaw-jetson-bootstrap-"));
  const usrBin = path.join(root, "usr-bin");
  const usrSbin = path.join(root, "usr-sbin");
  const supervisorDir = path.join(root, "supervisor");

  writeExecutable(
    path.join(usrBin, "id"),
    `#!/bin/sh
set -eu
if [ "\${1:-}" = "-u" ]; then
  printf '%s\n' "\${TEST_ID_UID:-0}"
  exit 0
fi
if [ "\${1:-}" = "sandbox" ]; then
  [ "\${TEST_SANDBOX_MISSING:-0}" != "1" ] || exit 1
  printf 'uid=1000(sandbox) gid=1000(sandbox) groups=%s\n' "$(cat /test-state/memberships)"
  exit 0
fi
if [ "\${1:-}" = "-G" ] && [ "\${2:-}" = "sandbox" ]; then
  cat /test-state/memberships
  exit 0
fi
exit 2
`,
  );
  writeExecutable(
    path.join(usrBin, "getent"),
    `#!/bin/sh
set -eu
[ "\${1:-}" = "group" ] || exit 2
gid="\${2:-}"
if [ "\${TEST_GETENT_MALFORMED_GID:-}" = "$gid" ]; then
  printf ':x:999:\n'
  exit 0
fi
record="$(awk -F: -v gid="$gid" '$1 == gid { print; exit }' /test-state/group-map)"
[ -n "$record" ] || exit 2
name="\${record#*:}"
printf '%s:x:%s:\n' "$name" "$gid"
`,
  );
  writeExecutable(
    path.join(usrSbin, "groupadd"),
    `#!/bin/sh
set -eu
[ "$#" -eq 3 ] && [ "$1" = "--gid" ]
printf '%s\n' "$*" >>/test-state/groupadd.log
printf '%s:%s\n' "$2" "$3" >>/test-state/group-map
`,
  );
  writeExecutable(
    path.join(usrSbin, "usermod"),
    `#!/bin/sh
set -eu
[ "$#" -eq 4 ] && [ "$1" = "--append" ] && [ "$2" = "--groups" ] && [ "$4" = "sandbox" ]
printf '%s\n' "$*" >>/test-state/usermod.log
[ "\${TEST_USERMOD_NOOP:-0}" != "1" ] || exit 0
gid="$(awk -F: -v name="$3" '$2 == name { print $1; exit }' /test-state/group-map)"
[ -n "$gid" ]
memberships="$(cat /test-state/memberships)"
case " $memberships " in
  *" $gid "*) ;;
  *) printf '%s %s\n' "$memberships" "$gid" >/test-state/memberships ;;
esac
`,
  );
  writeExecutable(
    path.join(supervisorDir, "openshell-sandbox"),
    `#!/bin/sh
set -eu
printf '%s\\0' "$@" >/test-state/supervisor.argv
printf 'SUPERVISOR_EXECUTED\n'
`,
  );
  writeExecutable(
    path.join(root, "fixture-runner"),
    `#!/bin/bash
set -uo pipefail
printf '1000 44\n' >/test-state/memberships
printf '44:video\n' >/test-state/group-map
case "\${TEST_GROUP_DATABASE:-regular}" in
  regular) ;;
  symlink) /bin/ln -s /tmp/nemoclaw-missing-group /etc/group ;;
  *) exit 2 ;;
esac
set +e
/usr/local/lib/nemoclaw/jetson-device-group-bootstrap.sh "$@"
status=$?
set -e
printf 'NEMOCLAW_TEST_STATE_BEGIN\n'
for file in groupadd.log group-map memberships supervisor.argv usermod.log; do
  printf '%s=' "$file"
  if [ -f "/test-state/$file" ]; then
    base64 "/test-state/$file" | tr -d '\n'
  fi
  printf '\n'
done
printf 'NEMOCLAW_TEST_STATE_END\n'
exit "$status"
`,
  );
  fs.copyFileSync(BOOTSTRAP_SCRIPT, path.join(root, "jetson-device-group-bootstrap.sh"));
  fs.writeFileSync(
    path.join(root, "Dockerfile"),
    `FROM ${FIXTURE_BASE_IMAGE}
COPY jetson-device-group-bootstrap.sh /usr/local/lib/nemoclaw/jetson-device-group-bootstrap.sh
COPY fixture-runner /test-fixture/run
COPY supervisor/ /opt/openshell/bin/
COPY usr-bin/id /usr/bin/id
COPY usr-bin/getent /usr/bin/getent
COPY usr-sbin/ /usr/sbin/
`,
  );
  return root;
}

function parseFixtureState(stdout: string): { state: FixtureState; stdout: string } {
  const startMarker = "NEMOCLAW_TEST_STATE_BEGIN\n";
  const endMarker = "NEMOCLAW_TEST_STATE_END\n";
  const start = stdout.indexOf(startMarker);
  const end = stdout.indexOf(endMarker, start + startMarker.length);
  expect(start, "fixture state start marker is missing").toBeGreaterThanOrEqual(0);
  expect(end, "fixture state end marker is missing").toBeGreaterThan(start);
  const encoded = new Map(
    stdout
      .slice(start + startMarker.length, end)
      .trimEnd()
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)] as const;
      }),
  );
  const decode = (name: string): Buffer | null => {
    const value = encoded.get(name);
    return value ? Buffer.from(value, "base64") : null;
  };
  return {
    state: {
      groupAddLog: decode("groupadd.log")?.toString("utf8") ?? "",
      groupMap: decode("group-map")?.toString("utf8") ?? "",
      memberships: decode("memberships")?.toString("utf8") ?? "",
      supervisorArgv: decode("supervisor.argv"),
      usermodLog: decode("usermod.log")?.toString("utf8") ?? "",
    },
    stdout: stdout.slice(0, start),
  };
}

function runBootstrap(args: readonly string[], options: BootstrapRunOptions = {}): BootstrapRun {
  const groupDatabase = options.groupDatabase ?? "regular";
  const dockerArgs = [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,size=1m",
    "--tmpfs",
    "/test-state:rw,nosuid,nodev,noexec,size=1m",
    ...GROUP_DATABASE_DOCKER_ARGS[groupDatabase],
    ...Object.entries({
      ...options.environment,
      TEST_GROUP_DATABASE: groupDatabase,
    }).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    "--entrypoint",
    "/test-fixture/run",
    fixtureImage,
    ...args,
  ];
  const result = dockerSpawnSync(dockerArgs, {
    encoding: "utf8",
    killSignal: "SIGKILL",
    timeout: CONTAINER_TIMEOUT_MS,
  });
  expect(result.error, result.error?.message).toBeUndefined();
  const parsed = parseFixtureState(String(result.stdout));
  return {
    after: parsed.state,
    before: INITIAL_STATE,
    status: result.status,
    stderr: String(result.stderr),
    stdout: parsed.stdout,
  };
}

function expectNoMutation(run: BootstrapRun): void {
  expect(run.after).toEqual(run.before);
}

const dockerProbe = dockerSpawnSync(["info", "--format", "{{.ServerVersion}}"], {
  encoding: "utf8",
  killSignal: "SIGKILL",
  timeout: 5_000,
});
const suite = dockerProbe.status === 0 || process.platform === "linux" ? describe : describe.skip;

suite("Jetson device-group bootstrap", () => {
  beforeAll(() => {
    expect(
      dockerProbe.status,
      `Docker is required for the Linux bootstrap security boundary: ${String(dockerProbe.stderr)}`,
    ).toBe(0);
    containerFixtureRoot = createContainerFixture();
    const build = dockerSpawnSync(
      ["build", "--network", "none", "--tag", fixtureImage, containerFixtureRoot],
      {
        encoding: "utf8",
        killSignal: "SIGKILL",
        timeout: 60_000,
      },
    );
    expect(build.error, build.error?.message).toBeUndefined();
    expect(build.status, `${String(build.stderr)}\n${String(build.stdout)}`).toBe(0);
  }, 65_000);

  afterAll(() => {
    dockerSpawnSync(["image", "rm", "--force", fixtureImage], {
      encoding: "utf8",
      killSignal: "SIGKILL",
      timeout: 10_000,
    });
    fs.rmSync(containerFixtureRoot, { force: true, recursive: true });
  });

  it("adds existing and new device groups before the fixed supervisor handoff (#7610)", () => {
    const run = runBootstrap([
      "--device-group-gids",
      "44,110",
      "--",
      SUPERVISOR,
      "--ready",
      "value with space",
    ]);

    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toBe("SUPERVISOR_EXECUTED\n");
    expect(run.after.groupAddLog).toBe("--gid 110 nemoclaw_gpu_110\n");
    expect(run.after.usermodLog).toBe(
      "--append --groups video sandbox\n--append --groups nemoclaw_gpu_110 sandbox\n",
    );
    expect(run.after.memberships.trim().split(/\s+/)).toEqual(["1000", "44", "110"]);
    expect(run.after.supervisorArgv).toEqual(Buffer.from("--ready\0value with space\0", "utf8"));
  });

  it.each([
    {
      args: ["--device-group-gids", "44,invalid", "--", SUPERVISOR],
      error: "device group ID is invalid",
      title: "a later invalid group ID",
    },
    {
      args: ["--device-group-gids", "44,44", "--", SUPERVISOR],
      error: "device group ID is duplicated",
      title: "a later duplicate group ID",
    },
    {
      args: ["--device-group-gids", "2147483648", "--", SUPERVISOR],
      error: "device group ID is out of range",
      title: "an out-of-range group ID",
    },
    {
      args: [
        "--device-group-gids",
        Array.from({ length: 17 }, (_, index) => String(index + 1)).join(","),
        "--",
        SUPERVISOR,
      ],
      error: "device group count is invalid",
      title: "more than 16 group IDs",
    },
    {
      args: ["--device-group-gids", "44", "not-a-delimiter", SUPERVISOR],
      error: "supervisor delimiter is missing",
      title: "an invalid supervisor delimiter",
    },
    {
      args: ["--device-group-gids", "44", "--", "/tmp/openshell-sandbox"],
      error: "OpenShell supervisor entrypoint is invalid",
      title: "a different supervisor entrypoint",
    },
  ])("rejects $title before account mutation (#7610)", ({ args, error }) => {
    const run = runBootstrap(args);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`Jetson device-group bootstrap: ${error}`);
    expectNoMutation(run);
  });

  it("rejects a missing sandbox account before group mutation (#7610)", () => {
    const run = runBootstrap(["--device-group-gids", "44", "--", SUPERVISOR], {
      environment: { TEST_SANDBOX_MISSING: "1" },
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("Jetson device-group bootstrap: sandbox user is missing");
    expectNoMutation(run);
  });

  it("rejects a non-root caller before group mutation (#7610)", () => {
    const run = runBootstrap(["--device-group-gids", "44", "--", SUPERVISOR], {
      environment: { TEST_ID_UID: "1000" },
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("Jetson device-group bootstrap: must run as root");
    expectNoMutation(run);
  });

  it("rejects a malformed existing group before account mutation (#7610)", () => {
    const run = runBootstrap(["--device-group-gids", "44", "--", SUPERVISOR], {
      environment: { TEST_GETENT_MALFORMED_GID: "44" },
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("Jetson device-group bootstrap: device group record is invalid");
    expectNoMutation(run);
  });

  it("rejects a symlinked group database before account mutation (#7610)", () => {
    const run = runBootstrap(["--device-group-gids", "44", "--", SUPERVISOR], {
      groupDatabase: "symlink",
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      "Jetson device-group bootstrap: container group database is invalid",
    );
    expectNoMutation(run);
  });

  it("stops before supervisor handoff when membership verification fails (#7610)", () => {
    const run = runBootstrap(["--device-group-gids", "110", "--", SUPERVISOR], {
      environment: { TEST_USERMOD_NOOP: "1" },
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      "Jetson device-group bootstrap: sandbox membership verification failed",
    );
    expect(run.after.supervisorArgv).toBeNull();
    expect(run.after.memberships).toBe(run.before.memberships);
  });
});
