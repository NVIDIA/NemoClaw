// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";

import { type DockerCommandResult, DockerProbe, resultText } from "../fixtures/docker-probe.ts";
import { expect, test } from "../fixtures/e2e-test.ts";

// Migrated from test/e2e/test-hermes-sandbox-secret-boundary.sh. This remains
// a real Docker/image-boundary smoke: it builds the Hermes sandbox images when
// prebuilt image env vars are absent, inspects /sandbox/.hermes inside the
// images, and executes /usr/local/bin/nemoclaw-start to prove raw secret-shaped
// config/process env is rejected without echoing values.

const BUILD_TIMEOUT_MS = 10 * 60_000;
const RUN_TIMEOUT_MS = 60_000;
const RAW_SECRET_SENTINEL = "SENTINEL_RAW_SECRET_VALUE";
const RAW_REFRESH_TOKEN = "raw-refresh-token";

const liveTest = process.env.NEMOCLAW_RUN_E2E_SCENARIOS === "1" ? test : test.skip;

const IMAGE_INSPECTION_SCRIPT = String.raw`
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

secret_key_re = re.compile(r"(^|_)(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|API)(_|$)")
slack_alias_re = re.compile(r"^(xoxb|xapp)-OPENSHELL-RESOLVE-ENV-[A-Z0-9_]+$")
allowed_nonsecret_keys = {"API_SERVER_HOST", "API_SERVER_PORT"}
allowed_raw_secret_keys = set()
allowed_literals = {"", "[STRIPPED_BY_MIGRATION]"}
required_remote_toolsets = {
    "web",
    "browser",
    "terminal",
    "file",
    "code_execution",
    "vision",
    "image_gen",
    "skills",
    "todo",
    "memory",
    "session_search",
    "delegation",
    "cronjob",
    "nemoclaw",
    "audio",
}


def unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        return value[1:-1]
    return value


def env_violations(path: Path) -> list[str]:
    violations: list[str] = []
    for lineno, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        if stripped.startswith("export "):
            stripped = stripped[len("export ") :].lstrip()
        key, value = stripped.split("=", 1)
        key = key.strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            continue
        if key in allowed_nonsecret_keys:
            continue
        if key in allowed_raw_secret_keys:
            continue
        if not secret_key_re.search(key):
            continue
        value = unquote(value)
        if (
            value in allowed_literals
            or value.startswith("openshell:resolve:env:")
            or slack_alias_re.fullmatch(value)
        ):
            continue
        violations.append(f"{key} line {lineno}")
    return violations


def parse_platform_toolsets(text: str) -> dict[str, list[str]]:
    toolsets: dict[str, list[str]] = {}
    in_block = False
    block_indent = 0
    current: str | None = None
    for raw_line in text.splitlines():
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(raw_line) - len(raw_line.lstrip(" "))
        if stripped == "platform_toolsets:":
            in_block = True
            block_indent = indent
            continue
        if not in_block:
            continue
        if indent <= block_indent and not stripped.startswith("- "):
            break
        key_match = re.fullmatch(r"([A-Za-z0-9_-]+):(?:\s*\[\])?", stripped)
        if key_match:
            current = key_match.group(1)
            toolsets[current] = []
            continue
        if stripped.startswith("- ") and current:
            toolsets[current].append(unquote(stripped[2:]))
    return toolsets


env_path = Path("/sandbox/.hermes/.env")
config_path = Path("/sandbox/.hermes/config.yaml")
if env_path.is_symlink():
    print(f"{env_path} is a symlink", file=sys.stderr)
    sys.exit(1)
if not env_path.is_file():
    print(f"{env_path} missing", file=sys.stderr)
    sys.exit(1)
if not config_path.is_file():
    print(f"{config_path} missing", file=sys.stderr)
    sys.exit(1)
if "API_SERVER_KEY=" in env_path.read_text(encoding="utf-8"):
    print("API_SERVER_KEY must be minted at sandbox startup, not baked into the image", file=sys.stderr)
    sys.exit(1)

violations = env_violations(env_path)
if violations:
    print("raw secret-shaped Hermes .env values:", ", ".join(violations), file=sys.stderr)
    sys.exit(1)

toolsets = parse_platform_toolsets(config_path.read_text(encoding="utf-8"))
api_server_toolsets = set(toolsets.get("api_server", []))
if not api_server_toolsets:
    print("platform_toolsets.api_server missing", file=sys.stderr)
    sys.exit(1)
missing = sorted(required_remote_toolsets - api_server_toolsets)
if missing:
    print(f"platform_toolsets.api_server missing expected Hermes toolsets: {missing}", file=sys.stderr)
    sys.exit(1)
if "no_mcp" in api_server_toolsets:
    print("platform_toolsets.api_server unexpectedly disables default MCP servers with no_mcp", file=sys.stderr)
    sys.exit(1)

multipart = subprocess.run(
    ["/opt/hermes/.venv/bin/python", "-c", "import multipart; print(multipart.__version__)"],
    text=True,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    timeout=15,
)
if multipart.returncode != 0:
    print("python-multipart import failed: " + multipart.stderr[-300:], file=sys.stderr)
    sys.exit(1)

for tool in ("gcc", "g++", "make"):
    if shutil.which(tool):
        print(f"{tool} survived Hermes runtime image purge", file=sys.stderr)
        sys.exit(1)

master, slave = os.openpty()
try:
    if not os.ttyname(slave).startswith("/dev/pts/"):
        print("openpty did not allocate from /dev/pts", file=sys.stderr)
        sys.exit(1)
finally:
    os.close(master)
    os.close(slave)
`;

