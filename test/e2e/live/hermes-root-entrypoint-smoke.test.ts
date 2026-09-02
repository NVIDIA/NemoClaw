// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { setTimeout as delay } from "node:timers/promises";

import { type DockerCommandResult, DockerProbe, resultText } from "../fixtures/docker-probe.ts";
import { type E2ETargetFixtures, expect, test } from "../fixtures/e2e-test.ts";

// real Docker/root-entrypoint smoke: it builds the Hermes image when no prebuilt
// NEMOCLAW_HERMES_TEST_IMAGE is supplied, starts /usr/local/bin/nemoclaw-start
// as root, and verifies health, gateway privilege separation, runtime layout,
// sticky config protection, and legacy PID and dashboard-profile migration.

const HEALTH_ATTEMPTS = 90;
const HEALTH_POLL_MS = 2_000;
const BUILD_TIMEOUT_MS = 10 * 60_000;
const RUN_TIMEOUT_MS = 60_000;

function safeTag(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "local";
}

const ROOT_ENTRYPOINT_RUN_ID = safeTag(
  `${process.env.GITHUB_RUN_ID ?? "local"}-${process.pid}-${Date.now()}`,
);
const ROOT_ENTRYPOINT_IMAGE =
  process.env.NEMOCLAW_HERMES_TEST_IMAGE ??
  `nemoclaw-hermes-root-entrypoint-smoke:${ROOT_ENTRYPOINT_RUN_ID}`;
const ROOT_ENTRYPOINT_BASE_IMAGE = `nemoclaw-hermes-sandbox-base-local:root-entrypoint-${ROOT_ENTRYPOINT_RUN_ID}`;
let localImageBuild: Promise<void> | undefined;

async function requireDocker(probe: DockerProbe, skip: (message: string) => void): Promise<void> {
  const result = await probe.run(["info"], { artifactName: "docker-info", timeoutMs: 30_000 });
  if (result.exitCode === 0) return;

  if (process.env.GITHUB_ACTIONS === "true") {
    throw new Error(`Docker is required for Hermes root-entrypoint smoke:\n${resultText(result)}`);
  }
  skip("Docker daemon is required for Hermes root-entrypoint smoke");
}

async function buildImageIfNeeded(
  probe: DockerProbe,
  image: string,
  baseImage: string,
): Promise<void> {
  if (process.env.NEMOCLAW_HERMES_TEST_IMAGE) {
    await probe.expect(["image", "inspect", image], {
      artifactName: "inspect-prebuilt-hermes-image",
      timeoutMs: 30_000,
    });
    return;
  }

  localImageBuild ??= (async () => {
    await probe.expect(["build", "-f", "agents/hermes/Dockerfile.base", "-t", baseImage, "."], {
      artifactName: "build-hermes-base-image",
      timeoutMs: BUILD_TIMEOUT_MS,
    });
    await probe.expect(
      [
        "build",
        "-f",
        "agents/hermes/Dockerfile",
        "--build-arg",
        `BASE_IMAGE=${baseImage}`,
        "-t",
        image,
        ".",
      ],
      { artifactName: "build-hermes-production-image", timeoutMs: BUILD_TIMEOUT_MS },
    );
  })();
  await localImageBuild;
}

async function dockerExecSh(
  probe: DockerProbe,
  container: string,
  script: string,
  artifactName: string,
): Promise<DockerCommandResult> {
  return probe.run(["exec", container, "sh", "-lc", script], { artifactName });
}

async function expectContainerSh(
  probe: DockerProbe,
  container: string,
  message: string,
  script: string,
): Promise<DockerCommandResult> {
  const result = await dockerExecSh(probe, container, script, message);
  expect(result.exitCode, `${container}: ${message}\n${resultText(result)}`).toBe(0);
  return result;
}

async function expectContainerShFails(
  probe: DockerProbe,
  container: string,
  message: string,
  script: string,
): Promise<void> {
  const result = await dockerExecSh(probe, container, script, message);
  expect(result.exitCode, `${container}: ${message}\n${resultText(result)}`).not.toBe(0);
}

async function dumpContainerDiagnostics(probe: DockerProbe, container: string): Promise<void> {
  const inspect = await probe.run(["inspect", container], {
    artifactName: `diag-${container}-inspect`,
    timeoutMs: 30_000,
  });
  if (inspect.exitCode !== 0) return;

  await probe.run(
    [
      "ps",
      "-a",
      "--filter",
      `name=^/${container}$`,
      "--format",
      "table {{.Names}}\t{{.Status}}\t{{.Image}}",
    ],
    { artifactName: `diag-${container}-ps`, timeoutMs: 30_000 },
  );
  await probe.run(["logs", container], {
    artifactName: `diag-${container}-logs`,
    timeoutMs: 30_000,
  });
  await probe.run(
    [
      "exec",
      container,
      "sh",
      "-lc",
      [
        "set +e",
        'echo "== identity =="',
        "id",
        'echo "== hermes tree =="',
        "ls -ld /sandbox/.hermes /sandbox/.hermes/runtime /sandbox/.hermes/logs /sandbox/.hermes/logs/curator /sandbox/.hermes/hooks /sandbox/.hermes/image_cache /sandbox/.hermes/audio_cache 2>&1",
        "ls -l /sandbox/.hermes/gateway.pid /sandbox/.hermes/runtime/gateway.pid /sandbox/.hermes/config.yaml 2>&1",
        'echo "== processes =="',
        'ps -eo user=,pid=,args= | grep -E "hermes|socat" | grep -v grep',
        'echo "== start log =="',
        "tail -n 120 /tmp/nemoclaw-start.log 2>&1",
        'echo "== gateway log =="',
        "tail -n 160 /tmp/gateway.log 2>&1",
      ].join("; "),
    ],
    { artifactName: `diag-${container}-runtime`, timeoutMs: 30_000 },
  );
}

