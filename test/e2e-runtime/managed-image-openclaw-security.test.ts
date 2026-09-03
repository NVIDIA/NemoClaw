// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";

import { openclawProtectedImage } from "./managed-image-openclaw-security.ts";
import type { HostCliClient } from "../e2e/fixtures/clients/host.ts";
import { expect, test } from "../e2e/fixtures/e2e-test.ts";

const RUN_MANAGED_IMAGE_SECURITY = Boolean(
  process.env.NEMOCLAW_TEST_IMAGE ?? process.env.NEMOCLAW_PROTECTED_MANAGED_IMAGE_CONTRACT,
);

const PACKAGED_IMAGE_CONTRACT_PROBE = String.raw`import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire("/opt/nemoclaw/");
const YAML = require("yaml");
const blueprint = YAML.parse(fs.readFileSync("/opt/nemoclaw-blueprint/blueprint.yaml", "utf8"));
if (blueprint.version !== "0.1.0") throw new Error("unexpected blueprint version");
const profiles = blueprint.components?.inference?.profiles ?? {};
for (const name of blueprint.profiles ?? []) {
  if (!profiles[name]) throw new Error("missing profile: " + name);
}
const policy = YAML.parse(fs.readFileSync("/opt/nemoclaw-blueprint/policies/openclaw-sandbox.yaml", "utf8"));
if (!policy.version || !policy.network_policies) throw new Error("invalid packaged policy");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "blueprint-plan-"));
fs.writeFileSync(path.join(fixture, "blueprint.yaml"), "components:\n  inference:\n    profiles:\n      default: {}\n");
process.env.NEMOCLAW_BLUEPRINT_PATH = fixture;
const { main } = await import("/opt/nemoclaw/dist/blueprint/runner.js");
let expectedFailure = false;
try {
  await main(["plan", "--profile", "default", "--dry-run"]);
} catch (error) {
  expectedFailure = String(error?.message).includes("openshell CLI not found");
}
if (!expectedFailure) throw new Error("packaged runner did not reach expected OpenShell prerequisite");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-home-"));
process.env.HOME = home;
const state = path.join(home, ".openclaw");
fs.mkdirSync(state, { recursive: true });
fs.writeFileSync(path.join(state, "openclaw.json"), '{"fixture":true}\n');
const { createSnapshot, listSnapshots, rollbackFromSnapshot } = await import("/opt/nemoclaw/dist/blueprint/snapshot.js");
const snapshot = createSnapshot();
if (!snapshot || listSnapshots().length !== 1) throw new Error("packaged snapshot creation failed");
fs.writeFileSync(path.join(state, "openclaw.json"), '{"corrupted":true}\n');
if (!rollbackFromSnapshot(snapshot)) throw new Error("packaged snapshot rollback failed");
if (JSON.parse(fs.readFileSync(path.join(state, "openclaw.json"), "utf8")).fixture !== true) {
  throw new Error("snapshot content was not restored");
}
`;

const NORMALIZER_HANDOFF_RACE_PROBE = String.raw`from pathlib import Path
source = Path("/usr/local/lib/nemoclaw/normalize_mutable_config_perms.py").read_text()
needle = "            rights_fds = [root_fd]\n"
replacement = """            for required_name in ("openclaw.json", ".config-hash"):
                os.unlink(os.path.join(config_dir, required_name))
            os.rmdir(config_dir)
            os.mkdir(config_dir, 0o700)
            for name, content in (("openclaw.json", "{}\\n"), (".config-hash", "hash\\n")):
                path = os.path.join(config_dir, name)
                with open(path, "w", encoding="utf-8") as replacement_file:
                    replacement_file.write(content)
                os.chmod(path, 0o600)
            rights_fds = [root_fd]
"""
if source.count(needle) != 1:
    raise SystemExit("handoff injection point changed")
Path("/tmp/normalizer-handoff-race.py").write_text(source.replace(needle, replacement))
`;

