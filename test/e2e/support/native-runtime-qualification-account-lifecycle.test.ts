// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readYaml, type Workflow } from "../../helpers/e2e-workflow-contract";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

function workflowScripts(): { boundary: string; cleanup: string } {
  const workflow = readYaml(".github/workflows/e2e.yaml") as Workflow;
  const steps = workflow.jobs["native-runtime-qualification-producer"]?.steps ?? [];
  const run = (name: string): string => {
    const source = steps.find((entry) => entry.name === name)?.run;
    expect(source, `Missing workflow step ${name}`).toBeTruthy();
    return source!;
  };
  return {
    boundary: run("Prepare the credential-free execution account and disable Docker"),
    cleanup: run("Remove qualification resources"),
  };
}

function extractFunction(source: string, name: string): string {
  const match = source.match(new RegExp(`${name}\\(\\) \\{([\\s\\S]*?)^\\}`, "m"));
  expect(match, `Missing shell function ${name}`).toBeTruthy();
  return `${name}() {${match![1]}\n}`;
}

const fixtureRewrites = {
  testExecutable: ["/usr/bin/test", "/bin/test"],
  systemctlExecutable: ["/usr/bin/systemctl", "systemctl"],
  commandPath: ["PATH=/usr/bin:/bin", 'PATH="$FIXTURE_BIN:/usr/bin:/bin"'],
  subuid: ["/etc/subuid", "${FIXTURE_ROOT}/etc/subuid"],
  subgid: ["/etc/subgid", "${FIXTURE_ROOT}/etc/subgid"],
  ownershipMarker: [
    'ownership_marker="/run/nemoclaw-native-runtime-owner-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"',
    'ownership_marker="${FIXTURE_ROOT}/run/nemoclaw-native-runtime-owner-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"',
  ],
  homeIdentity: ['"$home" == "/home/${account}"', '"$home" == "$FIXTURE_HOME"'],
  runtimeDirectory: [
    'runtime_dir="/run/user/${uid}"',
    'runtime_dir="${FIXTURE_ROOT}/run/user/${uid}"',
  ],
  userManagerDropinDirectory: [
    'user_manager_dropin_directory="/run/systemd/system/${user_manager_unit}.d"',
    'user_manager_dropin_directory="${FIXTURE_ROOT}/run/systemd/system/${user_manager_unit}.d"',
  ],
  storageConfigDirectory: [
    'storage_config_directory="/run/nemoclaw-native-runtime-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${uid}"',
    'storage_config_directory="${FIXTURE_ROOT}/run/nemoclaw-native-runtime-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${uid}"',
  ],
  podmanExecutable: [
    'podman_executable="/nemoclaw-native-runtime-podman-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${uid}"',
    'podman_executable="${FIXTURE_ROOT}/nemoclaw-native-runtime-podman-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${uid}"',
  ],
  helperDirectory: [
    'helper_directory="/nemoclaw-native-runtime-helpers-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${uid}"',
    'helper_directory="${FIXTURE_ROOT}/nemoclaw-native-runtime-helpers-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${uid}"',
  ],
  resourceDirectory: [
    'resource_directory="/var/tmp/nemoclaw-native-runtime-resources-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${uid}"',
    'resource_directory="${FIXTURE_ROOT}/var/tmp/nemoclaw-native-runtime-resources-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${uid}"',
  ],
  userRuntimePath: ['"/run/user/${uid}"', '"${FIXTURE_ROOT}/run/user/${uid}"'],
} as const;

type FixtureRewrite = keyof typeof fixtureRewrites;
type FixtureRewriteProfile = "bus" | "cleanup" | "provision" | "subgid" | "subuid" | "unitPath";
type FixtureRewriteContract = {
  readonly required: readonly FixtureRewrite[];
  readonly optional: readonly FixtureRewrite[];
};

