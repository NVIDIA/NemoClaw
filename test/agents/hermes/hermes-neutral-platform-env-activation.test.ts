// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const PATCHER = path.join(ROOT, "agents", "hermes", "patch-neutral-platform-env-activation.py");

const UPSTREAM_FIXTURE = `import logging
import math
import os
import json
from dataclasses import dataclass, field

@dataclass
class PlatformConfig:
    enabled: bool = False
    token: str | None = None
    extra: dict = field(default_factory=dict)

@dataclass
class GatewayConfig:
    platforms: dict = field(default_factory=dict)

def _getenv_str(name, default=None):
    return os.getenv(name, default)

def _getenv_int(name, default=None):
    value = os.getenv(name)
    return int(value) if value is not None else default

def _apply_env_overrides(config: GatewayConfig) -> None:
    """Apply environment variable overrides to config."""
    getenv = _getenv_str
    getenv_int = _getenv_int

    token = getenv("CHANNEL_TOKEN")
    if token:
        for platform_config in config.platforms.values():
            platform_config.enabled = True
            platform_config.token = token
            platform_config.extra["credential"] = token

    for platform_config in config.platforms.values():
        platform_config.extra.pop("_enabled_explicit", None)

if __name__ == "__main__":
    disabled = PlatformConfig(extra={"_enabled_explicit": True})
    enabled = PlatformConfig(enabled=True, extra={"selected": True})
    config = GatewayConfig(platforms={"disabled": disabled, "enabled": enabled})
    _apply_env_overrides(config)
    print(json.dumps({
        name: {
            "enabled": platform.enabled,
            "token": platform.token,
            "extra": platform.extra,
        }
        for name, platform in config.platforms.items()
    }, sort_keys=True))
`;

function runPatcher(fixture: string) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-inert-env-"));
  const configPath = path.join(temporaryRoot, "config.py");
  fs.writeFileSync(configPath, fixture);
  const result = spawnSync("python3", ["-I", PATCHER, configPath], {
    encoding: "utf8",
    timeout: 5000,
  });
  return { configPath, result, temporaryRoot };
}

describe("Hermes neutral platform environment activation guard", () => {
  it("preserves explicit disables while leaving validated enabled platforms active", () => {
    const { configPath, result, temporaryRoot } = runPatcher(UPSTREAM_FIXTURE);
    try {
      expect(result.status, result.stderr).toBe(0);
      const second = spawnSync("python3", ["-I", PATCHER, configPath], {
        encoding: "utf8",
        timeout: 5000,
      });
      expect(second.status, second.stderr).toBe(0);

      const probe = spawnSync("python3", ["-I", configPath], {
        encoding: "utf8",
        env: {
          ...process.env,
          CHANNEL_TOKEN: "hostile-ambient-credential",
          NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION: "1",
        },
        timeout: 5000,
      });

      const legacyProbe = spawnSync("python3", ["-I", configPath], {
        encoding: "utf8",
        env: {
          ...process.env,
          CHANNEL_TOKEN: "hostile-ambient-credential",
          NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION: "0",
        },
        timeout: 5000,
      });
      expect(legacyProbe.status, legacyProbe.stderr).toBe(0);
      expect(JSON.parse(legacyProbe.stdout).disabled).toEqual({
        enabled: true,
        extra: { credential: "hostile-ambient-credential" },
        token: "hostile-ambient-credential",
      });
      expect(probe.status, probe.stderr).toBe(0);
      expect(JSON.parse(probe.stdout)).toEqual({
        disabled: { enabled: false, extra: {}, token: null },
        enabled: {
          enabled: true,
          extra: { credential: "hostile-ambient-credential", selected: true },
          token: "hostile-ambient-credential",
        },
      });
    } finally {
      fs.rmSync(temporaryRoot, { force: true, recursive: true });
    }
  });
});