async function waitForHealth(probe: DockerProbe, container: string): Promise<void> {
  for (let attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt++) {
    const health = await dockerExecSh(
      probe,
      container,
      String.raw`
tmp="$(mktemp)"
code="$(curl -sS -o "$tmp" -w '%{http_code}' --max-time 2 http://127.0.0.1:8642/health 2>/dev/null || true)"
body="$(cat "$tmp" 2>/dev/null || true)"
rm -f "$tmp"
[ -n "$code" ] || code=000
printf '%s\n%s' "$code" "$body"
`,
      `${container}-health-${attempt}`,
    );
    const [code = "000", ...bodyLines] = health.stdout.split(/\r?\n/);
    const body = bodyLines.join("\n");
    switch (code) {
      case "200":
        expect(body, `${container}: health response did not report status ok`).toMatch(
          /"status"\s*:\s*"ok"/,
        );
        expect(body, `${container}: health response did not report Hermes platform`).toMatch(
          /"platform"\s*:\s*"hermes-agent"/,
        );
        return;
      case "401":
        return;
    }

    const running = await probe.run(["inspect", "-f", "{{.State.Running}}", container], {
      artifactName: `${container}-running-${attempt}`,
      timeoutMs: 30_000,
    });
    if (running.stdout.trim() !== "true") {
      throw new Error(
        `${container}: container exited before health became ready\n${resultText(running)}`,
      );
    }
    await delay(HEALTH_POLL_MS);
  }

  throw new Error(`${container}: Hermes health did not become ready`);
}

async function assertGatewayLogClean(probe: DockerProbe, container: string): Promise<void> {
  await expectContainerSh(
    probe,
    container,
    "gateway log contains PID race failure",
    "test -r /tmp/gateway.log && ! grep -F 'PID file race lost' /tmp/gateway.log",
  );
  await expectContainerSh(
    probe,
    container,
    "gateway log contains config load failure",
    "test -r /tmp/gateway.log && ! grep -F 'Could not load config.yaml' /tmp/gateway.log",
  );
}

async function assertImageCapabilitySurface(probe: DockerProbe, container: string): Promise<void> {
  await expectContainerSh(
    probe,
    container,
    "Hermes image is missing an optional runtime capability or root sandbox-group membership",
    String.raw`set -eu
id -Gn root | tr ' ' '\n' | grep -Fx sandbox
test "$(command -v hermes)" = /usr/local/bin/hermes
/usr/local/bin/hermes --version >/dev/null
/opt/hermes/.venv/bin/python -I - <<'PY'
import acp
import anthropic
import discord
import fastapi
import mcp
import ptyprocess
import uvicorn
from acp_adapter.server import HermesACPAgent

assert HermesACPAgent is not None
PY`,
  );
}

async function assertRuntimeLayout(probe: DockerProbe, container: string): Promise<void> {
  await expectContainerSh(
    probe,
    container,
    "Hermes config root mode is not 3770",
    "[ \"$(stat -c '%a' /sandbox/.hermes)\" = '3770' ]",
  );
  await expectContainerSh(
    probe,
    container,
    "required Hermes v0.14 directories are missing",
    'for dir in hooks image_cache audio_cache logs/curator; do test -d "/sandbox/.hermes/$dir"; done',
  );
  await expectContainerSh(
    probe,
    container,
    "gateway user cannot write required Hermes v0.14 directories",
    '/usr/bin/setpriv --reuid=gateway --regid=gateway --init-groups -- sh -lc \'for dir in hooks image_cache audio_cache logs/curator; do p="/sandbox/.hermes/$dir/.nemoclaw-write-test"; : >"$p" && rm -f "$p"; done\'',
  );
  await expectContainerSh(
    probe,
    container,
    "Hermes history ownership does not preserve append access and sticky-entry protection",
    String.raw`set -eu
history=/sandbox/.hermes/.hermes_history
test "$(stat -c '%U:%G %a' "$history")" = "gateway:sandbox 660"
/usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- sh -lc 'printf "sandbox history probe\n" >>/sandbox/.hermes/.hermes_history'
if /usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- rm -f "$history"; then
  echo "sandbox user replaced gateway-owned history entry" >&2
  exit 1
fi
test -f "$history" && test ! -L "$history"`,
  );
  await expectContainerSh(
    probe,
    container,
    "gateway.pid is not a regular runtime file",
    "test -f /sandbox/.hermes/runtime/gateway.pid && test ! -L /sandbox/.hermes/runtime/gateway.pid && test ! -e /sandbox/.hermes/gateway.pid && test ! -L /sandbox/.hermes/gateway.pid",
  );
  await expectContainerShFails(
    probe,
    container,
    "gateway user was able to remove config.yaml",
    "/usr/bin/setpriv --reuid=gateway --regid=gateway --init-groups -- rm /sandbox/.hermes/config.yaml",
  );
  await expectContainerSh(
    probe,
    container,
    "config.yaml disappeared after gateway remove attempt",
    "test -f /sandbox/.hermes/config.yaml",
  );
}

