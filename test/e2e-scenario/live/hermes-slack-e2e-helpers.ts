// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Live Vitest replacement for test/e2e/test-hermes-slack-e2e.sh. */

import { setTimeout as sleep } from "node:timers/promises";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import { type E2EScenarioFixtures, expect } from "../fixtures/e2e-test.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  bestEffort,
  CLI,
  dockerInfo,
  expectExitZero,
  installSandboxOrSkipOnRateLimit,
  phase6Env,
  precleanSandbox,
  resultText,
  sandboxEncodedSh,
  sandboxSh,
  shellQuote,
} from "./phase6-messaging-helpers.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-hermes-slack";
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? "xoxb-test-hermes-slack-token";
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN ?? "xapp-test-hermes-slack-app-token";
export const LIVE_TIMEOUT_MS = 70 * 60_000;
const INSTALL_TIMEOUT_MS = 60 * 60_000;
const HERMES_HEALTH_URL = "http://localhost:8642/health";

function isFakeSlackToken(value: string): boolean {
  return /^(xoxb|xapp)-(fake|test)-/.test(value);
}

function hermesSlackEnv(apiKey?: string): NodeJS.ProcessEnv {
  return phase6Env({
    sandboxName: SANDBOX_NAME,
    agent: "hermes",
    apiKey,
    extra: {
      ...(apiKey ? { COMPATIBLE_API_KEY: apiKey } : {}),
      NEMOCLAW_COMPAT_MODEL: process.env.NEMOCLAW_COMPAT_MODEL ?? "nvidia/nvidia/nemotron-3-ultra",
      NEMOCLAW_E2E_USE_HOSTED_INFERENCE: "1",
      NEMOCLAW_ENDPOINT_URL:
        process.env.NEMOCLAW_ENDPOINT_URL ?? "https://inference-api.nvidia.com/v1",
      NEMOCLAW_MODEL: process.env.NEMOCLAW_MODEL ?? "nvidia/nvidia/nemotron-3-ultra",
      NEMOCLAW_POLICY_TIER: process.env.NEMOCLAW_POLICY_TIER ?? "open",
      NEMOCLAW_PREFERRED_API: process.env.NEMOCLAW_PREFERRED_API ?? "openai-completions",
      NEMOCLAW_PROVIDER: process.env.NEMOCLAW_PROVIDER ?? "custom",
      ...(isFakeSlackToken(SLACK_BOT_TOKEN) || isFakeSlackToken(SLACK_APP_TOKEN)
        ? { NEMOCLAW_SKIP_SLACK_AUTH_VALIDATION: "1" }
        : {}),
      SLACK_APP_TOKEN,
      SLACK_BOT_TOKEN,
    },
  });
}

