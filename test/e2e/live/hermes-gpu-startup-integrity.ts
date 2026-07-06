// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface HermesManagedStartupIntegrityPaths {
  configPath: string;
  envPath: string;
  strictHashPath: string;
  compatHashPath: string;
  startupLogPath: string;
  strictHashUid: number;
  strictHashGid: number;
}

const DEFAULT_PATHS: HermesManagedStartupIntegrityPaths = {
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
/usr/bin/python3 -I - <<'PY'
import hashlib
import os
from pathlib import Path
import re
import secrets
import stat

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
    if not text.endswith("\\n"):
        fail(f"{label} is missing its final newline")
    lines = text.splitlines()
    expected_paths = (str(config_path), str(env_path))
    if len(lines) != len(expected_paths):
        fail(f"{label} does not contain exactly two records")
    digests = []
    for line, expected_path in zip(lines, expected_paths):
        match = re.fullmatch(r"([0-9a-f]{64})  (.+)", line)
        if match is None or match.group(2) != expected_path:
            fail(f"{label} contains an unexpected record")
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

strict_config_digest, strict_env_digest = parse_hash(strict_hash_bytes, "Hermes strict hash")
compat_config_digest, compat_env_digest = parse_hash(
    compat_hash_bytes, "Hermes compatibility hash"
)
if not secrets.compare_digest(strict_config_digest, digest(config_bytes)):
    fail("Hermes config differs from the strict startup base")
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