const PACKAGED_IMAGE_APPLY_PROBE = String.raw`
pass() { :; }
fail() { printf '%s\n' "$*" >&2; return 1; }
FAKE_OPENSHELL_BIN=$(mktemp -d)
APPLY_BLUEPRINT_PATH=$(mktemp -d)
APPLY_OUTPUT=$(mktemp)
APPLY_CALLS="$FAKE_OPENSHELL_BIN/calls"
cleanup_apply_fixture() {
  rm -rf "$FAKE_OPENSHELL_BIN" "$APPLY_BLUEPRINT_PATH"
  rm -f "$APPLY_OUTPUT" "$APPLY_CALLS"
}
trap cleanup_apply_fixture EXIT
cat >"$APPLY_BLUEPRINT_PATH/blueprint.yaml" <<'YAML'
components:
  sandbox:
    image: openclaw
    name: openclaw
    forward_ports:
      - 18789
  inference:
    profiles:
      ncp:
        provider_type: nvidia
        provider_name: nvidia-ncp
        model: nvidia/nemotron-3-super-120b-a12b
  policy:
    additions:
      fixture_service:
        name: fixture_service
        endpoints:
          - host: 93.184.216.34
            port: 8000
            access: full
YAML
cat >"$APPLY_BLUEPRINT_PATH/sandbox-policy.yaml" <<'YAML'
version: 1
network_policies: {}
YAML
cp /opt/nemoclaw-blueprint/private-networks.yaml "$APPLY_BLUEPRINT_PATH/private-networks.yaml"
cat >"$FAKE_OPENSHELL_BIN/openshell" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${"${"}BASH_SOURCE[0]%/*}/calls"
if [ "${"${"}1:-}" = "status" ]; then
  printf '%s\n' 'Gateway Status' '  Status: Connected' '  Gateway: fixture-gateway'
  exit 0
fi
if [ "${"${"}1:-} ${"${"}2:-}" = "gateway info" ]; then
  printf '%s\n' 'Gateway endpoint: http://127.0.0.1:8080'
  exit 0
fi
if [ "${"${"}1:-} ${"${"}2:-}" = "sandbox get" ]; then
  sandbox="${"${"}@: -1}"
  printf 'Name: %s\nId: fixture-sandbox-id\nPhase: Ready\n' "$sandbox"
  exit 0
fi
if [ "${"${"}1:-} ${"${"}2:-}" = "policy list" ]; then
  printf '%s\n' 'No global policy history found' >&2
  exit 0
fi
if [ "${"${"}1:-} ${"${"}2:-}" = "policy set" ]; then
  if [ "$#" -ne 8 ] || [ "${"${"}5:-}" != "--policy" ] || [ -z "${"${"}6:-}" ]; then
    echo "unexpected policy write: expected policy set -g fixture-gateway --policy <file> --wait <sandbox>" >&2
    exit 64
  fi
  cp "$6" "${"${"}BASH_SOURCE[0]%/*}/effective-policy.yaml"
  exit 0
fi
if [ "${"${"}1:-} ${"${"}2:-}" = "policy get" ] && [[ " $* " == *" --output json "* ]]; then
  sandbox="${"${"}@: -1}"
  policy_file="${"${"}OPENSHELL_SANDBOX_POLICY:?}"
  policy_hash=sha256:fixture-policy
  policy_version=1
  if [ -f "${"${"}BASH_SOURCE[0]%/*}/effective-policy.yaml" ]; then
    policy_file="${"${"}BASH_SOURCE[0]%/*}/effective-policy.yaml"
    policy_hash=sha256:fixture-mutated-policy
    policy_version=2
  fi
  node -e '
    const fs = require("node:fs");
    const YAML = require("/opt/nemoclaw/node_modules/yaml");
    const policy = YAML.parse(fs.readFileSync(process.argv[2], "utf8"));
    process.stdout.write(JSON.stringify({
      scope: "sandbox",
      sandbox: process.argv[1],
      status: "effective",
      policy_source: "sandbox",
      hash: process.argv[3],
      active_version: Number(process.argv[4]),
      policy,
    }) + "\n");
  ' "$sandbox" "$policy_file" "$policy_hash" "$policy_version"
  exit 0
fi
case "$*" in
  "policy get -g fixture-gateway --base "*)
    if [ "$#" -ne 6 ] || [ -z "${"${"}6:-}" ]; then
      echo "unexpected policy read: expected policy get -g fixture-gateway --base <sandbox>" >&2
      exit 64
    fi
    policy_file="${"${"}OPENSHELL_SANDBOX_POLICY:?}"
    if [ -f "${"${"}BASH_SOURCE[0]%/*}/effective-policy.yaml" ]; then
      policy_file="${"${"}BASH_SOURCE[0]%/*}/effective-policy.yaml"
    fi
    printf '%s\n' 'Policy for sandbox fixture' '---'
    cat "$policy_file"
    ;;
  "policy get "*)
    echo "unexpected policy read: expected policy get -g fixture-gateway --base <sandbox>" >&2
    exit 64
    ;;
esac
SH
chmod 0755 "$FAKE_OPENSHELL_BIN/openshell"
PATH="$FAKE_OPENSHELL_BIN:$PATH" \
  NEMOCLAW_BLUEPRINT_PATH="$APPLY_BLUEPRINT_PATH" \
  OPENSHELL_SANDBOX_POLICY="$APPLY_BLUEPRINT_PATH/sandbox-policy.yaml" \
  node --input-type=module -e "
  const { main } = await import('/opt/nemoclaw/dist/blueprint/runner.js');
  await main(['apply', '--profile', 'ncp']);
" 2>&1 | tee "$APPLY_OUTPUT"
if grep -q "RUN_ID:" "$APPLY_OUTPUT"; then
  pass "Apply generates run ID"
else
  fail "No run ID in apply output"
fi
if grep -q "PROGRESS:20:Creating OpenClaw sandbox" "$APPLY_OUTPUT"; then
  pass "Apply executes sandbox creation step"
else
  fail "Apply did not reach sandbox creation step"
fi
if grep -q "PROGRESS:50:Configuring inference provider" "$APPLY_OUTPUT"; then
  pass "Apply executes provider configuration"
else
  fail "Apply did not reach provider configuration step"
fi
if grep -q "PROGRESS:100:Apply complete" "$APPLY_OUTPUT"; then
  pass "Apply completes full pipeline"
else
  fail "Apply did not complete"
fi
grep -Eq '^sandbox create -g fixture-gateway --from openclaw --name openclaw --policy [^ ]+ --forward 18789$' "$APPLY_CALLS"
grep -qx 'provider create --name nvidia-ncp --type nvidia' "$APPLY_CALLS"
grep -qx 'inference set --provider nvidia-ncp --model nvidia/nemotron-3-super-120b-a12b' "$APPLY_CALLS"
grep -Eq '^policy get -g fixture-gateway --base [^ ]+$' "$APPLY_CALLS"
RUN_ID=$(grep -o 'nc-[0-9]*-[0-9]*-[a-f0-9]*' "$APPLY_OUTPUT" | head -1)
PLAN_FILE="$HOME/.nemoclaw/state/runs/$RUN_ID/plan.json"
node - "$PLAN_FILE" "$RUN_ID" <<'NODE_ASSERT_PLAN'
const fs = require("node:fs");
const plan = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (plan.run_id !== process.argv[3]) throw new Error("persisted run id mismatch");
if (plan.profile !== "ncp") throw new Error("persisted profile mismatch");
if (plan.sandbox_name !== "openclaw" || plan.sandbox_created_by_apply !== true) throw new Error("persisted sandbox receipt mismatch");
if (plan.inference?.provider_name !== "nvidia-ncp" || plan.inference?.model !== "nvidia/nemotron-3-super-120b-a12b" || plan.inference_provider_created_by_apply !== true) throw new Error("persisted provider receipt mismatch");
if (plan.gateway?.name !== "fixture-gateway" || plan.gateway?.host !== "127.0.0.1" || plan.gateway?.port !== 8080) throw new Error("persisted gateway mismatch");
NODE_ASSERT_PLAN
cleanup_apply_fixture
trap - EXIT
`;

