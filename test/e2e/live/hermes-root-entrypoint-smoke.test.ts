// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { setTimeout as delay } from "node:timers/promises";

import { type DockerCommandResult, DockerProbe, resultText } from "../fixtures/docker-probe.ts";
import { expect, test } from "../fixtures/e2e-test.ts";

// real Docker/root-entrypoint smoke: it builds the Hermes image when no prebuilt
// NEMOCLAW_HERMES_TEST_IMAGE is supplied, starts /usr/local/bin/nemoclaw-start
// as root, and verifies health, gateway privilege separation, runtime layout,
// sticky config protection, and legacy gateway.pid symlink migration.

const HEALTH_ATTEMPTS = 90;
const HEALTH_POLL_MS = 2_000;
const BUILD_TIMEOUT_MS = 10 * 60_000;
const RUN_TIMEOUT_MS = 60_000;

function safeTag(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "local";
}

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
    'gosu gateway sh -lc \'for dir in hooks image_cache audio_cache logs/curator; do p="/sandbox/.hermes/$dir/.nemoclaw-write-test"; : >"$p" && rm -f "$p"; done\'',
  );
  await expectContainerSh(
    probe,
    container,
    "gateway.pid is not a regular top-level file",
    "test -f /sandbox/.hermes/gateway.pid && test ! -L /sandbox/.hermes/gateway.pid",
  );
  await expectContainerShFails(
    probe,
    container,
    "gateway user was able to remove config.yaml",
    "gosu gateway rm /sandbox/.hermes/config.yaml",
  );
  await expectContainerSh(
    probe,
    container,
    "config.yaml disappeared after gateway remove attempt",
    "test -f /sandbox/.hermes/config.yaml",
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
    "Hermes dashboard-home was not seeded with sandbox-owned 0700/0600 allowlisted config",
    String.raw`
set -eu
for _ in $(seq 1 30); do
  [ -f /sandbox/.hermes/dashboard-home/config.yaml ] && [ -f /sandbox/.hermes/dashboard-home/.env ] && break
  sleep 1
done
[ "$(stat -c '%a' /sandbox/.hermes/dashboard-home)" = "700" ]
[ "$(stat -c '%U:%G' /sandbox/.hermes/dashboard-home)" = "sandbox:sandbox" ]
[ "$(stat -c '%a' /sandbox/.hermes/dashboard-home/config.yaml)" = "600" ]
[ "$(stat -c '%a' /sandbox/.hermes/dashboard-home/.env)" = "600" ]
[ "$(stat -c '%U:%G' /sandbox/.hermes/dashboard-home/config.yaml)" = "sandbox:sandbox" ]
[ "$(stat -c '%U:%G' /sandbox/.hermes/dashboard-home/.env)" = "sandbox:sandbox" ]
python3 - <<'PY'
from pathlib import Path

allowed = {
    "API_SERVER_HOST",
    "API_SERVER_PORT",
    "API_SERVER_KEY",
    "NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER",
    "FIRECRAWL_GATEWAY_URL",
    "OPENAI_AUDIO_GATEWAY_URL",
    "BROWSER_USE_GATEWAY_URL",
    "FAL_QUEUE_GATEWAY_URL",
    "MODAL_GATEWAY_URL",
}
env_path = Path("/sandbox/.hermes/dashboard-home/.env")
keys = set()
for raw_line in env_path.read_text(encoding="utf-8").splitlines():
    line = raw_line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    if line.startswith("export "):
        line = line[len("export "):].lstrip()
    keys.add(line.split("=", 1)[0].strip())
extra = sorted(keys - allowed)
missing = sorted({"API_SERVER_HOST", "API_SERVER_PORT", "API_SERVER_KEY"} - keys)
if extra or missing:
    raise SystemExit(f"dashboard .env allowlist mismatch extra={extra} missing={missing}")
config_text = Path("/sandbox/.hermes/dashboard-home/config.yaml").read_text(encoding="utf-8")
for fragment in ("model:", "custom_providers:", "_nemoclaw_upstream:"):
    if fragment not in config_text:
        raise SystemExit(f"dashboard config missing {fragment}")
PY
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

async function runCleanVariant(
  probe: DockerProbe,
  image: string,
  runId: string,
  containers: string[],
): Promise<void> {
  const container = `nemoclaw-hermes-root-clean-${runId}`;
  await probe.expect(["run", "-d", "--name", container, image, "/usr/local/bin/nemoclaw-start"], {
    artifactName: "start-clean-root-entrypoint-container",
    timeoutMs: RUN_TIMEOUT_MS,
  });
  containers.push(container);

  await waitForHealth(probe, container);
  await assertGatewayProcess(probe, container);
  await assertGatewayLogClean(probe, container);
  await assertRuntimeLayout(probe, container);
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
chmod 750 /sandbox/.hermes
rm -rf /sandbox/.hermes/hooks /sandbox/.hermes/image_cache /sandbox/.hermes/audio_cache /sandbox/.hermes/logs/curator
exec /usr/local/bin/nemoclaw-start /usr/local/bin/nemoclaw-start`;

  await probe.expect(
    ["run", "-d", "--name", container, "--entrypoint", "/bin/bash", image, "-lc", legacyBootstrap],
    { artifactName: "start-legacy-layout-root-entrypoint-container", timeoutMs: RUN_TIMEOUT_MS },
  );
  containers.push(container);

  await waitForHealth(probe, container);
  await assertGatewayProcess(probe, container);
  await assertGatewayLogClean(probe, container);
  await assertRuntimeLayout(probe, container);
  await expectContainerSh(
    probe,
    container,
    "legacy gateway.pid symlink migration was not logged",
    "grep -F 'Removing unsafe stale Hermes legacy PID file symlink' /tmp/nemoclaw-start.log",
  );
}

