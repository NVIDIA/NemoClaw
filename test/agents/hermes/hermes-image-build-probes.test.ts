// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.join(import.meta.dirname, "../../..");
const probes = path.join(root, "agents", "hermes", "image-build-probes.py");
const commands = [
  "cron-backup",
  "cron-create",
  "cron-reopen",
  "cron-runtime-source",
  "dashboard-policy",
  "discord-backup",
  "discord-create",
  "discord-recovery-source",
  "discord-reopen",
  "gateway-process-identity",
  "gateway-runtime-metadata",
  "googlechat-override-seams",
  "langfuse-credentials",
  "neutral-platform-inertness",
  "profile-policy",
  "session-preview",
] as const;

describe("Hermes image build probes", () => {
  it("checks only platform configurations exercised by hostile build inputs", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-platform-probe-"));
    const gatewayRoot = path.join(temporaryRoot, "gateway");
    fs.mkdirSync(gatewayRoot);
    fs.writeFileSync(path.join(gatewayRoot, "__init__.py"), "");
    fs.writeFileSync(
      path.join(gatewayRoot, "config.py"),
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
    try {
      const result = spawnSync(
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

      expect(result.status, result.stderr).toBe(0);
    } finally {
      fs.rmSync(temporaryRoot, { force: true, recursive: true });
    }
  });

  it.each(Array.from(commands, (value) => [value]))(
    "lists Dockerfile probe command %s in the runner usage",
    (command) => {
      const result = spawnSync("python3", ["-I", probes], {
        encoding: "utf8",
        timeout: 5000,
      });

      expect(result.status).toBe(1);

      expect(result.stderr).toContain(command);
    },
  );
});