const fixtureRewriteProfiles: Record<FixtureRewriteProfile, FixtureRewriteContract> = {
  bus: { required: ["testExecutable"], optional: [] },
  unitPath: { required: ["systemctlExecutable", "commandPath"], optional: [] },
  provision: {
    required: ["subuid", "subgid", "ownershipMarker", "homeIdentity"],
    optional: [],
  },
  subuid: { required: ["subuid"], optional: [] },
  subgid: { required: ["subgid"], optional: [] },
  cleanup: {
    required: [
      "subuid",
      "subgid",
      "ownershipMarker",
      "runtimeDirectory",
      "userManagerDropinDirectory",
      "storageConfigDirectory",
      "podmanExecutable",
      "helperDirectory",
      "resourceDirectory",
      "userRuntimePath",
    ],
    optional: [],
  },
};

function rewriteRequiredFixtureTarget(source: string, target: FixtureRewrite): string {
  const [from, to] = fixtureRewrites[target];
  expect(source, `Missing mandatory fixture rewrite '${target}'`).toContain(from);
  return source.replaceAll(from, to);
}

function fixtureSource(source: string, profile: FixtureRewriteProfile): string {
  let rewritten = source;
  for (const target of fixtureRewriteProfiles[profile].required) {
    rewritten = rewriteRequiredFixtureTarget(rewritten, target);
  }
  for (const target of fixtureRewriteProfiles[profile].optional) {
    const [from, to] = fixtureRewrites[target];
    rewritten = rewritten.replaceAll(from, to);
  }
  expect(rewritten, "Fixture source retains an unredirected destructive host path").not.toMatch(
    /(?:\/usr\/bin\/(?:systemctl|test)|PATH=\/usr\/bin:\/bin|"\$home" == "\/home\/\$\{account\}"|(?:^|[\s"'=])\/(?:etc\/sub(?:uid|gid)|run\/(?:nemoclaw-native-runtime|systemd\/system|user\/)|(?:nemoclaw-native-runtime-(?:podman|helpers)|var\/tmp\/nemoclaw-native-runtime-resources)-))/mu,
  );
  return rewritten;
}

function writeExecutable(file: string, source: string): void {
  fs.writeFileSync(file, `#!/usr/bin/env bash\nset -euo pipefail\n${source}\n`, { mode: 0o700 });
}

function createFixture(): {
  root: string;
  bin: string;
  calls: string;
  passwd: string;
  group: string;
  subuid: string;
  subgid: string;
  home: string;
  marker: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-runtime-account-fixture-"));
  roots.push(root);
  const bin = path.join(root, "bin");
  const etc = path.join(root, "etc");
  const run = path.join(root, "run");
  const home = path.join(root, "home", "nemoclawq");
  const calls = path.join(root, "calls.log");
  const passwd = path.join(etc, "passwd");
  const group = path.join(etc, "group");
  const subuid = path.join(etc, "subuid");
  const subgid = path.join(etc, "subgid");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(etc, { recursive: true });
  fs.mkdirSync(run, { recursive: true });
  for (const file of [calls, passwd, group, subuid, subgid]) fs.writeFileSync(file, "");

  writeExecutable(
    path.join(bin, "sudo"),
    `printf 'sudo:%s\\n' "$*" >>"$FIXTURE_CALLS"
if [[ "$1" == -u ]]; then shift 2; fi
exec "$@"`,
  );
  writeExecutable(
    path.join(bin, "getent"),
    `case "$1" in
  passwd) file="$FIXTURE_ROOT/etc/passwd" ;;
  group) file="$FIXTURE_ROOT/etc/group" ;;
  *) exit 2 ;;
esac
awk -F: -v key="$2" '$1 == key || $3 == key { print; found = 1 } END { exit found ? 0 : 2 }' "$file"`,
  );
  writeExecutable(
    path.join(bin, "id"),
    `[[ "$1" == -u || "$1" == -g ]]
[[ "\${FAIL_ID:-0}" != 1 ]] || exit 26
field=3
[[ "$1" == -u ]] || field=4
awk -F: -v account="$2" -v field="$field" '$1 == account { print $field; found = 1 } END { exit found ? 0 : 1 }' "$FIXTURE_ROOT/etc/passwd"`,
  );
  writeExecutable(
    path.join(bin, "useradd"),
    `printf 'useradd:%s\\n' "$*" >>"$FIXTURE_CALLS"
[[ "\${FAIL_USERADD:-0}" != 1 ]] || exit 23
account="\${!#}"
mkdir -p "$FIXTURE_HOME"
printf '%s:x:1002:1007::%s:/usr/sbin/nologin\\n' "$account" "$FIXTURE_HOME" >>"$FIXTURE_ROOT/etc/passwd"
printf '%s:x:1007:\\n' "$account" >>"$FIXTURE_ROOT/etc/group"`,
  );
  writeExecutable(
    path.join(bin, "usermod"),
    `printf 'usermod:%s\\n' "$*" >>"$FIXTURE_CALLS"
case "$1" in
  --add-subuids) file="$FIXTURE_ROOT/etc/subuid" ;;
  --add-subgids) file="$FIXTURE_ROOT/etc/subgid" ;;
  *) exit 24 ;;
esac
start="\${2%-*}"
end="\${2#*-}"
printf '%s:%s:%s\\n' "$3" "$start" "$((end - start + 1))" >>"$file"`,
  );
  writeExecutable(path.join(bin, "chown"), ":");
  writeExecutable(path.join(bin, "chmod"), `exec /bin/chmod "$@"`);
  writeExecutable(
    path.join(bin, "unlink"),
    `/bin/chmod u+w "$(/usr/bin/dirname "$1")"\nexec /bin/unlink "$1"`,
  );
  writeExecutable(
    path.join(bin, "rmdir"),
    `/bin/chmod u+w "$(/usr/bin/dirname "$1")"\nexec /bin/rmdir "$1"`,
  );
  writeExecutable(
    path.join(bin, "rm"),
    `target="\${!#}"\n/bin/chmod u+w "$(/usr/bin/dirname "$target")"\nexec /bin/rm "$@"`,
  );
  writeExecutable(
    path.join(bin, "stat"),
    `target="\${!#}"
case "$target" in
  *bus) printf '%s\\n' "\${BUS_UID:-1002}" ;;
  *user@*.service.d) printf '0:0:755\\n' ;;
  *50-nemoclaw-native-runtime.conf) printf '0:0:444:1\\n' ;;
  *native-runtime-owner-*) printf '0:0:400\\n' ;;
  *native-runtime-podman-*) printf '0:0:555\\n' ;;
  *native-runtime-helpers-*) printf '0:0:555\\n' ;;
  *native-runtime-resources-*/model/*)
    [[ "$2" == '%u:%g:%a:%h' ]] && printf '0:0:444:1\\n' || printf '0:0:444\\n'
    ;;
  *native-runtime-resources-*) printf '0:0:555\\n' ;;
  *podman.apparmor|*pasta.apparmor|*runner-contract.json|*containers.conf|*storage.conf) printf '0:0:444\\n' ;;
  *) exit 25 ;;
esac`,
  );
  writeExecutable(path.join(bin, "pkill"), `printf 'pkill:%s\\n' "$*" >>"$FIXTURE_CALLS"`);
  writeExecutable(
    path.join(bin, "systemctl"),
    `printf 'systemctl:%s\\n' "$*" >>"$FIXTURE_CALLS"
if [[ "$1" == --user ]]; then shift; fi
if [[ "$1" == stop ]]; then
  shift
  for unit in "$@"; do
    if [[ "$unit" =~ ^user-runtime-dir@([0-9]+)\\.service$ ]]; then
      /bin/rm -rf -- "$FIXTURE_ROOT/run/user/\${BASH_REMATCH[1]}"
    fi
  done
elif [[ "$1" == is-active ]]; then
  exit 3
elif [[ "$1" == show || "$1" == show-environment ]]; then
  printf '%s\\n' "\${SYSTEMD_ENVIRONMENT:-}"
fi`,
  );
  writeExecutable(
    path.join(bin, "apparmor_parser"),
    `printf 'apparmor:%s\\n' "$*" >>"$FIXTURE_CALLS"`,
  );
  writeExecutable(
    path.join(bin, "userdel"),
    `printf 'userdel:%s\\n' "$*" >>"$FIXTURE_CALLS"
account="\${!#}"
for file in "$FIXTURE_ROOT/etc/passwd" "$FIXTURE_ROOT/etc/subuid" "$FIXTURE_ROOT/etc/subgid"; do
  awk -F: -v account="$account" '$1 != account' "$file" >"$file.next"
  mv "$file.next" "$file"
done
rmdir "$FIXTURE_HOME" 2>/dev/null || true`,
  );
  writeExecutable(
    path.join(bin, "groupdel"),
    `printf 'groupdel:%s\\n' "$*" >>"$FIXTURE_CALLS"
awk -F: -v account="$1" '$1 != account' "$FIXTURE_ROOT/etc/group" >"$FIXTURE_ROOT/etc/group.next"
mv "$FIXTURE_ROOT/etc/group.next" "$FIXTURE_ROOT/etc/group"`,
  );

  return {
    root,
    bin,
    calls,
    passwd,
    group,
    subuid,
    subgid,
    home,
    marker: path.join(run, "nemoclaw-native-runtime-owner-42-1"),
  };
}

function runFixture(
  fixture: ReturnType<typeof createFixture>,
  source: string,
  profile: FixtureRewriteProfile,
  extraEnv: Record<string, string> = {},
) {
  return spawnSync("bash", ["-c", fixtureSource(source, profile)], {
    encoding: "utf8",
    timeout: 15_000,
    env: {
      ...process.env,
      ACCOUNT: "nemoclawq",
      ACCOUNT_CREATED: "true",
      FIXTURE_CALLS: fixture.calls,
      FIXTURE_BIN: fixture.bin,
      FIXTURE_HOME: fixture.home,
      FIXTURE_ROOT: fixture.root,
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_RUN_ID: "42",
      PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
      ...extraEnv,
    },
  });
}

function provisionBlock(): string {
  const source = workflowScripts().boundary;
  const start = source.indexOf('account="nemoclawq"');
  const end = source.indexOf("ensure_subordinate_range()", start);
  expect(start, "Missing qualification account provision start").toBeGreaterThanOrEqual(0);
  expect(end, "Missing qualification account provision end").toBeGreaterThan(start);
  return `set -euo pipefail\n${source.slice(start, end)}`;
}

function expectPreExistingAccountStateRejected(): void {
  for (const state of ["passwd", "group", "subuid", "subgid"] as const) {
    const fixture = createFixture();
    const file = fixture[state];
    fs.appendFileSync(
      file,
      state === "passwd"
        ? `nemoclawq:x:1002:1007::${fixture.home}:/usr/sbin/nologin\n`
        : state === "group"
          ? "nemoclawq:x:1007:\n"
          : "nemoclawq:200000:65536\n",
    );
    const result = runFixture(fixture, provisionBlock(), "provision");
    expect(result.status, `${state}: ${result.stderr}`).not.toBe(0);
    expect(fs.readFileSync(fixture.calls, "utf8")).not.toContain("useradd:");
    expect(fs.existsSync(fixture.marker)).toBe(false);
  }
}

function writeModelFixtureFiles(model: string): void {
  for (const file of [
    "config.json",
    "generation_config.json",
    "merges.txt",
    "model.safetensors",
    "tokenizer.json",
    "tokenizer_config.json",
    "vocab.json",
  ]) {
    fs.writeFileSync(path.join(model, file), "fixture", { mode: 0o444 });
  }
}

describe("native runtime qualification account lifecycle", () => {
  it("fails closed when a mandatory fixture rewrite no longer matches", () => {
    expect(() => fixtureSource("set -euo pipefail", "bus")).toThrow(
      "Missing mandatory fixture rewrite 'testExecutable'",
    );
  });

  it("rejects a symlinked or wrong-owner user bus while accepting the exact account socket", async () => {
    const fixture = createFixture();
    const socketRoot = fs.mkdtempSync("/tmp/nrq-bus-");
    roots.push(socketRoot);
    const socket = path.join(socketRoot, "bus");
    const socketLink = path.join(socketRoot, "bus-link");
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
    fs.symlinkSync(socket, socketLink);
    const verifyUserBus = extractFunction(workflowScripts().boundary, "verify_user_bus");
    const source = (candidate: string) =>
      `set -euo pipefail\n${verifyUserBus}\nverify_user_bus nemoclawq 1002 ${JSON.stringify(candidate)} fixture`;

    try {
      const exact = runFixture(fixture, source(socket), "bus");
      expect(exact.status, exact.stderr).toBe(0);

      const symlink = runFixture(fixture, source(socketLink), "bus");
      expect(symlink.status).not.toBe(0);
      expect(symlink.stderr).toContain("Qualification systemd user bus fixture");

      const wrongOwner = runFixture(fixture, source(socket), "bus", { BUS_UID: "1003" });
      expect(wrongOwner.status).not.toBe(0);
      expect(wrongOwner.stderr).toContain("Qualification systemd user bus fixture");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("rejects a user manager whose unit path includes candidate-writable authority", () => {
    const fixture = createFixture();
    const verifyUnitPath = extractFunction(
      workflowScripts().boundary,
      "verify_user_manager_unit_path",
    ).replace("env -i", "env");
    const source = `set -euo pipefail
trusted_user_unit_path=/usr/lib/systemd/user:/lib/systemd/user
${verifyUnitPath}
verify_user_manager_unit_path nemoclawq "$FIXTURE_HOME" "$FIXTURE_ROOT/run/user/1002"`;

    const trusted = runFixture(fixture, source, "unitPath", {
      SYSTEMD_ENVIRONMENT: "SYSTEMD_UNIT_PATH=/usr/lib/systemd/user:/lib/systemd/user",
    });
    expect(trusted.status, trusted.stderr).toBe(0);

    const candidateWritable = runFixture(fixture, source, "unitPath", {
      SYSTEMD_ENVIRONMENT:
        "SYSTEMD_UNIT_PATH=/home/nemoclawq/.config/systemd/user:/usr/lib/systemd/user:/lib/systemd/user",
    });
    expect(candidateWritable.status).not.toBe(0);
    expect(candidateWritable.stderr).toContain("did not inherit the trusted unit path");
  });

  it("rejects pre-existing accounts and stale subordinate-ID authorization before mutation", () => {
    expectPreExistingAccountStateRejected();
  });

  it("does not publish ownership when account creation fails", () => {
    const fixture = createFixture();
    const result = runFixture(fixture, provisionBlock(), "provision", { FAIL_USERADD: "1" });
    expect(result.status).toBe(23);
    expect(fs.existsSync(fixture.marker)).toBe(false);
    expect(fs.readFileSync(fixture.passwd, "utf8")).toBe("");
  });

  it("records the exact private group when its numeric GID differs from the UID", () => {
    const fixture = createFixture();
    const result = runFixture(fixture, provisionBlock(), "provision");
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(fixture.marker, "utf8")).toBe("nemoclawq:1002:1007\n");
    expect(fs.readFileSync(fixture.calls, "utf8")).toContain(
      "useradd:--create-home --shell /usr/sbin/nologin --user-group nemoclawq",
    );
  });

  it("rolls back an account when identity validation fails before marker publication", () => {
    const fixture = createFixture();
    const result = runFixture(fixture, provisionBlock(), "provision", { FAIL_ID: "1" });
    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(fixture.calls, "utf8")).toContain("userdel:--remove nemoclawq");
    expect(fs.readFileSync(fixture.passwd, "utf8")).not.toContain("nemoclawq:");
    expect(fs.readFileSync(fixture.group, "utf8")).not.toContain("nemoclawq:");
    expect(fs.existsSync(fixture.marker)).toBe(false);
  });

  it("keeps an existing valid range and advances past every overlapping range", () => {
    const rangeFunction = extractFunction(workflowScripts().boundary, "ensure_subordinate_range");

    const valid = createFixture();
    fs.writeFileSync(valid.subuid, "nemoclawq:200000:65536\n");
    const validResult = runFixture(
      valid,
      `set -euo pipefail\naccount=nemoclawq\n${rangeFunction}\nensure_subordinate_range /etc/subuid --add-subuids`,
      "subuid",
    );
    expect(validResult.status, validResult.stderr).toBe(0);
    expect(fs.readFileSync(valid.calls, "utf8")).not.toContain("usermod:");

    const overlapping = createFixture();
    fs.writeFileSync(overlapping.subuid, "runner-a:100000:65536\nrunner-b:165536:65536\n");
    const overlappingResult = runFixture(
      overlapping,
      `set -euo pipefail\naccount=nemoclawq\n${rangeFunction}\nensure_subordinate_range /etc/subuid --add-subuids`,
      "subuid",
    );
    expect(overlappingResult.status, overlappingResult.stderr).toBe(0);
    expect(fs.readFileSync(overlapping.subuid, "utf8")).toContain("nemoclawq:231072:65536");
  });

  it("fails closed when no complete subordinate-ID range remains", () => {
    const fixture = createFixture();
    fs.writeFileSync(fixture.subgid, "runner:100000:4294867296\n");
    const rangeFunction = extractFunction(workflowScripts().boundary, "ensure_subordinate_range");
    const result = runFixture(
      fixture,
      `set -euo pipefail\naccount=nemoclawq\n${rangeFunction}\nensure_subordinate_range /etc/subgid --add-subgids`,
      "subgid",
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no free subordinate-ID range");
    expect(fs.readFileSync(fixture.calls, "utf8")).not.toContain("usermod:");
  });

  it("removes partial account setup and verifies subordinate-ID revocation", () => {
    const fixture = createFixture();
    fs.mkdirSync(fixture.home, { recursive: true });
    fs.writeFileSync(fixture.passwd, `nemoclawq:x:1002:1007::${fixture.home}:/usr/sbin/nologin\n`);
    fs.writeFileSync(fixture.group, "nemoclawq:x:1007:\n");
    fs.writeFileSync(fixture.subuid, "nemoclawq:200000:65536\n");
    fs.writeFileSync(fixture.subgid, "nemoclawq:300000:65536\n");
    fs.writeFileSync(fixture.marker, "nemoclawq:1002:1007\n", { mode: 0o400 });

    const result = runFixture(fixture, workflowScripts().cleanup, "cleanup");
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(fixture.calls, "utf8")).toContain("userdel:--remove nemoclawq");
    expect(fs.readFileSync(fixture.passwd, "utf8")).not.toContain("nemoclawq:");
    expect(fs.readFileSync(fixture.group, "utf8")).not.toContain("nemoclawq:");
    expect(fs.readFileSync(fixture.subuid, "utf8")).not.toContain("nemoclawq:");
    expect(fs.readFileSync(fixture.subgid, "utf8")).not.toContain("nemoclawq:");
    expect(fs.existsSync(fixture.marker)).toBe(false);
  });

  it("removes the run-owned runtime, helper copies, GPU resources, and AppArmor profiles", () => {
    const fixture = createFixture();
    const runtime = path.join(fixture.root, "run", "user", "1002", "libpod", "tmp");
    const storage = path.join(fixture.root, "run", "nemoclaw-native-runtime-42-1-1002");
    const podman = path.join(fixture.root, "nemoclaw-native-runtime-podman-42-1-1002");
    const helpers = path.join(fixture.root, "nemoclaw-native-runtime-helpers-42-1-1002");
    const userManagerDropinDirectory = path.join(
      fixture.root,
      "run",
      "systemd",
      "system",
      "user@1002.service.d",
    );
    const resources = path.join(
      fixture.root,
      "var",
      "tmp",
      "nemoclaw-native-runtime-resources-42-1-1002",
    );
    const model = path.join(resources, "model");
    fs.mkdirSync(fixture.home, { recursive: true });
    fs.mkdirSync(runtime, { recursive: true });
    fs.mkdirSync(storage, { recursive: true });
    fs.mkdirSync(userManagerDropinDirectory, { recursive: true, mode: 0o755 });
    fs.writeFileSync(
      path.join(userManagerDropinDirectory, "50-nemoclaw-native-runtime.conf"),
      '[Service]\nEnvironment="SYSTEMD_UNIT_PATH=/usr/lib/systemd/user:/lib/systemd/user"\n',
      { mode: 0o444 },
    );
    fs.writeFileSync(path.join(runtime, "alive"), "fixture");
    fs.writeFileSync(path.join(storage, "storage.conf"), "fixture");
    fs.writeFileSync(path.join(storage, "containers.conf"), "fixture");
    fs.writeFileSync(path.join(storage, "podman.apparmor"), "fixture");
    fs.writeFileSync(path.join(storage, "pasta.apparmor"), "fixture");
    fs.writeFileSync(path.join(storage, "runner-contract.json"), "fixture");
    fs.writeFileSync(podman, "fixture", { mode: 0o555 });
    fs.mkdirSync(helpers, { recursive: true, mode: 0o755 });
    fs.writeFileSync(path.join(helpers, "pasta"), "fixture", { mode: 0o555 });
    fs.chmodSync(helpers, 0o555);
    fs.mkdirSync(model, { recursive: true, mode: 0o755 });
    writeModelFixtureFiles(model);
    fs.chmodSync(model, 0o555);
    fs.chmodSync(resources, 0o555);
    fs.writeFileSync(fixture.passwd, `nemoclawq:x:1002:1007::${fixture.home}:/usr/sbin/nologin\n`);
    fs.writeFileSync(fixture.group, "nemoclawq:x:1007:\n");
    fs.writeFileSync(fixture.subuid, "nemoclawq:200000:65536\n");
    fs.writeFileSync(fixture.subgid, "nemoclawq:300000:65536\n");
    fs.writeFileSync(fixture.marker, "nemoclawq:1002:1007\n", { mode: 0o400 });

    const result = runFixture(fixture, workflowScripts().cleanup, "cleanup");
    expect(result.status, result.stderr).toBe(0);
    const calls = fs.readFileSync(fixture.calls, "utf8");
    expect(calls).toContain("systemctl:stop user@1002.service user-runtime-dir@1002.service");
    expect(calls).toContain("groupdel:nemoclawq");
    expect(calls).toContain("apparmor:-R");
    expect(fs.existsSync(path.join(fixture.root, "run", "user", "1002"))).toBe(false);
    expect(fs.existsSync(storage)).toBe(false);
    expect(fs.existsSync(podman)).toBe(false);
    expect(fs.existsSync(helpers)).toBe(false);
    expect(fs.existsSync(resources)).toBe(false);
    expect(fs.existsSync(userManagerDropinDirectory)).toBe(false);
  }, 15_000);

  it("does not run destructive cleanup when the run-owned marker is absent", () => {
    const fixture = createFixture();
    const result = runFixture(fixture, workflowScripts().cleanup, "cleanup", {
      ACCOUNT_CREATED: "",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("output exists without its ownership marker");
    const calls = fs.readFileSync(fixture.calls, "utf8");
    expect(calls).not.toMatch(/pkill:|systemctl:|userdel:|groupdel:|apparmor:/u);
  });

  it("fails closed before destructive cleanup when the private group identity changes", () => {
    const fixture = createFixture();
    fs.mkdirSync(fixture.home, { recursive: true });
    fs.writeFileSync(fixture.passwd, `nemoclawq:x:1002:1007::${fixture.home}:/usr/sbin/nologin\n`);
    fs.writeFileSync(fixture.group, "nemoclawq:x:1008:\n");
    fs.writeFileSync(fixture.marker, "nemoclawq:1002:1007\n", { mode: 0o400 });

    const result = runFixture(fixture, workflowScripts().cleanup, "cleanup");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("private group identity changed before cleanup");
    expect(fs.readFileSync(fixture.calls, "utf8")).not.toMatch(
      /pkill:|systemctl:|userdel:|groupdel:|apparmor:/u,
    );
  });
});