const MANAGED_TOOL_INSPECTION_SCRIPT = String.raw`
import re
import sys
from pathlib import Path

secret_key_re = re.compile(r"(^|_)(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|API)(_|$)")
slack_alias_re = re.compile(r"^(xoxb|xapp)-OPENSHELL-RESOLVE-ENV-[A-Z0-9_]+$")
allowed_nonsecret_keys = {"API_SERVER_HOST", "API_SERVER_PORT"}
allowed_raw_secret_keys = {"API_SERVER_KEY"}
allowed_literals = {"", "[STRIPPED_BY_MIGRATION]"}
required_env_lines = {
    "NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER=1",
    "FIRECRAWL_GATEWAY_URL=http://host.openshell.internal:11436/firecrawl",
    "OPENAI_AUDIO_GATEWAY_URL=http://host.openshell.internal:11436/openai-audio",
    "BROWSER_USE_GATEWAY_URL=http://host.openshell.internal:11436/browser-use",
    "FAL_QUEUE_GATEWAY_URL=http://host.openshell.internal:11436/fal-queue",
    "MODAL_GATEWAY_URL=http://host.openshell.internal:11436/modal",
}
required_config_fragments = [
    "backend: firecrawl",
    "provider: openai",
    "cloud_provider: browser-use",
    "image_gen:",
    "backend: modal",
    "modal_mode: managed",
    "tts:",
]


def unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        return value[1:-1]
    return value


def env_violations(path: Path) -> list[str]:
    violations: list[str] = []
    for lineno, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
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
        if (
            value in allowed_literals
            or value.startswith("openshell:resolve:env:")
            or slack_alias_re.fullmatch(value)
        ):
            continue
        violations.append(f"{key} line {lineno}")
    return violations


env_path = Path("/sandbox/.hermes/.env")
config_path = Path("/sandbox/.hermes/config.yaml")
if not env_path.is_file() or env_path.is_symlink():
    print(f"{env_path} missing, not a file, or unsafe symlink", file=sys.stderr)
    sys.exit(1)
if not config_path.is_file():
    print(f"{config_path} missing", file=sys.stderr)
    sys.exit(1)

env_text = env_path.read_text(encoding="utf-8")
config_text = config_path.read_text(encoding="utf-8")
env_lines = set(env_text.splitlines())
violations = env_violations(env_path)
if violations:
    print("raw secret-shaped managed-tool .env values:", ", ".join(violations), file=sys.stderr)
    sys.exit(1)

missing_env = sorted(required_env_lines - env_lines)
missing_config = [fragment for fragment in required_config_fragments if fragment not in config_text]
for forbidden in (
    "TOOL_GATEWAY_USER_TOKEN",
    "NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN=",
    "raw-refresh-token",
):
    if forbidden in env_text or forbidden in config_text:
        print(f"managed-tool sandbox config contains forbidden token surface: {forbidden}", file=sys.stderr)
        sys.exit(1)

if missing_env:
    print("managed-tool .env missing expected gateway lines: " + ", ".join(missing_env), file=sys.stderr)
    sys.exit(1)
if missing_config:
    print("managed-tool config.yaml missing expected fragments: " + ", ".join(missing_config), file=sys.stderr)
    sys.exit(1)
	`;