async function assertBuildOnlyPathsAbsent(probe: DockerProbe, container: string): Promise<void> {
  await expectContainerSh(
    probe,
    container,
    "build-only Hermes paths are present in the runtime image",
    'for path in /opt/hermes/tests /root/.npm /root/.cache/electron /root/.cache/node-gyp /root/.cache/uv; do test ! -e "$path" && test ! -L "$path"; done',
  );
}

async function assertBearerAuth(probe: DockerProbe, container: string): Promise<void> {
  await expectContainerSh(
    probe,
    container,
    "Hermes API bearer auth did not reject missing/wrong tokens and accept API_SERVER_KEY",
    String.raw`
set -eu
token="$(python3 - <<'PY'
from pathlib import Path

for raw_line in Path("/sandbox/.hermes/.env").read_text(encoding="utf-8").splitlines():
    line = raw_line.strip()
    if line.startswith("export "):
        line = line[len("export "):].lstrip()
    if line.startswith("API_SERVER_KEY="):
        print(line.split("=", 1)[1].strip().strip("\"'"))
        break
else:
    raise SystemExit("API_SERVER_KEY missing")
PY
)"
test -n "$token"
probe_status() {
  tmp="$(mktemp)"
  code="$(curl -sS -o "$tmp" -w '%{http_code}' --max-time 15 "$@" || printf '000')"
  cat "$tmp" >/dev/null
  rm -f "$tmp"
  printf '%s' "$code"
}
missing="$(probe_status http://127.0.0.1:8642/v1/models)"
wrong="$(probe_status -H "Authorization: Bearer wrong-token" http://127.0.0.1:8642/v1/models)"
valid="$(probe_status -H "Authorization: Bearer $token" http://127.0.0.1:8642/v1/models)"
printf 'missing=%s wrong=%s valid=%s\n' "$missing" "$wrong" "$valid"
[ "$missing" = "401" ]
[ "$wrong" = "401" ]
case "$valid" in
  2??|3??|404) ;;
  *) exit 1 ;;
esac
`,
  );
}

async function assertDashboardHome(probe: DockerProbe, container: string): Promise<void> {
  await expectContainerSh(
    probe,
    container,
    "Hermes dashboard profile did not preserve ownership, file modes, or the API credential boundary",
    String.raw`
set -eu
for _ in $(seq 1 30); do
  [ -f /sandbox/.hermes/profiles/dashboard-home/config.yaml ] && [ -f /sandbox/.hermes/profiles/dashboard-home/.env ] && break
  sleep 1
done
[ "$(stat -c '%a' /sandbox/.hermes/profiles/dashboard-home)" = "700" ]
[ "$(stat -c '%U:%G' /sandbox/.hermes/profiles/dashboard-home)" = "sandbox:sandbox" ]
[ "$(stat -c '%a' /sandbox/.hermes/profiles/dashboard-home/config.yaml)" = "600" ]
[ "$(stat -c '%a' /sandbox/.hermes/profiles/dashboard-home/.env)" = "600" ]
[ "$(stat -c '%U:%G' /sandbox/.hermes/profiles/dashboard-home/config.yaml)" = "sandbox:sandbox" ]
[ "$(stat -c '%U:%G' /sandbox/.hermes/profiles/dashboard-home/.env)" = "sandbox:sandbox" ]
python3 - <<'PY'
from pathlib import Path

allowed = {
    "API_SERVER_HOST",
    "API_SERVER_PORT",
    "NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER",
    "FIRECRAWL_GATEWAY_URL",
    "OPENAI_AUDIO_GATEWAY_URL",
    "BROWSER_USE_GATEWAY_URL",
    "FAL_QUEUE_GATEWAY_URL",
    "MODAL_GATEWAY_URL",
}
env_path = Path("/sandbox/.hermes/profiles/dashboard-home/.env")
keys = set()
for raw_line in env_path.read_text(encoding="utf-8").splitlines():
    line = raw_line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    if line.startswith("export "):
        line = line[len("export "):].lstrip()
    keys.add(line.split("=", 1)[0].strip())
if "API_SERVER_KEY" in keys:
    raise SystemExit("dashboard .env contains API_SERVER_KEY")
extra = sorted(keys - allowed)
missing = sorted({"API_SERVER_HOST", "API_SERVER_PORT"} - keys)
if extra or missing:
    raise SystemExit(f"dashboard .env allowlist mismatch extra={extra} missing={missing}")
config_text = Path("/sandbox/.hermes/profiles/dashboard-home/config.yaml").read_text(encoding="utf-8")
for fragment in ("model:", "custom_providers:", "_nemoclaw_upstream:"):
    if fragment not in config_text:
        raise SystemExit(f"dashboard config missing {fragment}")
PY
`,
  );
}