const ROOT_BOOT_RECOVERY_PROBE = String.raw`
  set -euo pipefail
  trap 'printf "ROOT_BOOT_RECLAIM_FAIL line=%s status=%s\n" "$LINENO" "$?" >&2' ERR
  {
    sed -n "/^resolve_mutable_config_normalizer() {$/,/^}$/p" /usr/local/bin/nemoclaw-start
    sed -n "/^classify_openclaw_config_seal() {$/,/^}$/p" /usr/local/bin/nemoclaw-start
    sed -n "/^normalize_mutable_config_perms() {$/,/^}$/p" /usr/local/bin/nemoclaw-start
    sed -n "/^reclaim_collapsed_mutable_config() {$/,/^}$/p" /usr/local/bin/nemoclaw-start
    sed -n "/^openclaw_config_dir_owner() {$/,/^}$/p" /usr/local/bin/nemoclaw-start
    sed -n "/^prepare_openclaw_config_startup() {$/,/^}$/p" /usr/local/bin/nemoclaw-start
  } >/tmp/reclaim.sh
  test -s /tmp/reclaim.sh
  source /tmp/reclaim.sh

  chown sandbox:sandbox /sandbox
  chmod 755 /sandbox
  chown root:root /sandbox/.openclaw /sandbox/.openclaw/openclaw.json /sandbox/.openclaw/.config-hash
  chmod 700 /sandbox/.openclaw
  chmod g-s /sandbox/.openclaw
  chmod 600 /sandbox/.openclaw/openclaw.json /sandbox/.openclaw/.config-hash
  run_openclaw_config_guard() {
    case "$1" in
      revoke-startup-ready) return 0 ;;
      recover)
        [ "$(stat -c "%a %U:%G" /sandbox/.openclaw)" = "2770 sandbox:sandbox" ]
        return
        ;;
      *) return 90 ;;
    esac
  }
  prepare_openclaw_config_startup
  [ "$(stat -c "%a %U:%G" /sandbox/.openclaw)" = "2770 sandbox:sandbox" ]
  [ "$(stat -c "%a %U:%G" /sandbox/.openclaw/openclaw.json)" = "660 sandbox:sandbox" ]
  [ "$(stat -c "%a %U:%G" /sandbox/.openclaw/.config-hash)" = "660 sandbox:sandbox" ]
  /usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- sh -c "printf \" \" >>/sandbox/.openclaw/openclaw.json; touch /sandbox/.openclaw/reclaim-write-check"

  chown root:root /sandbox/.openclaw /sandbox/.openclaw/openclaw.json /sandbox/.openclaw/.config-hash
  chmod 755 /sandbox/.openclaw
  chmod g-s /sandbox/.openclaw
  chmod 444 /sandbox/.openclaw/openclaw.json /sandbox/.openclaw/.config-hash
  sealed_before=$(stat -c "%u %g %a" /sandbox/.openclaw /sandbox/.openclaw/openclaw.json /sandbox/.openclaw/.config-hash)
  normalize_mutable_config_perms
  [ "$sealed_before" = "$(stat -c "%u %g %a" /sandbox/.openclaw /sandbox/.openclaw/openclaw.json /sandbox/.openclaw/.config-hash)" ]
  ! /usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- sh -c "printf x >>/sandbox/.openclaw/openclaw.json"

  chmod 644 /sandbox/.openclaw/openclaw.json
  ambiguous_before=$(stat -c "%u %g %a" /sandbox/.openclaw /sandbox/.openclaw/openclaw.json /sandbox/.openclaw/.config-hash)
  rc=0
  normalize_mutable_config_perms || rc=$?
  [ "$rc" -eq 1 ]
  [ "$ambiguous_before" = "$(stat -c "%u %g %a" /sandbox/.openclaw /sandbox/.openclaw/openclaw.json /sandbox/.openclaw/.config-hash)" ]

  chown root:sandbox /sandbox
  chmod 1775 /sandbox
  chmod 700 /sandbox/.openclaw
  chmod g-s /sandbox/.openclaw
  chmod 600 /sandbox/.openclaw/openclaw.json /sandbox/.openclaw/.config-hash
  parent_before=$(stat -c "%u %g %a" /sandbox /sandbox/.openclaw /sandbox/.openclaw/openclaw.json /sandbox/.openclaw/.config-hash)
  rc=0
  normalize_mutable_config_perms || rc=$?
  [ "$rc" -eq 1 ]
  [ "$parent_before" = "$(stat -c "%u %g %a" /sandbox /sandbox/.openclaw /sandbox/.openclaw/openclaw.json /sandbox/.openclaw/.config-hash)" ]
  chown sandbox:sandbox /sandbox
  chmod 755 /sandbox

  rm -f /sandbox/.openclaw/openclaw.json
  printf "{}\n" >/sandbox/reclaim-hardlink-target
  chmod 600 /sandbox/reclaim-hardlink-target
  chown root:root /sandbox/reclaim-hardlink-target /sandbox/.openclaw/.config-hash /sandbox/.openclaw
  chmod 600 /sandbox/.openclaw/.config-hash
  chmod 700 /sandbox/.openclaw
  chmod g-s /sandbox/.openclaw
  ln /sandbox/reclaim-hardlink-target /sandbox/.openclaw/openclaw.json
  hardlink_before=$(stat -c "%u %g %a %h" /sandbox/reclaim-hardlink-target)
  rc=0
  normalize_mutable_config_perms || rc=$?
  [ "$rc" -eq 1 ]
  [ "$hardlink_before" = "$(stat -c "%u %g %a %h" /sandbox/reclaim-hardlink-target)" ]

  rm -f /sandbox/.openclaw/openclaw.json
  printf "protected\n" >/sandbox/reclaim-symlink-target
  chmod 600 /sandbox/reclaim-symlink-target
  chown root:root /sandbox/reclaim-symlink-target
  ln -s /sandbox/reclaim-symlink-target /sandbox/.openclaw/openclaw.json
  symlink_before=$(stat -c "%u %g %a" /sandbox/reclaim-symlink-target)
  rc=0
  normalize_mutable_config_perms || rc=$?
  [ "$rc" -eq 1 ]
  [ "$symlink_before" = "$(stat -c "%u %g %a" /sandbox/reclaim-symlink-target)" ]
  [ -L /sandbox/.openclaw/openclaw.json ]

  rm -f /sandbox/.openclaw/openclaw.json
  printf "{}\n" >/sandbox/.openclaw/openclaw.json
  chown root:root /sandbox/.openclaw /sandbox/.openclaw/openclaw.json /sandbox/.openclaw/.config-hash
  chmod 700 /sandbox/.openclaw
  chmod g-s /sandbox/.openclaw
  chmod 600 /sandbox/.openclaw/openclaw.json /sandbox/.openclaw/.config-hash
  python3() {
    if [ "${"${2:-}"}" = "-" ] && [ ! -e /tmp/reclaim-open-raced ]; then
      command python3 "$@"
      local classify_rc=$?
      : >/tmp/reclaim-open-raced
      mv /sandbox/.openclaw /sandbox/.openclaw-raced
      return "$classify_rc"
    fi
    command python3 "$@"
  }
  race_output=""
  rc=0
  race_output=$(normalize_mutable_config_perms 2>&1) || rc=$?
  [ "$rc" -eq 1 ]
  echo "$race_output" | grep -q "descriptor-safe reclaim detected an unsafe link, race, owner, or metadata state"
  [ ! -e /sandbox/.openclaw ]
  [ "$(stat -c "%u %g %a" /sandbox/.openclaw-raced)" = "0 0 700" ]
  [ "$(stat -c "%u %g %a" /sandbox/.openclaw-raced/openclaw.json)" = "0 0 600" ]
  [ "$(stat -c "%u %g %a" /sandbox/.openclaw-raced/.config-hash)" = "0 0 600" ]
  printf "ROOT_BOOT_RECLAIM_OK\n"
`;

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