const RUNTIME_API_KEY_PROBE_SCRIPT = String.raw`
	set -euo pipefail
	if ! /usr/local/bin/nemoclaw-start true >/tmp/nemoclaw-start-api-key-probe.log 2>&1; then
	  cat /tmp/nemoclaw-start-api-key-probe.log >&2
	  exit 1
	fi
	python3 - <<'PY'
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

env_path = Path("/sandbox/.hermes/.env")
values = []
for raw_line in env_path.read_text(encoding="utf-8").splitlines():
    line = raw_line.strip()
    if line.startswith("export "):
        line = line[len("export ") :].lstrip()
    if line.startswith("API_SERVER_KEY="):
        value = line.split("=", 1)[1].strip().strip("\"'")
        values.append(value)

if len(values) != 1:
    print(f"expected exactly one API_SERVER_KEY, found {len(values)}", file=sys.stderr)
    sys.exit(1)

token = values[0]
strict_hash_ok = subprocess.call(
    ["sha256sum", "-c", "/etc/nemoclaw/hermes.config-hash", "--status"],
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
) == 0
compat_hash_ok = subprocess.call(
    ["sha256sum", "-c", "/sandbox/.hermes/.config-hash", "--status"],
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
) == 0

print(json.dumps({
    "key_hash": hashlib.sha256(token.encode("utf-8")).hexdigest(),
    "key_hex": bool(re.fullmatch(r"[0-9a-f]{64}", token)),
    "key_len": len(token),
    "strict_hash_ok": strict_hash_ok,
    "compat_hash_ok": compat_hash_ok,
}, sort_keys=True))
PY
	`;