async function assertLegacyDashboardMigration(
  probe: DockerProbe,
  container: string,
): Promise<void> {
  await expectContainerSh(
    probe,
    container,
    "legacy dashboard profile was not migrated with its state and permissions",
    String.raw`
set -eu
test ! -e /sandbox/.hermes/dashboard-home
test ! -L /sandbox/.hermes/dashboard-home
test -f /sandbox/.hermes/profiles/dashboard-home/MEMORY.md
grep -Fx "legacy dashboard memory" /sandbox/.hermes/profiles/dashboard-home/MEMORY.md
[ "$(stat -c '%a' /sandbox/.hermes/profiles/dashboard-home)" = "700" ]
[ "$(stat -c '%U:%G' /sandbox/.hermes/profiles/dashboard-home)" = "sandbox:sandbox" ]
[ "$(stat -c '%a' /sandbox/.hermes/profiles/dashboard-home/MEMORY.md)" = "600" ]
[ "$(stat -c '%U:%G' /sandbox/.hermes/profiles/dashboard-home/MEMORY.md)" = "sandbox:sandbox" ]
`,
  );
}

async function assertGatewayProcess(probe: DockerProbe, container: string): Promise<void> {
  await expectContainerSh(
    probe,
    container,
    "Hermes gateway process is not running as gateway user",
    'ps -eo user=,args= | awk \'$1 == "gateway" && (index($0, "hermes gateway run") || index($0, "hermes.real gateway run")) { found = 1 } END { exit found ? 0 : 1 }\'',
  );
  await expectContainerSh(
    probe,
    container,
    "start log does not show gateway privilege separation",
    "grep -F \"hermes gateway launched as 'gateway' user\" /tmp/nemoclaw-start.log",
  );
}

async function assertGatewayKanbanDispatcher(
  probe: DockerProbe,
  container: string,
  expected: "0" | "1",
): Promise<void> {
  await expectContainerSh(
    probe,
    container,
    `gateway process did not inherit HERMES_KANBAN_DISPATCH_IN_GATEWAY=${expected}`,
    `pid="$(ps -eo pid=,user=,args= | awk '$2 == "gateway" && (index($0, "hermes gateway run") || index($0, "hermes.real gateway run")) { print $1; exit }')"; test -n "$pid"; tr '\\0' '\\n' <"/proc/$pid/environ" | grep -Fx 'HERMES_KANBAN_DISPATCH_IN_GATEWAY=${expected}'`,
  );
}

async function runCleanVariant(
  probe: DockerProbe,
  image: string,
  runId: string,
  containers: string[],
): Promise<void> {
  const container = `nemoclaw-hermes-root-clean-${runId}`;
  await probe.expect(
    [
      "run",
      "-d",
      "--name",
      container,
      "--env",
      "HERMES_KANBAN_DISPATCH_IN_GATEWAY=1",
      image,
      "/usr/local/bin/nemoclaw-start",
    ],
    { artifactName: "start-clean-root-entrypoint-container", timeoutMs: RUN_TIMEOUT_MS },
  );
  containers.push(container);

  await waitForHealth(probe, container);
  await assertGatewayProcess(probe, container);
  await assertGatewayKanbanDispatcher(probe, container, "1");
  await assertGatewayLogClean(probe, container);
  await assertImageCapabilitySurface(probe, container);
  await assertRuntimeLayout(probe, container);
  await assertBuildOnlyPathsAbsent(probe, container);
  await assertBearerAuth(probe, container);
  await assertDashboardHome(probe, container);
}

async function runLegacyVariant(
  probe: DockerProbe,
  image: string,
  runId: string,
  containers: string[],
): Promise<void> {
  const container = `nemoclaw-hermes-root-legacy-${runId}`;
  const legacyBootstrap = `set -euo pipefail
rm -f /sandbox/.hermes/gateway.pid
printf "stale pid\n" >/sandbox/.hermes/runtime/gateway.pid
printf "stale lock\n" >/sandbox/.hermes/runtime/gateway.lock
ln -s runtime/gateway.pid /sandbox/.hermes/gateway.pid
install -d -m 770 -o sandbox -g sandbox /sandbox/.hermes/dashboard-home
printf "legacy dashboard memory\n" >/sandbox/.hermes/dashboard-home/MEMORY.md
chown sandbox:sandbox /sandbox/.hermes/dashboard-home/MEMORY.md
chmod 600 /sandbox/.hermes/dashboard-home/MEMORY.md
chmod 750 /sandbox/.hermes
chown sandbox:sandbox /sandbox/.hermes/sessions /sandbox/.hermes/gateway /sandbox/.hermes/runtime
chmod 750 /sandbox/.hermes/sessions /sandbox/.hermes/gateway /sandbox/.hermes/runtime
rm -rf /sandbox/.hermes/hooks /sandbox/.hermes/image_cache /sandbox/.hermes/audio_cache /sandbox/.hermes/logs/curator
exec /usr/local/bin/nemoclaw-start /usr/local/bin/nemoclaw-start`;

  await probe.expect(
    ["run", "-d", "--name", container, "--entrypoint", "/bin/bash", image, "-lc", legacyBootstrap],
    { artifactName: "start-legacy-layout-root-entrypoint-container", timeoutMs: RUN_TIMEOUT_MS },
  );
  containers.push(container);

  await waitForHealth(probe, container);
  await expectContainerSh(
    probe,
    container,
    "restored state directories were not repaired for cross-UID writes",
    String.raw`set -eu
for dir in sessions gateway runtime; do
  test "$(stat -c '%U:%G %a' "/sandbox/.hermes/$dir")" = "gateway:sandbox 2770"
  /usr/bin/setpriv --reuid=gateway --regid=gateway --init-groups -- sh -lc ": > /sandbox/.hermes/$dir/.nemoclaw-gateway-write-test && rm -f /sandbox/.hermes/$dir/.nemoclaw-gateway-write-test"
  /usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- sh -lc ": > /sandbox/.hermes/$dir/.nemoclaw-sandbox-write-test && rm -f /sandbox/.hermes/$dir/.nemoclaw-sandbox-write-test"
done`,
  );
  await assertGatewayProcess(probe, container);
  await assertGatewayLogClean(probe, container);
  await assertRuntimeLayout(probe, container);
  await assertLegacyDashboardMigration(probe, container);
  await expectContainerSh(
    probe,
    container,
    "legacy gateway.pid symlink migration was not logged",
    "grep -F 'Removing unsafe stale Hermes legacy PID file symlink' /tmp/nemoclaw-start.log",
  );
}