test("hermes root-entrypoint smoke preserves runtime layout and legacy pid migration", async ({
  artifacts,
  cleanup,
  secrets,
  skip,
}) => {
  const probe = new DockerProbe(artifacts, (text, extraValues) =>
    secrets.redact(text, extraValues),
  );
  const runId = safeTag(`${process.env.GITHUB_RUN_ID ?? "local"}-${process.pid}-${Date.now()}`);
  const image =
    process.env.NEMOCLAW_HERMES_TEST_IMAGE ?? `nemoclaw-hermes-root-entrypoint-smoke:${runId}`;
  const baseImage = `nemoclaw-hermes-sandbox-base-local:root-entrypoint-${runId}`;
  const containers: string[] = [];

  await artifacts.target.declare({
    id: "hermes-root-entrypoint-smoke",
    boundary: "docker-root-entrypoint",
    image,
    prebuiltImage: Boolean(process.env.NEMOCLAW_HERMES_TEST_IMAGE),
    contract: [
      "clean root-entrypoint startup reaches Hermes health or bearer-auth readiness",
      "gateway process runs as gateway user",
      "gateway log has no PID race or config load failure",
      "Hermes v0.14 writable runtime directories are present",
      "gateway.pid is migrated to a regular top-level file",
      "gateway user cannot remove config.yaml from sticky config root",
      "Hermes API denies missing/wrong bearer tokens and accepts API_SERVER_KEY",
      "dashboard-home is sandbox-owned 0700 with 0600 allowlisted config/env",
      "legacy gateway.pid symlink/state shape is repaired and booted",
    ],
  });

  cleanup.add("remove Hermes root-entrypoint smoke containers", async () => {
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

  try {
    await buildImageIfNeeded(probe, image, baseImage);
    await runCleanVariant(probe, image, runId, containers);
    await runLegacyVariant(probe, image, runId, containers);
  } catch (error) {
    for (const container of containers) {
      await dumpContainerDiagnostics(probe, container);
    }
    throw error;
  }

  await artifacts.target.complete({
    id: "hermes-root-entrypoint-smoke",
    image,
    assertions: {
      cleanStartupHealthy: true,
      legacyStartupHealthy: true,
      runtimeLayoutVerified: true,
      gatewayPrivilegeSeparationVerified: true,
      bearerAuthVerified: true,
      dashboardHomeVerified: true,
      legacyPidSymlinkMigrationVerified: true,
    },
  });
});