function safeTag(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "local";
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function safeArtifactPart(value: string): string {
  return value.toLowerCase().replaceAll("_", "-");
}

function managedPresetsBase64(): string {
  return Buffer.from(
    JSON.stringify(["nous-web", "nous-audio", "nous-browser", "nous-image", "nous-code"]),
  ).toString("base64");
}

function throwDockerRequired(result: DockerCommandResult): never {
  throw new Error(`Docker is required for Hermes sandbox secret-boundary:\n${resultText(result)}`);
}

async function requireDocker(probe: DockerProbe, skip: (message: string) => void): Promise<void> {
  const result = await probe.run(["info"], { artifactName: "docker-info", timeoutMs: 30_000 });
  result.exitCode === 0
    ? undefined
    : process.env.GITHUB_ACTIONS === "true"
      ? throwDockerRequired(result)
      : skip("Docker daemon is required for Hermes sandbox secret-boundary");
}

function inspectPrebuiltImage(probe: DockerProbe, image: string): Promise<false> {
  return probe
    .expect(["image", "inspect", image], {
      artifactName: "inspect-prebuilt-hermes-image",
      timeoutMs: 30_000,
    })
    .then(() => false);
}

async function buildBaseImageWhenNeeded(
  probe: DockerProbe,
  baseImage: string,
  baseImageFromEnv: boolean,
  artifactName: string,
): Promise<void> {
  await (baseImageFromEnv
    ? Promise.resolve()
    : probe.expect(["build", "-f", "agents/hermes/Dockerfile.base", "-t", baseImage, "."], {
        artifactName,
        timeoutMs: BUILD_TIMEOUT_MS,
      }));
}

async function buildHermesProductionImage(
  probe: DockerProbe,
  image: string,
  baseImage: string,
): Promise<true> {
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
  return true;
}

async function buildHermesImageIfNeeded(
  probe: DockerProbe,
  image: string,
  baseImage: string,
  baseImageFromEnv: boolean,
): Promise<boolean> {
  return process.env.NEMOCLAW_HERMES_TEST_IMAGE
    ? inspectPrebuiltImage(probe, image)
    : (await buildBaseImageWhenNeeded(
        probe,
        baseImage,
        baseImageFromEnv,
        "build-hermes-base-image",
      ),
      buildHermesProductionImage(probe, image, baseImage));
}

function inspectPrebuiltManagedImage(probe: DockerProbe, managedImage: string): Promise<false> {
  return probe
    .expect(["image", "inspect", managedImage], {
      artifactName: "inspect-prebuilt-managed-hermes-image",
      timeoutMs: 30_000,
    })
    .then(() => false);
}

async function buildManagedBaseImageWhenNeeded(
  probe: DockerProbe,
  baseImage: string,
  baseImageFromEnv: boolean,
): Promise<void> {
  const baseExists = await probe.run(["image", "inspect", baseImage], {
    artifactName: "inspect-managed-base-image",
    timeoutMs: 30_000,
  });
  await (baseImageFromEnv || baseExists.exitCode === 0
    ? Promise.resolve()
    : probe.expect(["build", "-f", "agents/hermes/Dockerfile.base", "-t", baseImage, "."], {
        artifactName: "build-managed-hermes-base-image",
        timeoutMs: BUILD_TIMEOUT_MS,
      }));
}

async function buildManagedProductionImage(
  probe: DockerProbe,
  managedImage: string,
  baseImage: string,
): Promise<true> {
  await probe.expect(
    [
      "build",
      "-f",
      "agents/hermes/Dockerfile",
      "--build-arg",
      `BASE_IMAGE=${baseImage}`,
      "--build-arg",
      "NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER=1",
      "--build-arg",
      `NEMOCLAW_HERMES_TOOL_GATEWAY_PRESETS_B64=${managedPresetsBase64()}`,
      "-t",
      managedImage,
      ".",
    ],
    { artifactName: "build-managed-hermes-production-image", timeoutMs: BUILD_TIMEOUT_MS },
  );
  return true;
}

async function buildManagedImageIfNeeded(
  probe: DockerProbe,
  managedImage: string,
  baseImage: string,
  baseImageFromEnv: boolean,
): Promise<boolean> {
  return process.env.NEMOCLAW_HERMES_MANAGED_TEST_IMAGE
    ? inspectPrebuiltManagedImage(probe, managedImage)
    : (await buildManagedBaseImageWhenNeeded(probe, baseImage, baseImageFromEnv),
      buildManagedProductionImage(probe, managedImage, baseImage));
}

async function inspectImageBoundary(probe: DockerProbe, image: string): Promise<void> {
  const result = await probe.run(
    ["run", "--rm", "--entrypoint", "python3", image, "-c", IMAGE_INSPECTION_SCRIPT],
    {
      artifactName: "inspect-hermes-sandbox-boundary",
      timeoutMs: RUN_TIMEOUT_MS,
    },
  );

  expect(
    result.exitCode,
    `Hermes image should have no raw external secret-shaped .env values and preserve remote toolsets\n${resultText(result)}`,
  ).toBe(0);
}

async function inspectManagedToolBoundary(probe: DockerProbe, image: string): Promise<void> {
  const result = await probe.run(
    ["run", "--rm", "--entrypoint", "python3", image, "-c", MANAGED_TOOL_INSPECTION_SCRIPT],
    {
      artifactName: "inspect-managed-tool-hermes-boundary",
      timeoutMs: RUN_TIMEOUT_MS,
    },
  );

  expect(
    result.exitCode,
    `Managed-tool Hermes image should keep gateway auth out of sandbox config\n${resultText(result)}`,
  ).toBe(0);
}

function redactExpectedSecret(value: string, text: string): string {
  return text.split(value).join("[REDACTED_TEST_SECRET]");
}

async function runStartupWithEnvFileEntry(
  probe: DockerProbe,
  image: string,
  assignment: string,
  key: string,
  value: string,
): Promise<DockerCommandResult> {
  const script = `set -euo pipefail; printf '%s\n' ${shellQuote(
    assignment,
  )} >> /sandbox/.hermes/.env; exec /usr/local/bin/nemoclaw-start true`;
  return probe.run(
    ["run", "--rm", "--user", "sandbox", "--entrypoint", "/bin/bash", image, "-lc", script],
    {
      artifactName: `startup-rejects-env-file-${safeArtifactPart(key)}`,
      artifactRedactionValues: [value],
      returnRaw: true,
      timeoutMs: RUN_TIMEOUT_MS,
    },
  );
}

async function runStartupWithRuntimeEnvEntry(
  probe: DockerProbe,
  image: string,
  assignment: string,
  key: string,
  value: string,
): Promise<DockerCommandResult> {
  return probe.run(
    [
      "run",
      "--rm",
      "--user",
      "sandbox",
      "--env",
      assignment,
      "--entrypoint",
      "/usr/local/bin/nemoclaw-start",
      image,
      "true",
    ],
    {
      artifactName: `startup-rejects-runtime-env-${safeArtifactPart(key)}`,
      artifactRedactionValues: [value],
      returnRaw: true,
      timeoutMs: RUN_TIMEOUT_MS,
    },
  );
}

async function expectStartupRejectsEnvFileEntry(
  probe: DockerProbe,
  image: string,
  assignment: string,
  key: string,
  value: string,
): Promise<void> {
  const result = await runStartupWithEnvFileEntry(probe, image, assignment, key, value);
  const output = `${result.stdout}\n${result.stderr}`;
  const safeResultText = redactExpectedSecret(value, resultText(result));

  expect(result.exitCode, `Hermes startup should reject ${key}\n${safeResultText}`).not.toBe(0);
  expect(
    output,
    `Hermes startup rejection should mention raw secret-shaped values for ${key}`,
  ).toContain("raw secret-shaped values");
  expect(output, `Hermes startup rejection should name ${key}`).toContain(key);
  expect(output, `Hermes startup rejection must not print ${key}'s raw value`).not.toContain(value);
}

async function expectStartupRejectsRuntimeEnvEntry(
  probe: DockerProbe,
  image: string,
  assignment: string,
  key: string,
  value: string,
): Promise<void> {
  const result = await runStartupWithRuntimeEnvEntry(probe, image, assignment, key, value);
  const output = `${result.stdout}\n${result.stderr}`;
  const safeResultText = redactExpectedSecret(value, resultText(result));

  expect(
    result.exitCode,
    `Hermes startup should reject runtime env ${key}\n${safeResultText}`,
  ).not.toBe(0);
  expect(
    output,
    `Hermes startup rejection should mention process environment for ${key}`,
  ).toContain("process environment");
  expect(output, `Hermes startup rejection should name ${key}`).toContain(key);
  expect(output, `Hermes startup rejection must not print ${key}'s raw value`).not.toContain(value);
}

type RuntimeApiKeyProbe = {
  readonly key_hash: string;
  readonly key_hex: boolean;
  readonly key_len: number;
  readonly strict_hash_ok: boolean;
  readonly compat_hash_ok: boolean;
};

async function probeRuntimeApiServerKey(
  probe: DockerProbe,
  image: string,
  label: string,
): Promise<RuntimeApiKeyProbe> {
  const result = await probe.run(
    ["run", "--rm", "--entrypoint", "/bin/bash", image, "-lc", RUNTIME_API_KEY_PROBE_SCRIPT],
    {
      artifactName: `runtime-api-server-key-${label}`,
      returnRaw: true,
      timeoutMs: RUN_TIMEOUT_MS,
    },
  );

  expect(
    result.exitCode,
    `Hermes startup should mint API_SERVER_KEY at runtime and refresh hashes\n${resultText(result)}`,
  ).toBe(0);
  return JSON.parse(result.stdout.trim()) as RuntimeApiKeyProbe;
}

async function expectRuntimeApiServerKeyPerSandbox(
  probe: DockerProbe,
  image: string,
): Promise<void> {
  const first = await probeRuntimeApiServerKey(probe, image, "first");
  const second = await probeRuntimeApiServerKey(probe, image, "second");

  for (const [label, probeResult] of [
    ["first", first],
    ["second", second],
  ] as const) {
    expect(probeResult.key_hex, `${label} runtime API_SERVER_KEY should be 32-byte hex`).toBe(true);
    expect(probeResult.key_len, `${label} runtime API_SERVER_KEY length`).toBe(64);
    expect(probeResult.strict_hash_ok, `${label} strict Hermes config hash should validate`).toBe(
      true,
    );
    expect(
      probeResult.compat_hash_ok,
      `${label} compatibility Hermes config hash should validate`,
    ).toBe(true);
  }
  expect(
    first.key_hash,
    "two sandboxes from the same Hermes image must not share API_SERVER_KEY",
  ).not.toBe(second.key_hash);
}

liveTest(
  "hermes sandbox secret boundary keeps raw secrets out of images and startup",
  async ({ artifacts, cleanup, secrets, skip }) => {
    const probe = new DockerProbe(artifacts, (text, extraValues) =>
      secrets.redact(text, extraValues),
    );
    const runId = safeTag(`${process.env.GITHUB_RUN_ID ?? "local"}-${process.pid}-${Date.now()}`);
    const baseImageFromEnv = Boolean(
      process.env.NEMOCLAW_HERMES_BASE_IMAGE ?? process.env.HERMES_BASE_IMAGE,
    );
    const image =
      process.env.NEMOCLAW_HERMES_TEST_IMAGE ?? `nemoclaw-hermes-secret-boundary:${runId}`;
    const baseImage =
      process.env.NEMOCLAW_HERMES_BASE_IMAGE ??
      process.env.HERMES_BASE_IMAGE ??
      `nemoclaw-hermes-secret-boundary-base:${runId}`;
    const managedImage =
      process.env.NEMOCLAW_HERMES_MANAGED_TEST_IMAGE ??
      `nemoclaw-hermes-secret-boundary-managed:${runId}`;
    let removeImage = false;
    let removeManagedImage = false;
    let removeBaseImage = false;

    await artifacts.writeJson("scenario.json", {
      id: "hermes-sandbox-secret-boundary",
      runner: "vitest",
      boundary: "docker-hermes-image-and-startup",
      legacySource: "test/e2e/test-hermes-sandbox-secret-boundary.sh",
      image,
      baseImage,
      managedImage,
      prebuiltImage: Boolean(process.env.NEMOCLAW_HERMES_TEST_IMAGE),
      prebuiltManagedImage: Boolean(process.env.NEMOCLAW_HERMES_MANAGED_TEST_IMAGE),
      contract: [
        "Docker is required and prebuilt image env vars must reference inspectable images",
        "Hermes .env in the sandbox image is a real file with no baked API_SERVER_KEY or raw external secret-shaped values",
        "Hermes final image imports python-multipart from /opt/hermes/.venv and has no gcc, g++, or make commands",
        "Hermes final image can allocate a PTY through /dev/pts",
        "Hermes startup mints a unique API_SERVER_KEY per sandbox and refreshes strict and compatibility config hashes",
        "Hermes config preserves api_server remote platform toolsets and does not use no_mcp",
        "managed-tool image keeps gateway auth tokens out of sandbox env/config while preserving gateway URLs/config",
        "nemoclaw-start rejects raw secret-shaped .env entries without echoing their values",
        "nemoclaw-start rejects raw secret-shaped process env entries without echoing their values",
      ],
    });

    cleanup.add("remove Hermes sandbox secret-boundary images", async () => {
      const images = [
        removeImage ? image : undefined,
        removeManagedImage ? managedImage : undefined,
        removeBaseImage ? baseImage : undefined,
      ].filter((value): value is string => Boolean(value));
      await (images.length === 0
        ? Promise.resolve()
        : probe.run(["rmi", "-f", ...images], {
            artifactName: "cleanup-hermes-secret-boundary-images",
            timeoutMs: 60_000,
          }));
    });

    await requireDocker(probe, skip);

    removeImage = await buildHermesImageIfNeeded(probe, image, baseImage, baseImageFromEnv);
    await probe.expect(["image", "inspect", image], {
      artifactName: "inspect-hermes-image-after-build",
      timeoutMs: 30_000,
    });
    removeManagedImage = await buildManagedImageIfNeeded(
      probe,
      managedImage,
      baseImage,
      baseImageFromEnv,
    );
    removeBaseImage = !baseImageFromEnv && (removeImage || removeManagedImage);
    await probe.expect(["image", "inspect", managedImage], {
      artifactName: "inspect-managed-hermes-image-after-build",
      timeoutMs: 30_000,
    });

    await inspectImageBoundary(probe, image);
    await inspectManagedToolBoundary(probe, managedImage);
    await expectRuntimeApiServerKeyPerSandbox(probe, image);
    await expectStartupRejectsEnvFileEntry(
      probe,
      image,
      `DEVTEST_API_TOKEN=${RAW_SECRET_SENTINEL}`,
      "DEVTEST_API_TOKEN",
      RAW_SECRET_SENTINEL,
    );
    await expectStartupRejectsEnvFileEntry(
      probe,
      image,
      `INTERNAL_API=${RAW_SECRET_SENTINEL}`,
      "INTERNAL_API",
      RAW_SECRET_SENTINEL,
    );
    await expectStartupRejectsEnvFileEntry(
      probe,
      image,
      "OPENAI_API_KEY=sk-OPENSHELL-PROXY-REWRITE",
      "OPENAI_API_KEY",
      "sk-OPENSHELL-PROXY-REWRITE",
    );
    await expectStartupRejectsRuntimeEnvEntry(
      probe,
      image,
      `DEVTEST_API_TOKEN=${RAW_SECRET_SENTINEL}`,
      "DEVTEST_API_TOKEN",
      RAW_SECRET_SENTINEL,
    );
    await expectStartupRejectsRuntimeEnvEntry(
      probe,
      image,
      `NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN=${RAW_REFRESH_TOKEN}`,
      "NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN",
      RAW_REFRESH_TOKEN,
    );

    await artifacts.writeJson("scenario-result.json", {
      id: "hermes-sandbox-secret-boundary",
      image,
      managedImage,
      assertions: {
        imageEnvSecretBoundaryVerified: true,
        runtimeApiServerKeyPerSandboxVerified: true,
        imageRemoteToolsetsVerified: true,
        managedToolGatewayAuthBoundaryVerified: true,
        envFileSecretRejectionsVerified: true,
        runtimeEnvSecretRejectionsVerified: true,
        rejectionOutputRedactionVerified: true,
      },
    });
  },
);