async function runLockedRootVariant(
  probe: DockerProbe,
  image: string,
  runId: string,
  containers: string[],
): Promise<void> {
  const container = `nemoclaw-hermes-root-locked-${runId}`;
  const lockedBootstrap = `set -euo pipefail
rm -f /sandbox/.hermes/.hermes_history
chown root:sandbox /sandbox /sandbox/.hermes
chmod 1775 /sandbox
chmod 3770 /sandbox/.hermes
chown root:root /sandbox/.hermes/config.yaml /sandbox/.hermes/.env /sandbox/.hermes/.config-hash
chmod 444 /sandbox/.hermes/config.yaml /sandbox/.hermes/.env /sandbox/.hermes/.config-hash
sha256sum /sandbox/.hermes/config.yaml /sandbox/.hermes/.env /sandbox/.hermes/.config-hash >/tmp/nemoclaw-locked-config.sha256
install -d -m 755 /tmp/nemoclaw-hostile-python
printf '%s\n' 'import os' 'from pathlib import Path' 'if os.geteuid() == 0:' '    Path("/tmp/nemoclaw-root-sitecustomize-ran").write_text("root")' >/tmp/nemoclaw-hostile-python/sitecustomize.py
chmod 444 /tmp/nemoclaw-hostile-python/sitecustomize.py
export PYTHONPATH=/tmp/nemoclaw-hostile-python
export HERMES_KANBAN_DISPATCH_IN_GATEWAY=1
exec /usr/local/bin/nemoclaw-start /usr/local/bin/nemoclaw-start`;

  await probe.expect(
    ["run", "-d", "--name", container, "--entrypoint", "/bin/bash", image, "-lc", lockedBootstrap],
    { artifactName: "start-locked-root-entrypoint-container", timeoutMs: RUN_TIMEOUT_MS },
  );
  containers.push(container);

  await waitForHealth(probe, container);
  await expectContainerSh(
    probe,
    container,
    "locked Hermes config changed while history was recovered",
    String.raw`set -eu
test "$(stat -c '%U:%G %a' /sandbox)" = "root:sandbox 1775"
test "$(stat -c '%U:%G %a' /sandbox/.hermes)" = "root:sandbox 3770"
for file in config.yaml .env .config-hash; do
  test "$(stat -c '%U:%G %a' "/sandbox/.hermes/$file")" = "root:root 444"
done
test -f /tmp/nemoclaw-hostile-python/sitecustomize.py
test ! -e /tmp/nemoclaw-root-sitecustomize-ran
sha256sum -c /tmp/nemoclaw-locked-config.sha256`,
  );
  await assertGatewayProcess(probe, container);
  await assertGatewayKanbanDispatcher(probe, container, "0");
  await assertGatewayLogClean(probe, container);
  await assertRuntimeLayout(probe, container);
}

