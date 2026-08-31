// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.join(import.meta.dirname, "../../..");
const probes = path.join(root, "agents", "hermes", "image-build-probes.py");
function runNeutralPlatformProbe(configuration: string) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-platform-probe-"));
  const gatewayRoot = path.join(temporaryRoot, "gateway");
  fs.mkdirSync(gatewayRoot);
  fs.writeFileSync(path.join(gatewayRoot, "__init__.py"), "");
  fs.writeFileSync(path.join(gatewayRoot, "config.py"), configuration);
  try {
    return spawnSync(
      "python3",
      [
        "-I",
        "-c",
        "import importlib.util, sys; " +
          "sys.path.insert(0, sys.argv[2]); " +
          "spec = importlib.util.spec_from_file_location('image_build_probes', sys.argv[1]); " +
          "module = importlib.util.module_from_spec(spec); " +
          "spec.loader.exec_module(module); " +
          "module.verify_neutral_platform_inertness()",
        probes,
        temporaryRoot,
      ],
      { encoding: "utf8", timeout: 5000 },
    );
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

describe("Hermes image build probes", () => {
  it("checks only platform configurations exercised by hostile build inputs", () => {
    const result = runNeutralPlatformProbe(
      `from enum import Enum
from types import SimpleNamespace

class Platform(Enum):
    GOOGLE_CHAT = "google_chat"
    WHATSAPP_CLOUD = "whatsapp_cloud"
    BUZZ = "buzz"

def load_gateway_config():
    disabled = lambda: SimpleNamespace(enabled=False, token=None, api_key=None, extra={})
    return SimpleNamespace(platforms={
        Platform.GOOGLE_CHAT: disabled(),
        Platform.WHATSAPP_CLOUD: disabled(),
    })
`,
    );

    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects an enabled platform from the neutral image probe", () => {
    const result = runNeutralPlatformProbe(
      `from enum import Enum
from types import SimpleNamespace

class Platform(Enum):
    GOOGLE_CHAT = "google_chat"
    WHATSAPP_CLOUD = "whatsapp_cloud"

def load_gateway_config():
    disabled = SimpleNamespace(enabled=False, token=None, api_key=None, extra={})
    enabled = SimpleNamespace(enabled=True, token="unexpected", api_key=None, extra={})
    return SimpleNamespace(platforms={
        Platform.GOOGLE_CHAT: enabled,
        Platform.WHATSAPP_CLOUD: disabled,
    })
`,
    );

    expect(result.status).not.toBe(0);
  });

});