function redactions(apiKey?: string): string[] {
  return [apiKey, SLACK_BOT_TOKEN, SLACK_APP_TOKEN].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

async function cleanupHermesSlack(options: {
  host: HostCliClient;
  apiKey?: string;
  artifactPrefix: string;
}): Promise<void> {
  const env = hermesSlackEnv(options.apiKey);
  const redactionValues = redactions(options.apiKey);
  await bestEffort(() =>
    options.host.command("node", [CLI, SANDBOX_NAME, "destroy", "--yes"], {
      artifactName: `${options.artifactPrefix}-nemoclaw-destroy`,
      env,
      redactionValues,
      timeoutMs: 15 * 60_000,
    }),
  );
  await bestEffort(() =>
    options.host.command("openshell", ["sandbox", "delete", SANDBOX_NAME], {
      artifactName: `${options.artifactPrefix}-openshell-sandbox-delete`,
      env,
      redactionValues,
      timeoutMs: 120_000,
    }),
  );
  for (const provider of [`${SANDBOX_NAME}-slack-bridge`, `${SANDBOX_NAME}-slack-app`]) {
    await bestEffort(() =>
      options.host.command("openshell", ["provider", "delete", provider], {
        artifactName: `${options.artifactPrefix}-openshell-provider-delete-${provider}`,
        env,
        redactionValues,
        timeoutMs: 60_000,
      }),
    );
  }
  await bestEffort(() =>
    options.host.command("openshell", ["gateway", "destroy", "-g", "nemoclaw"], {
      artifactName: `${options.artifactPrefix}-openshell-gateway-destroy`,
      env,
      redactionValues,
      timeoutMs: 120_000,
    }),
  );
}

async function hostSlackTokenStdin(options: {
  host: HostCliClient;
  apiKey: string;
  artifactName: string;
  remoteCommand: string;
  timeoutMs?: number;
}): Promise<ShellProbeResult> {
  const script = [
    "set -euo pipefail",
    "ssh_config=$(mktemp)",
    "trap 'rm -f \"$ssh_config\"' EXIT",
    `openshell sandbox ssh-config ${shellQuote(SANDBOX_NAME)} >"$ssh_config"`,
    [
      'printf "%s\\n%s\\n" "$SLACK_BOT_TOKEN" "$SLACK_APP_TOKEN"',
      "|",
      "ssh",
      '-F "$ssh_config"',
      "-o StrictHostKeyChecking=no",
      "-o UserKnownHostsFile=/dev/null",
      "-o ConnectTimeout=10",
      "-o LogLevel=ERROR",
      shellQuote(`openshell-${SANDBOX_NAME}`),
      shellQuote(options.remoteCommand),
    ].join(" "),
  ].join("\n");

  return options.host.command("bash", ["-lc", script], {
    artifactName: options.artifactName,
    env: hermesSlackEnv(options.apiKey),
    redactionValues: redactions(options.apiKey),
    timeoutMs: options.timeoutMs ?? 60_000,
  });
}

async function expectProvider(options: {
  host: HostCliClient;
  apiKey: string;
  providerName: string;
  artifactName: string;
}): Promise<void> {
  const result = await options.host.command(
    "openshell",
    ["provider", "get", options.providerName],
    {
      artifactName: options.artifactName,
      env: hermesSlackEnv(options.apiKey),
      redactionValues: redactions(options.apiKey),
      timeoutMs: 60_000,
    },
  );
  expectExitZero(result, `OpenShell provider ${options.providerName}`);
}

async function waitForHermesHealth(options: {
  sandbox: SandboxClient;
  apiKey: string;
}): Promise<ShellProbeResult> {
  let health: ShellProbeResult | undefined;
  for (let attempt = 1; attempt <= 15; attempt += 1) {
    health = await sandboxSh(
      options.sandbox,
      SANDBOX_NAME,
      `curl -sf ${shellQuote(HERMES_HEALTH_URL)}`,
      {
        artifactName: `phase-3-hermes-health-attempt-${attempt}`,
        redactionValues: redactions(options.apiKey),
        timeoutMs: 20_000,
      },
    );
    if (health.exitCode === 0 && /"ok"/i.test(resultText(health))) break;
    await sleep(4_000);
  }
  expect(health, "Hermes health probe did not run").toBeTruthy();
  expectExitZero(health!, "Hermes health probe");
  expect(resultText(health!)).toMatch(/"ok"/i);
  return health!;
}

async function providerExists(options: {
  host: HostCliClient;
  apiKey: string;
  providerName: string;
  artifactName: string;
}): Promise<boolean> {
  const result = await options.host.command(
    "openshell",
    ["provider", "get", options.providerName],
    {
      artifactName: options.artifactName,
      env: hermesSlackEnv(options.apiKey),
      redactionValues: redactions(options.apiKey),
      timeoutMs: 60_000,
    },
  );
  return result.exitCode === 0;
}

type HermesSlackE2EFixtures = E2EScenarioFixtures & {
  skip: (note?: string) => never;
};

export async function runHermesSlackE2E({
  artifacts,
  cleanup,
  host,
  sandbox,
  secrets,
  skip,
}: HermesSlackE2EFixtures): Promise<void> {
  const apiKey = secrets.required("NVIDIA_INFERENCE_API_KEY");
  const env = hermesSlackEnv(apiKey);
  const redactionValues = redactions(apiKey);

  cleanup.add(`destroy Hermes Slack sandbox ${SANDBOX_NAME}`, async () => {
    await cleanupHermesSlack({ host, apiKey, artifactPrefix: "cleanup-hermes-slack" });
  });

  await artifacts.writeJson("scenario.json", {
    id: "hermes-slack-e2e",
    runner: "vitest",
    migratedFrom: "test/e2e/test-hermes-slack-e2e.sh",
    boundary: "bash install.sh --non-interactive + Hermes Slack sandbox runtime",
    sandboxName: SANDBOX_NAME,
    providerNames: [`${SANDBOX_NAME}-slack-bridge`, `${SANDBOX_NAME}-slack-app`],
  });

  const docker = await dockerInfo(host, env);
  if (docker.exitCode !== 0) {
    if (process.env.GITHUB_ACTIONS === "true") {
      throw new Error(`Docker is required for Hermes Slack E2E: ${resultText(docker)}`);
    }
    skip("Docker is required for Hermes Slack E2E");
    return;
  }

  await cleanupHermesSlack({ host, apiKey, artifactPrefix: "preclean-hermes-slack" });
  await precleanSandbox(host, SANDBOX_NAME, env, redactionValues, "preclean-hermes-slack-cli");

  const install = await installSandboxOrSkipOnRateLimit(
    host,
    env,
    redactionValues,
    "phase-1-install-hermes-slack",
    skip,
    "NVIDIA endpoint validation was rate-limited before Hermes Slack assertions ran",
  );
  expectExitZero(install, "install.sh --non-interactive for Hermes Slack");

  const cliProbe = await host.command(
    "bash",
    ["-lc", "command -v nemoclaw && command -v openshell && openshell --version"],
    {
      artifactName: "phase-1-cli-probe-hermes-slack",
      env,
      redactionValues,
      timeoutMs: 60_000,
    },
  );
  expectExitZero(cliProbe, "NemoClaw and OpenShell installed by install.sh");
  expect(resultText(cliProbe)).toContain("nemoclaw");
  expect(resultText(cliProbe)).toContain("openshell");

  const list = await host.command("node", [CLI, "list"], {
    artifactName: "phase-2-nemoclaw-list-hermes-slack",
    env,
    redactionValues,
    timeoutMs: 60_000,
  });
  expectExitZero(list, "nemoclaw list");
  expect(resultText(list)).toContain(SANDBOX_NAME);

  await expectProvider({
    host,
    apiKey,
    providerName: `${SANDBOX_NAME}-slack-bridge`,
    artifactName: "phase-2-provider-slack-bridge",
  });
  await expectProvider({
    host,
    apiKey,
    providerName: `${SANDBOX_NAME}-slack-app`,
    artifactName: "phase-2-provider-slack-app",
  });

  await waitForHermesHealth({ sandbox, apiKey });

  const configProbe = await sandboxEncodedSh(
    sandbox,
    SANDBOX_NAME,
    String.raw`python3 - <<'PY'
import sys
from pathlib import Path
try:
    import yaml
except Exception as exc:
    print(f"FAIL cannot import yaml: {exc}")
    sys.exit(0)

config_text = Path("/sandbox/.hermes/config.yaml").read_text(encoding="utf-8")
cfg = yaml.safe_load(config_text) or {}
errors = []
platforms = cfg.get("platforms")
if not isinstance(platforms, dict):
    errors.append("platforms map missing or not a mapping")
else:
    slack = platforms.get("slack")
    if not isinstance(slack, dict):
        errors.append("platforms.slack missing or not a mapping")
    elif slack.get("enabled") is not True:
        errors.append(f"platforms.slack.enabled is not true ({slack!r})")
if "SLACK_BOT_TOKEN" in config_text or "SLACK_APP_TOKEN" in config_text:
    errors.append("config.yaml contains Slack token env keys")
if errors:
    print("FAIL " + "; ".join(errors))
else:
    print("OK")
PY`,
    [],
    {
      artifactName: "phase-4-config-shape",
      redactionValues,
      timeoutMs: 60_000,
    },
  );
  expectExitZero(configProbe, "Hermes Slack config shape probe");
  expect(configProbe.stdout.trim()).toBe("OK");

  const envProbe = await sandboxEncodedSh(
    sandbox,
    SANDBOX_NAME,
    String.raw`python3 - <<'PY'
from pathlib import Path
text = Path("/sandbox/.hermes/.env").read_text(encoding="utf-8")
lines = set(text.splitlines())
required = {
    "SLACK_BOT_TOKEN=xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
    "SLACK_APP_TOKEN=xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN",
    "API_SERVER_PORT=18642",
}
missing = sorted(required - lines)
if missing:
    print("FAIL missing " + ", ".join(missing))
else:
    print("OK")
PY`,
    [],
    {
      artifactName: "phase-4-env-placeholders",
      redactionValues,
      timeoutMs: 60_000,
    },
  );
  expectExitZero(envProbe, "Hermes Slack .env placeholder probe");
  expect(envProbe.stdout.trim()).toBe("OK");

  const secretBoundaryProbe = await sandboxEncodedSh(
    sandbox,
    SANDBOX_NAME,
    String.raw`python3 - <<'PY'
import re
from pathlib import Path

secret_key_re = re.compile(r"(^|_)(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|API)(_|$)")
slack_alias_re = re.compile(r"^(xoxb|xapp)-OPENSHELL-RESOLVE-ENV-[A-Z0-9_]+$")
allowed_nonsecret_keys = {"API_SERVER_HOST", "API_SERVER_PORT"}
allowed_raw_secret_keys = {"API_SERVER_KEY"}
allowed_literals = {"", "[STRIPPED_BY_MIGRATION]"}
env_path = Path("/sandbox/.hermes/.env")

def unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        return value[1:-1]
    return value

if env_path.is_symlink():
    print("FAIL .hermes/.env is a symlink")
    raise SystemExit
if not env_path.is_file():
    print("FAIL .hermes/.env missing")
    raise SystemExit

violations = []
for lineno, raw_line in enumerate(env_path.read_text(encoding="utf-8").splitlines(), 1):
    stripped = raw_line.strip()
    if not stripped or stripped.startswith("#") or "=" not in stripped:
        continue
    if stripped.startswith("export "):
        stripped = stripped[len("export ") :].lstrip()
    key, value = stripped.split("=", 1)
    key = key.strip()
    if key in allowed_nonsecret_keys:
        continue
    if key in allowed_raw_secret_keys:
        continue
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
        continue
    if not secret_key_re.search(key):
        continue
    value = unquote(value)
    if value in allowed_literals or value.startswith("openshell:resolve:env:") or slack_alias_re.fullmatch(value):
        continue
    violations.append(f"{key} line {lineno}")

if violations:
    print("FAIL raw secret-shaped Hermes .env values: " + ", ".join(violations))
else:
    print("OK")
PY`,
    [],
    {
      artifactName: "phase-4-secret-boundary",
      redactionValues,
      timeoutMs: 60_000,
    },
  );
  expectExitZero(secretBoundaryProbe, "Hermes Slack secret-boundary scan");
  expect(secretBoundaryProbe.stdout.trim()).toBe("OK");

  const tokenFileHits = await hostSlackTokenStdin({
    host,
    apiKey,
    artifactName: "phase-4-token-file-hits",
    remoteCommand:
      "grep -Fq -f - /sandbox/.hermes/config.yaml /sandbox/.hermes/.env /tmp/nemoclaw-start.log /tmp/gateway.log 2>/dev/null && echo LEAK || echo OK",
  });
  expectExitZero(tokenFileHits, "raw Slack token file/log scan");
  expect(tokenFileHits.stdout.trim()).toBe("OK");

  const processScan = await hostSlackTokenStdin({
    host,
    apiKey,
    artifactName: "phase-4-token-process-scan",
    remoteCommand: String.raw`python3 -c 'import pathlib, sys
raw_tokens = {line.rstrip("\n") for line in sys.stdin if line.rstrip("\n")}
cmdlines = []
for path in pathlib.Path("/proc").glob("[0-9]*/cmdline"):
    try:
        cmdlines.append(path.read_bytes().replace(b"\0", b"\n").decode("utf-8", "replace"))
    except Exception:
        pass
text = "\n".join(cmdlines)
if not text:
    print("EMPTY")
elif any(token in text for token in raw_tokens):
    print("LEAK")
else:
    print("OK")'`,
  });
  expectExitZero(processScan, "raw Slack token process scan");
  if (processScan.stdout.trim() !== "EMPTY") expect(processScan.stdout.trim()).toBe("OK");

  const policy = await host.command("openshell", ["policy", "get", "--full", SANDBOX_NAME], {
    artifactName: "phase-5-policy-get",
    env,
    redactionValues,
    timeoutMs: 60_000,
  });
  expectExitZero(policy, "openshell policy get --full");
  const policyText = resultText(policy);
  const slackBlockMatch = policyText.match(/^  slack:[\s\S]*?(?=^  [A-Za-z0-9_-]+:|$(?![\s\S]))/m);
  const slackBlock = slackBlockMatch?.[0] ?? "";
  expect(slackBlock, "Sandbox policy missing Slack network policy").not.toBe("");
  expect(slackBlock).toContain("/usr/local/bin/hermes");
  expect(slackBlock).toContain("/usr/bin/python3*");
  expect(slackBlock).toContain("/opt/hermes/.venv/bin/python");
  expect(slackBlock).not.toContain("/usr/local/bin/node");
  expect(slackBlock).not.toContain("/usr/bin/node");
  expect(slackBlock).toContain("wss-primary.slack.com");
  expect(slackBlock).toContain("wss-backup.slack.com");
  expect(slackBlock).toContain("request_body_credential_rewrite: true");

  const bridgeResidue = await sandboxEncodedSh(
    sandbox,
    SANDBOX_NAME,
    String.raw`set +e
decode_needle="$(printf "%s%s%s" "nemoclaw-" "decode" "-proxy")"
preload_needle="$(printf "%s" "/opt/nemoclaw-hermes-discord-preload")"
if env | grep -Fq "$preload_needle"; then echo ENV_PYTHON_PRELOAD; fi
if grep -Fq "$preload_needle" /tmp/nemoclaw-proxy-env.sh /sandbox/.hermes/.env /sandbox/.hermes/config.yaml 2>/dev/null; then echo FILE_PYTHON_PRELOAD; fi
if command -v "$decode_needle" >/dev/null 2>&1; then echo BIN_DECODE_PROXY; fi
current_pid="$$"
for p in /proc/[0-9]*; do
  pid=$(basename "$p")
  [ "$pid" = "$current_pid" ] && continue
  cmd=$(tr "\000" " " < "$p/cmdline" 2>/dev/null || true)
  case "$cmd" in *"$decode_needle"*) echo PROCESS_DECODE_PROXY ;; esac
done`,
    [],
    {
      artifactName: "phase-5-bridge-residue",
      redactionValues,
      timeoutMs: 60_000,
    },
  );
  expectExitZero(bridgeResidue, "Hermes Slack bridge residue probe");
  expect(resultText(bridgeResidue).trim()).toBe("");

  const slackProbe = await sandboxEncodedSh(
    sandbox,
    SANDBOX_NAME,
    String.raw`sh -lc '. /tmp/nemoclaw-proxy-env.sh 2>/dev/null || true; if [ -x /opt/hermes/.venv/bin/python ]; then exec /opt/hermes/.venv/bin/python -; fi; exec python3 -' <<'PY'
import json
import http.client
import socket
import ssl
import sys
import urllib.error
import urllib.request

TLS_CONTEXT = ssl._create_unverified_context()

def call(label, path, env_key, allowed_errors):
    prefix = {
        "SLACK_BOT_TOKEN": "xoxb",
        "SLACK_APP_TOKEN": "xapp",
    }[env_key]
    token = f"{prefix}-OPENSHELL-RESOLVE-ENV-{env_key}"
    req = urllib.request.Request(
        f"https://slack.com/api/{path}",
        data=b"",
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30, context=TLS_CONTEXT) as resp:
            status = resp.status
            body = resp.read().decode("utf-8", errors="replace")
    except socket.timeout:
        print(f"TIMEOUT {label}")
        return False
    except urllib.error.URLError as exc:
        reason = str(getattr(exc, "reason", exc))
        if "timed out" in reason.lower():
            print(f"TIMEOUT {label}: {reason}")
            return False
        print(f"ERROR {label}: {reason}")
        return False
    except Exception as exc:
        reason = f"{type(exc).__name__}: {exc}"
        if isinstance(exc, http.client.RemoteDisconnected) or "timed out" in reason.lower():
            print(f"TIMEOUT {label}: {reason}")
            return False
        print(f"ERROR {label}: {reason}")
        return False

    print(json.dumps({"label": label, "status": status, "body": body[:300]}))
    try:
        parsed = json.loads(body)
    except Exception as exc:
        print(f"FAIL {label}: non-json body {exc}")
        return False
    error = parsed.get("error")
    if status == 200 and (parsed.get("ok") is True or error in allowed_errors):
        print(f"OK {label}: {error or 'ok'}")
        return True
    print(f"FAIL {label}: status={status} error={error!r}")
    return False

ok = True
ok = call("auth.test", "auth.test", "SLACK_BOT_TOKEN", {"invalid_auth", "not_authed"}) and ok
ok = call(
    "apps.connections.open",
    "apps.connections.open",
    "SLACK_APP_TOKEN",
    {"invalid_auth", "not_authed", "not_allowed_token_type"},
) and ok
sys.exit(0 if ok else 2)
PY`,
    [],
    {
      artifactName: "phase-6-slack-python-probe",
      redactionValues,
      timeoutMs: 120_000,
    },
  );
  const slackProbeText = resultText(slackProbe);
  await artifacts.writeText("phase-6-slack-python-probe.txt", slackProbeText);
  if (/^TIMEOUT/m.test(slackProbeText)) {
    skip("Slack API timed out");
    return;
  }
  expectExitZero(slackProbe, "Slack Python API probe");
  expect(slackProbeText).toMatch(/^OK auth\.test:/m);
  expect(slackProbeText).toMatch(/^OK apps\.connections\.open:/m);
  expect(slackProbeText).not.toMatch(/^(FAIL|ERROR)/m);

  if (process.env.NEMOCLAW_E2E_KEEP_SANDBOX !== "1") {
    const destroy = await host.command("node", [CLI, SANDBOX_NAME, "destroy", "--yes"], {
      artifactName: "phase-7-nemoclaw-destroy",
      env,
      redactionValues,
      timeoutMs: 15 * 60_000,
    });
    expectExitZero(destroy, "nemoclaw destroy Hermes Slack sandbox");
    await bestEffort(() =>
      host.command("openshell", ["gateway", "destroy", "-g", "nemoclaw"], {
        artifactName: "phase-7-openshell-gateway-destroy",
        env,
        redactionValues,
        timeoutMs: 120_000,
      }),
    );

    const registryProbe = await host.command(
      "bash",
      [
        "-lc",
        'test ! -f "$HOME/.nemoclaw/sandboxes.json" || ! grep -Fq "\\\"${SANDBOX_NAME}\\\"" "$HOME/.nemoclaw/sandboxes.json"',
      ],
      {
        artifactName: "phase-7-registry-removed",
        env,
        redactionValues,
        timeoutMs: 30_000,
      },
    );
    expectExitZero(registryProbe, `Sandbox ${SANDBOX_NAME} removed from registry`);

    for (const providerName of [`${SANDBOX_NAME}-slack-app`, `${SANDBOX_NAME}-slack-bridge`]) {
      expect(
        await providerExists({
          host,
          apiKey,
          providerName,
          artifactName: `phase-7-provider-removed-${providerName}`,
        }),
        `${providerName} still exists after destroy`,
      ).toBe(false);
    }
  }

  await artifacts.writeJson("scenario-result.json", {
    id: "hermes-slack-e2e",
    assertions: {
      installerAndCliAvailable: true,
      slackProvidersCreated: true,
      hermesHealthOk: true,
      hermesSlackConfigShape: true,
      resolverPlaceholders: true,
      rawTokensAbsentFromFilesLogsAndProcesses: true,
      hermesScopedSlackPolicy: true,
      noLegacyDecodeBridgeResidue: true,
      slackPythonAliasEgress: true,
      cleanupVerified: process.env.NEMOCLAW_E2E_KEEP_SANDBOX !== "1",
    },
  });
}