async function runHardLinkRefusalVariant(
  probe: DockerProbe,
  image: string,
  runId: string,
  containers: string[],
  kind: "history" | "logs",
): Promise<void> {
  const container = `nemoclaw-hermes-root-${kind}-hardlink-${runId}`;
  const target = "/sandbox/.hermes/config.yaml";
  const setup =
    kind === "history"
      ? String.raw`
rm -f /sandbox/.hermes/.hermes_history
chown root:sandbox /sandbox /sandbox/.hermes
chmod 1775 /sandbox
chmod 3770 /sandbox/.hermes
chown root:root /sandbox/.hermes/config.yaml /sandbox/.hermes/.env /sandbox/.hermes/.config-hash
chmod 444 /sandbox/.hermes/config.yaml /sandbox/.hermes/.env /sandbox/.hermes/.config-hash
ln /sandbox/.hermes/config.yaml /sandbox/.hermes/.hermes_history`
      : String.raw`
install -d -m 2770 -o sandbox -g sandbox /sandbox/.hermes/logs/curator
rm -f /sandbox/.hermes/logs/curator/hardlink.log
ln /sandbox/.hermes/config.yaml /sandbox/.hermes/logs/curator/hardlink.log`;
  const expectedEvent =
    kind === "history"
      ? "Hermes pre-launch layout repair failed at history file"
      : "Hermes pre-launch layout repair failed at logs directory";
  const bootstrap = `set -euo pipefail
${setup}
stat -c '%U:%G %a' ${target} >/tmp/nemoclaw-protected-file.stat
sha256sum ${target} >/tmp/nemoclaw-protected-file.sha256
set +e
/usr/bin/timeout 30s /usr/local/bin/nemoclaw-start /usr/local/bin/nemoclaw-start >/tmp/nemoclaw-hardlink-start.log 2>&1
startup_status=$?
set -e
test "$startup_status" -ne 0
test "$startup_status" -ne 124
test "$(stat -c '%U:%G %a' ${target})" = "$(cat /tmp/nemoclaw-protected-file.stat)"
sha256sum -c /tmp/nemoclaw-protected-file.sha256
grep -F 'has hard-link count' /tmp/nemoclaw-hardlink-start.log
grep -F ${JSON.stringify(expectedEvent)} /tmp/nemoclaw-hardlink-start.log
cat /tmp/nemoclaw-hardlink-start.log`;

  await probe.expect(
    ["run", "-d", "--name", container, "--entrypoint", "/bin/bash", image, "-lc", bootstrap],
    { artifactName: `start-${kind}-hardlink-refusal-container`, timeoutMs: RUN_TIMEOUT_MS },
  );
  containers.push(container);
  const wait = await probe.run(["wait", container], {
    artifactName: `wait-${kind}-hardlink-refusal-container`,
    timeoutMs: RUN_TIMEOUT_MS,
  });
  expect(wait.exitCode, resultText(wait)).toBe(0);
  expect(wait.stdout.trim(), resultText(wait)).toBe("0");
}

async function runMutableLayoutSwapRefusalVariant(
  probe: DockerProbe,
  image: string,
  runId: string,
  containers: string[],
): Promise<void> {
  const container = `nemoclaw-hermes-root-layout-swap-${runId}`;
  const bootstrap = String.raw`set -euo pipefail
startup_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
python_path="$(PATH="$startup_path" command -v python3)"
real_python="$python_path.nemoclaw-test-real"
mv "$python_path" "$real_python"
install -d -m 755 /tmp/nemoclaw-layout-external
printf 'outside sentinel\n' >/tmp/nemoclaw-layout-external/sentinel.txt
chmod 640 /tmp/nemoclaw-layout-external/sentinel.txt
cat >"$python_path" <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
if [ "$(printenv NEMOCLAW_HERMES_LAYOUT_DIR_NAME || true)" != "." ]; then
  exec "$NEMOCLAW_TEST_REAL_PYTHON" "$@"
fi
tee /tmp/nemoclaw-layout-repair.py >/dev/null
exec "$NEMOCLAW_TEST_REAL_PYTHON" -I -c '
import os

real_fchown = os.fchown


def swap_then_fchown(fd, uid, gid):
    os.rename("/sandbox/.hermes", "/tmp/nemoclaw-original-hermes-root")
    os.symlink("/tmp/nemoclaw-layout-external", "/sandbox/.hermes")
    return real_fchown(fd, uid, gid)


os.fchown = swap_then_fchown
script = "/tmp/nemoclaw-layout-repair.py"
with open(script, encoding="utf-8") as stream:
    exec(compile(stream.read(), script, "exec"))
'
WRAPPER
chmod 755 "$python_path"
export NEMOCLAW_TEST_REAL_PYTHON="$real_python"
stat -c '%U:%G %a %s' /tmp/nemoclaw-layout-external /tmp/nemoclaw-layout-external/sentinel.txt >/tmp/nemoclaw-layout-external.stat
sha256sum /tmp/nemoclaw-layout-external/sentinel.txt >/tmp/nemoclaw-layout-external.sha256
set +e
/usr/bin/timeout 30s /usr/local/bin/nemoclaw-start /usr/local/bin/nemoclaw-start >/tmp/nemoclaw-layout-swap-start.log 2>&1
startup_status=$?
set -e
test "$startup_status" -ne 0
test "$startup_status" -ne 124
test -L /sandbox/.hermes
test "$(readlink /sandbox/.hermes)" = "/tmp/nemoclaw-layout-external"
test "$(stat -c '%U:%G %a %s' /tmp/nemoclaw-layout-external /tmp/nemoclaw-layout-external/sentinel.txt)" = "$(cat /tmp/nemoclaw-layout-external.stat)"
sha256sum -c /tmp/nemoclaw-layout-external.sha256
grep -F '/sandbox/.hermes changed during repair' /tmp/nemoclaw-layout-swap-start.log
cat /tmp/nemoclaw-layout-swap-start.log`;

  await probe.expect(
    ["run", "-d", "--name", container, "--entrypoint", "/bin/bash", image, "-lc", bootstrap],
    { artifactName: "start-root-layout-swap-refusal-container", timeoutMs: RUN_TIMEOUT_MS },
  );
  containers.push(container);
  const wait = await probe.run(["wait", container], {
    artifactName: "wait-root-layout-swap-refusal-container",
    timeoutMs: RUN_TIMEOUT_MS,
  });
  expect(wait.exitCode, resultText(wait)).toBe(0);
  expect(wait.stdout.trim(), resultText(wait)).toBe("0");
}