test.runIf(RUN_MANAGED_IMAGE_SECURITY)(
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
      `cat >/tmp/packaged-image-contract.mjs <<'NEMOCLAW_PACKAGED_IMAGE_CONTRACT'\n${PACKAGED_IMAGE_CONTRACT_PROBE}\nNEMOCLAW_PACKAGED_IMAGE_CONTRACT\nnode /tmp/packaged-image-contract.mjs`,
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

    await runContainer(
      host,
      image,
      PACKAGED_IMAGE_APPLY_PROBE,
      "managed-image-openclaw-packaged-apply",
    );

    progress.phase("verify packaged configuration repair and refusal");
    await runContainer(
      host,
      image,
      ROOT_BOOT_RECOVERY_PROBE,
      "managed-image-openclaw-root-boot-recovery",
    );
    await runContainer(
      host,
      image,
      [
        '{ sed -n "/^resolve_mutable_config_normalizer() {$/,/^}$/p" /usr/local/bin/nemoclaw-start; sed -n "/^normalize_mutable_config_perms() {$/,/^}$/p" /usr/local/bin/nemoclaw-start; } >/tmp/normalize.sh',
        "source /tmp/normalize.sh",
        `before="$(stat -c '%u %g %a' /sandbox/.openclaw)"`,
        "rc=0",
        "output=$(normalize_mutable_config_perms 2>&1) || rc=$?",
        '[ "$rc" -eq 1 ]',
        `[ "$before" = "$(stat -c '%u %g %a' /sandbox/.openclaw)" ]`,
        'grep -q "CAP_SETGID" <<<"$output"',
      ].join("\n"),
      "managed-image-openclaw-missing-cap-setgid",
      ["--cap-drop=CAP_DAC_OVERRIDE", "--cap-drop=CAP_SETGID"],
    );
    await runContainer(
      host,
      image,
      [
        '{ sed -n "/^resolve_mutable_config_normalizer() {$/,/^}$/p" /usr/local/bin/nemoclaw-start; sed -n "/^normalize_mutable_config_perms() {$/,/^}$/p" /usr/local/bin/nemoclaw-start; } >/tmp/normalize.sh',
        "source /tmp/normalize.sh",
        `before="$(stat -c '%u %g %a' /sandbox/.openclaw)"`,
        "rc=0",
        "output=$(normalize_mutable_config_perms 2>&1) || rc=$?",
        '[ "$rc" -eq 1 ]',
        `[ "$before" = "$(stat -c '%u %g %a' /sandbox/.openclaw)" ]`,
        'grep -q "CAP_SETUID" <<<"$output"',
      ].join("\n"),
      "managed-image-openclaw-missing-cap-setuid",
      ["--cap-drop=CAP_DAC_OVERRIDE", "--cap-drop=CAP_SETUID"],
    );
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
        `cat >/tmp/write-normalizer-handoff-race.py <<'NEMOCLAW_NORMALIZER_RACE'\n${NORMALIZER_HANDOFF_RACE_PROBE}\nNEMOCLAW_NORMALIZER_RACE\npython3 /tmp/write-normalizer-handoff-race.py`,
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
      repairVolumeCreated = true;
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
      refusalVolumeCreated = true;
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
