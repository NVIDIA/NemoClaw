// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface HermesManagedStartupIntegrityPaths {
  pythonPath: string;
  configPath: string;
  envPath: string;
  strictHashPath: string;
  compatHashPath: string;
  startupLogPath: string;
  strictHashUid: number;
  strictHashGid: number;
}

const DEFAULT_PATHS: HermesManagedStartupIntegrityPaths = {
  pythonPath: "/opt/hermes/.venv/bin/python3",
  configPath: "/sandbox/.hermes/config.yaml",
  envPath: "/sandbox/.hermes/.env",
  strictHashPath: "/etc/nemoclaw/hermes.config-hash",
  compatHashPath: "/sandbox/.hermes/.config-hash",
  startupLogPath: "/tmp/nemoclaw-start.log",
  strictHashUid: 0,
  strictHashGid: 0,
};

function pythonLiteral(value: string | number): string {
  return JSON.stringify(value);
}

/**
 * Build an independent read-only proof for the managed non-root Hermes startup hash contract.
 * The strict anchor intentionally describes the build-time environment before PID 1 mints one API key.
 */
export function buildHermesManagedStartupIntegrityScript(
  overrides: Partial<HermesManagedStartupIntegrityPaths> = {},
): string {
  const paths = { ...DEFAULT_PATHS, ...overrides };
  return `set -eu
${pythonLiteral(paths.pythonPath)} -I - <<'PY'
import hashlib
import os
from pathlib import Path
import re
import secrets
import stat
import yaml

config_path = Path(${pythonLiteral(paths.configPath)})
env_path = Path(${pythonLiteral(paths.envPath)})
strict_hash_path = Path(${pythonLiteral(paths.strictHashPath)})
compat_hash_path = Path(${pythonLiteral(paths.compatHashPath)})
startup_log_path = Path(${pythonLiteral(paths.startupLogPath)})
strict_hash_uid = ${pythonLiteral(paths.strictHashUid)}
strict_hash_gid = ${pythonLiteral(paths.strictHashGid)}

def fail(message):
    raise SystemExit(message)

def read_regular(path, label, max_bytes):
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags)
    except OSError:
        fail(f"{label} is not a readable regular file")
    try:
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            fail(f"{label} is not a single-link regular file")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            data = stream.read(max_bytes + 1)
        if len(data) > max_bytes:
            fail(f"{label} exceeds the proof size limit")
        return data, metadata
    finally:
        os.close(fd)

def parse_hash(data, label):
    try:
        text = data.decode("ascii")
    except UnicodeDecodeError:
        fail(f"{label} is not ASCII")
    parts = text.split("\\n")
    if len(parts) != 3 or parts[-1] != "":
        fail(f"{label} does not contain exactly two records")
    lines = parts[:2]
    expected_paths = (str(config_path), str(env_path))
    digests = []
    for line, expected_path in zip(lines, expected_paths):
        match = re.fullmatch(r"([0-9a-f]{64})  (.+)", line)
        if match is None or match.group(2) != expected_path:
            fail(f"{label} contains an unexpected file record")
        digests.append(match.group(1))
    return tuple(digests)

def digest(data):
    return hashlib.sha256(data).hexdigest()

config_bytes, _config_metadata = read_regular(config_path, "Hermes config", 4 * 1024 * 1024)
env_bytes, _env_metadata = read_regular(env_path, "Hermes environment", 1024 * 1024)
strict_hash_bytes, strict_hash_metadata = read_regular(
    strict_hash_path, "Hermes strict hash", 4096
)
compat_hash_bytes, _compat_hash_metadata = read_regular(
    compat_hash_path, "Hermes compatibility hash", 4096
)
startup_log_bytes, _startup_log_metadata = read_regular(
    startup_log_path, "Hermes startup log", 8 * 1024 * 1024
)

if (
    strict_hash_metadata.st_uid != strict_hash_uid
    or strict_hash_metadata.st_gid != strict_hash_gid
    or stat.S_IMODE(strict_hash_metadata.st_mode) & 0o222
):
    fail("Hermes strict hash is not the expected read-only owner anchor")

try:
    env_text = env_bytes.decode("utf-8")
except UnicodeDecodeError:
    fail("Hermes environment is not UTF-8")
base_env_lines = []
api_key_lines = 0
for line in env_text.splitlines(keepends=True):
    candidate = line.rstrip("\\n")
    if candidate.startswith("export "):
        candidate = candidate[len("export "):].lstrip()
    key = candidate.split("=", 1)[0] if "=" in candidate else None
    if key == "API_SERVER_KEY":
        if api_key_lines != 0 or re.fullmatch(r"API_SERVER_KEY=[0-9a-f]{64}\\n", line) is None:
            fail("Hermes environment contains an unexpected API key assignment")
        api_key_lines += 1
    else:
        base_env_lines.append(line)
if api_key_lines != 1:
    fail("Hermes environment does not contain exactly one canonical generated API key")
base_env_bytes = "".join(base_env_lines).encode("utf-8")

strict_digests = parse_hash(strict_hash_bytes, "Hermes strict hash")
compat_digests = parse_hash(compat_hash_bytes, "Hermes compatibility hash")
strict_config_digest, strict_env_digest = strict_digests
compat_config_digest, compat_env_digest = compat_digests
if not secrets.compare_digest(strict_config_digest, digest(config_bytes)):
    original, metadata = read_regular(
        config_path.parent / ".native-local-startup-config", "Hermes startup config witness", 4 * 1024 * 1024
    )
    if (
        stat.S_IMODE(metadata.st_mode) != 0o600
        or metadata.st_uid != _config_metadata.st_uid
        or metadata.st_gid != _config_metadata.st_gid
        or not secrets.compare_digest(strict_config_digest, digest(original))
    ):
        fail("Hermes startup config witness does not match the strict anchor")
    # Authenticate the original bytes before interpreting any proposed credential changes.
    base = yaml.safe_load(original)
    current = yaml.safe_load(config_bytes)
    try:
        provider = base["_nemoclaw_upstream"]["provider"]
        if provider not in ("ollama-local", "vllm-local", "llama-cpp-local", "compatible-endpoint"):
            fail("Hermes startup config has no managed native provider")
        reference = current["model"]["api_key"]
        if not isinstance(reference, str) or re.fullmatch(
            r"openshell:resolve:env:(?:v[0-9]{1,20}|s[a-f0-9]{64})_NEMOCLAW_LOCAL_INFERENCE_TOKEN", reference
        ) is None:
            fail("Hermes startup config has no provider-bound credential")
        selected = [entry for entry in base["custom_providers"] if entry.get("name") == provider]
        if len(selected) != 1:
            fail("Hermes startup config has ambiguous managed providers")
        model, managed, custom = base["model"], base["providers"][provider], selected[0]
        prior = model["api_key"]
        if (
            base["_nemoclaw_upstream"]["provider_key"] != provider
            or model["provider"] != "custom"
            or managed["api_key"] != prior or custom["api_key"] != prior
            or managed["api"] != model["base_url"] or custom["base_url"] != model["base_url"]
            or not isinstance(prior, str)
            or (prior != "\${NEMOCLAW_LOCAL_INFERENCE_TOKEN}" and re.fullmatch(
                r"openshell:resolve:env:(?:v[0-9]{1,20}|s[a-f0-9]{64})_NEMOCLAW_LOCAL_INFERENCE_TOKEN", prior
            ) is None)
        ):
            fail("Hermes startup credential slots are inconsistent")
        base["model"] = {**model, "api_key": reference}
        base["providers"] = {**base["providers"], provider: {**managed, "api_key": reference}}
        base["custom_providers"] = [
            {**entry, "api_key": reference} if entry is custom else entry
            for entry in base["custom_providers"]
        ]
        if yaml.safe_dump(base, sort_keys=False).encode("utf-8") != config_bytes:
            fail("Hermes config differs beyond the managed startup credentials")
    except (KeyError, TypeError, AttributeError):
        fail("Hermes startup config has invalid managed credential slots")
if not secrets.compare_digest(strict_env_digest, digest(base_env_bytes)):
    fail("Hermes environment differs from the strict startup base beyond the generated API key")
if not secrets.compare_digest(compat_config_digest, digest(config_bytes)):
    fail("Hermes compatibility hash does not match the current config")
if not secrets.compare_digest(compat_env_digest, digest(env_bytes)):
    fail("Hermes compatibility hash does not match the current environment")

startup_log = startup_log_bytes.decode("utf-8", "replace")
if (
    "ensure-api-key is restricted to the Hermes PID 1 startup transaction" in startup_log
    or "Hermes runtime config guard refuses mutation under a foreign PID 1" in startup_log
):
    fail("Hermes startup log contains a runtime config guard refusal")

print("OK")
PY`;
}