async function runNonRootHistoryOwnershipRefusalVariant(
  probe: DockerProbe,
  image: string,
  runId: string,
  containers: string[],
): Promise<void> {
  const container = `nemoclaw-hermes-nonroot-history-owner-${runId}`;
  const bootstrap = `set -euo pipefail
chown sandbox:root /sandbox/.hermes/.hermes_history
chmod 660 /sandbox/.hermes/.hermes_history
stat -c '%U:%G %a' /sandbox/.hermes/.hermes_history >/tmp/nemoclaw-history.stat
set +e
/usr/bin/timeout 30s /usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- /usr/local/bin/nemoclaw-start /usr/local/bin/nemoclaw-start >/tmp/nemoclaw-history-owner-start.log 2>&1
startup_status=$?
set -e
test "$startup_status" -ne 0
test "$startup_status" -ne 124
test "$(stat -c '%U:%G %a' /sandbox/.hermes/.hermes_history)" = "$(cat /tmp/nemoclaw-history.stat)"
grep -F 'has group gid' /tmp/nemoclaw-history-owner-start.log
grep -F 'Hermes pre-launch layout repair failed at history file' /tmp/nemoclaw-history-owner-start.log
cat /tmp/nemoclaw-history-owner-start.log`;

  await probe.expect(
    ["run", "-d", "--name", container, "--entrypoint", "/bin/bash", image, "-lc", bootstrap],
    { artifactName: "start-nonroot-history-owner-refusal-container", timeoutMs: RUN_TIMEOUT_MS },
  );
  containers.push(container);
  const wait = await probe.run(["wait", container], {
    artifactName: "wait-nonroot-history-owner-refusal-container",
    timeoutMs: RUN_TIMEOUT_MS,
  });
  expect(wait.exitCode, resultText(wait)).toBe(0);
  expect(wait.stdout.trim(), resultText(wait)).toBe("0");
}

type RootEntrypointTestContext = Pick<
  E2ETargetFixtures,
  "artifacts" | "cleanup" | "progress" | "secrets"
> & {
  signal: AbortSignal;
  skip: (message: string) => void;
};

type RootEntrypointScenario = {
  assertion: string;
  contract: readonly string[];
  id: string;
};

type RootEntrypointVariant = {
  containers: string[];
  image: string;
  probe: DockerProbe;
  runId: string;
};

async function runRootEntrypointScenario(
  context: RootEntrypointTestContext,
  scenario: RootEntrypointScenario,
  runVariant: (variant: RootEntrypointVariant) => Promise<void>,
): Promise<void> {
  const { artifacts, cleanup, progress, secrets, signal, skip } = context;
  const probe = new DockerProbe(
    artifacts,
    (text, extraValues) => secrets.redact(text, extraValues),
    undefined,
    progress,
    signal,
  );
  const containers: string[] = [];

  await artifacts.target.declare({
    id: "hermes-root-entrypoint-smoke",
    scenario: scenario.id,
    boundary: "docker-root-entrypoint",
    image: ROOT_ENTRYPOINT_IMAGE,
    prebuiltImage: Boolean(process.env.NEMOCLAW_HERMES_TEST_IMAGE),
    contract: scenario.contract,
  });
  cleanup.add(`remove Hermes ${scenario.id} containers`, async () => {
    await Promise.all(
      containers.map((container) =>
        probe.run(["rm", "-f", container], {
          artifactName: `cleanup-${container}`,
          timeoutMs: 30_000,
        }),
      ),
    );
  });
  await requireDocker(probe, skip);
  await buildImageIfNeeded(probe, ROOT_ENTRYPOINT_IMAGE, ROOT_ENTRYPOINT_BASE_IMAGE);

  try {
    await runVariant({
      containers,
      image: ROOT_ENTRYPOINT_IMAGE,
      probe,
      runId: ROOT_ENTRYPOINT_RUN_ID,
    });
  } catch (error) {
    for (const container of containers) await dumpContainerDiagnostics(probe, container);
    throw error;
  }

  await artifacts.target.complete({
    id: "hermes-root-entrypoint-smoke",
    scenario: scenario.id,
    image: ROOT_ENTRYPOINT_IMAGE,
    assertions: { [scenario.assertion]: true },
  });
}

test(
  "starts a clean root entrypoint with the required Hermes runtime and image capabilities",
  {
    meta: {
      e2ePhases: [
        "check Docker and prepare the Hermes root-entrypoint image",
        "validate clean Hermes root-entrypoint readiness",
      ],
    },
  },
  async (context) => {
    await runRootEntrypointScenario(
      context,
      {
        id: "clean-startup",
        assertion: "cleanStartupAndImageCapabilitiesVerified",
        contract: [
          "clean root-entrypoint startup reaches Hermes health or bearer-auth readiness",
          "gateway process runs as gateway user and retains the unlocked dispatcher value",
          "gateway log has no PID race or config load failure",
          "Hermes v0.14 writable runtime directories are present",
          "selected Hermes optional capabilities import from the shipped image",
          "the manifest-declared Hermes executable resolves and runs at its final-image path",
          "root retains sandbox supplementary-group membership in the shipped image",
          "build-only upstream tests and root caches are absent from the runtime image",
          "gateway.pid is stored as a regular file below the writable runtime directory",
          "gateway user cannot remove config.yaml from sticky config root",
          "Hermes API denies missing or wrong bearer tokens and accepts API_SERVER_KEY",
          "dashboard profile is sandbox-owned, and its .env allowlist excludes API_SERVER_KEY",
        ],
      },
      async ({ containers, image, probe, runId }) => {
        context.progress.phase("validate clean Hermes root-entrypoint readiness");
        await runCleanVariant(probe, image, runId, containers);
      },
    );
  },
);

