// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Test-only damage injection through the sandbox owner's mutable config. Never updates guard anchors. */
export function hermesNvidiaRecoveryProbe(
  phase: "seed" | "verify",
  home = "/sandbox/.hermes",
): string[] {
  return ["/opt/hermes/.venv/bin/python3", "-c", PROGRAM, phase, home];
}

const PROGRAM = String.raw`
import copy, hashlib, json, os, re, stat, sys
import yaml

SENTINEL = "[STRIPPED_BY_MIGRATION]"
ENDPOINT = "https://integrate.api.nvidia.com/v1"
HANDLE = r"openshell:resolve:env:(?:v[0-9]{1,20}|s[a-f0-9]{64})_NVIDIA_INFERENCE_API_KEY"
MARKER = b"Hermes NVIDIA recovery user state\n"
LIMIT = 1024 * 1024

def checked(fd):
    info = os.fstat(fd)
    assert stat.S_ISREG(info.st_mode) and info.st_nlink == 1
    assert info.st_uid == os.geteuid() and info.st_size <= LIMIT
    return info

def identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

def run():
    phase, home = sys.argv[1:]
    assert phase in ("seed", "verify")
    directory = os.open(home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    assert os.fstat(directory).st_uid == os.geteuid()
    flags = os.O_RDWR if phase == "seed" else os.O_RDONLY
    fd = os.open("config.yaml", flags | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    before = checked(fd)
    raw = os.read(fd, LIMIT + 1)
    assert len(raw) <= LIMIT and identity(os.fstat(fd)) == identity(before)
    config = yaml.safe_load(raw)
    model = config["model"]
    provider = config["providers"]["nvidia-prod"]
    customs = [p for p in config["custom_providers"] if p.get("name") == "nvidia-prod"]
    assert len(customs) == 1
    custom = customs[0]
    metadata = config["_nemoclaw_upstream"]
    assert metadata["provider"] == metadata["provider_key"] == "nvidia-prod"
    assert metadata["model"] == model["default"]
    assert model["provider"] == "custom"
    assert model["base_url"] == provider["api"] == custom["base_url"] == ENDPOINT
    assert provider["name"] == "nvidia-prod" and provider["default_model"] == model["default"]
    slots = [model, provider, custom]
    values = [s["api_key"] for s in slots]
    assert len(set(values)) == 1 and re.fullmatch(HANDLE, values[0])
    normalized = copy.deepcopy(config)
    normalized["model"] = {**normalized["model"], "api_key": SENTINEL}
    normalized["providers"] = {**normalized["providers"], "nvidia-prod":
                               {**normalized["providers"]["nvidia-prod"], "api_key": SENTINEL}}
    normalized["custom_providers"] = [{**p, "api_key": SENTINEL} if p["name"] == "nvidia-prod" else p
                                      for p in normalized["custom_providers"]]
    fingerprint = hashlib.sha256(json.dumps(normalized, sort_keys=True).encode()).hexdigest()
    marker_name = "e2e-nvidia-recovery-user-state.txt"
    if phase == "seed":
        marker = os.open(marker_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600, dir_fd=directory)
        with os.fdopen(marker, "wb") as stream:
            stream.write(MARKER)
        assert identity(os.stat("config.yaml", dir_fd=directory, follow_symlinks=False)) == identity(before)
        assert identity(os.fstat(fd)) == identity(before)
        payload = yaml.safe_dump(normalized, sort_keys=False).encode()
        assert len(payload) <= LIMIT
        os.lseek(fd, 0, os.SEEK_SET)
        assert os.write(fd, payload) == len(payload)
        os.ftruncate(fd, len(payload))
        os.fsync(fd)
        os.lseek(fd, 0, os.SEEK_SET)
        assert yaml.safe_load(os.read(fd, LIMIT + 1)) == normalized
        after = checked(fd)
        assert (after.st_uid, after.st_gid, after.st_mode) == (before.st_uid, before.st_gid, before.st_mode)
        assert identity(os.stat("config.yaml", dir_fd=directory, follow_symlinks=False)) == identity(after)
        os.close(fd)
        fd = os.open("config.yaml", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        checked(fd)
        restored = yaml.safe_load(os.read(fd, LIMIT + 1))
        assert restored == normalized
        values = [restored["model"]["api_key"], restored["providers"]["nvidia-prod"]["api_key"],
                  next(p for p in restored["custom_providers"] if p["name"] == "nvidia-prod")["api_key"]]
    marker = os.open(marker_name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    checked(marker)
    assert os.read(marker, LIMIT + 1) == MARKER
    os.close(marker)
    os.close(fd)
    os.close(directory)
    print(json.dumps({"state": "stripped" if phase == "seed" else "recovered",
                      "credentials": [v == SENTINEL if phase == "seed" else bool(re.fullmatch(HANDLE, v)) for v in values],
                      "configFingerprint": fingerprint, "userState": True}))

try:
    run()
except Exception:
    # Do not emit config values, YAML parser excerpts, or credential material.
    print("Hermes NVIDIA recovery fixture refused unexpected state", file=sys.stderr)
    sys.exit(1)
`;