test(
  "repairs restored Hermes state and legacy dashboard layout during root startup",
  {
    meta: {
      e2ePhases: [
        "check Docker and prepare the Hermes root-entrypoint image",
        "validate restored Hermes state migration",
      ],
    },
  },
  async (context) => {
    await runRootEntrypointScenario(
      context,
      {
        id: "restored-state-migration",
        assertion: "restoredStateMigrationVerified",
        contract: [
          "legacy gateway.pid symlink and state shape are repaired and booted",
          "restored state directories permit gateway-user and sandbox-user writes",
          "legacy dashboard profile state is moved into profiles/dashboard-home",
        ],
      },
      async ({ containers, image, probe, runId }) => {
        context.progress.phase("validate restored Hermes state migration");
        await runLegacyVariant(probe, image, runId, containers);
      },
    );
  },
);

test(
  "recovers locked-root history without changing sealed Hermes configuration",
  {
    meta: {
      e2ePhases: [
        "check Docker and prepare the Hermes root-entrypoint image",
        "validate locked-root Hermes history recovery",
      ],
    },
  },
  async (context) => {
    await runRootEntrypointScenario(
      context,
      {
        id: "locked-root-history-recovery",
        assertion: "lockedRootHistoryRecoveryVerified",
        contract: [
          "locked-root startup recreates protected group-writable Hermes history without changing sealed config",
          "gateway process forces the embedded kanban dispatcher off while the root is locked",
          "hostile inherited PYTHONPATH cannot execute sitecustomize as root",
        ],
      },
      async ({ containers, image, probe, runId }) => {
        context.progress.phase("validate locked-root Hermes history recovery");
        await runLockedRootVariant(probe, image, runId, containers);
      },
    );
  },
);

test(
  "rejects a history hard link during root startup without changing config.yaml",
  {
    meta: {
      e2ePhases: [
        "check Docker and prepare the Hermes root-entrypoint image",
        "validate root history hard-link refusal",
      ],
    },
  },
  async (context) => {
    await runRootEntrypointScenario(
      context,
      {
        id: "history-hard-link-refusal",
        assertion: "rootHistoryHardLinkRefusalVerified",
        contract: [
          "root startup rejects a history hard link without changing the protected config inode",
        ],
      },
      async ({ containers, image, probe, runId }) => {
        context.progress.phase("validate root history hard-link refusal");
        await runHardLinkRefusalVariant(probe, image, runId, containers, "history");
      },
    );
  },
);

test(
  "rejects a log hard link during root startup without changing config.yaml",
  {
    meta: {
      e2ePhases: [
        "check Docker and prepare the Hermes root-entrypoint image",
        "validate root log hard-link refusal",
      ],
    },
  },
  async (context) => {
    await runRootEntrypointScenario(
      context,
      {
        id: "log-hard-link-refusal",
        assertion: "rootLogHardLinkRefusalVerified",
        contract: [
          "root startup rejects a log hard link without changing the protected config inode",
        ],
      },
      async ({ containers, image, probe, runId }) => {
        context.progress.phase("validate root log hard-link refusal");
        await runHardLinkRefusalVariant(probe, image, runId, containers, "logs");
      },
    );
  },
);

test(
  "rejects a config-root swap during root layout repair without changing the external target",
  {
    meta: {
      e2ePhases: [
        "check Docker and prepare the Hermes root-entrypoint image",
        "validate root config-layout swap refusal",
      ],
    },
  },
  async (context) => {
    await runRootEntrypointScenario(
      context,
      {
        id: "config-root-swap-refusal",
        assertion: "rootMutableLayoutSwapRefusalVerified",
        contract: [
          "root startup rejects a config-root swap after descriptor validation without changing the external target",
        ],
      },
      async ({ containers, image, probe, runId }) => {
        context.progress.phase("validate root config-layout swap refusal");
        await runMutableLayoutSwapRefusalVariant(probe, image, runId, containers);
      },
    );
  },
);

test(
  "rejects non-root startup when the Hermes history group is unusable",
  {
    meta: {
      e2ePhases: [
        "check Docker and prepare the Hermes root-entrypoint image",
        "validate non-root history ownership refusal",
      ],
    },
  },
  async (context) => {
    await runRootEntrypointScenario(
      context,
      {
        id: "non-root-history-owner-refusal",
        assertion: "nonRootHistoryOwnershipRefusalVerified",
        contract: ["non-root startup rejects a mode-correct history file with an unusable group"],
      },
      async ({ containers, image, probe, runId }) => {
        context.progress.phase("validate non-root history ownership refusal");
        await runNonRootHistoryOwnershipRefusalVariant(probe, image, runId, containers);
      },
    );
  },
);
