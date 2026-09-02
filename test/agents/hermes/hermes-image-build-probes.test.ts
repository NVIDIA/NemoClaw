// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.join(import.meta.dirname, "../../..");
const probes = path.join(root, "agents", "hermes", "image-build-probes.py");

function writeExecutable(target: string, source: string): void {
  fs.writeFileSync(target, source, { mode: 0o755 });
}

function runCompatibilityRetirementProbe({
  version,
  adapter = '{"commands":["resumed_oneshot"]}\n',
  oneshot = "process_registry.wait_for_pending_completions(oneshot_task_id)\n",
}: {
  version: string;
  adapter?: string;
  oneshot?: string;
}) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-compat-probe-"));
  const hermes = path.join(temporaryRoot, "hermes");
  const adapterPath = path.join(temporaryRoot, "adapter.json");
  const oneshotPath = path.join(temporaryRoot, "oneshot.py");
  writeExecutable(hermes, `#!/usr/bin/env bash\nprintf '%s\\n' ${JSON.stringify(version)}\n`);
  fs.writeFileSync(adapterPath, adapter);
  fs.writeFileSync(oneshotPath, oneshot);
  const source = `
import importlib.util
import pathlib
import sys

spec = importlib.util.spec_from_file_location("image_build_probes", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.verify_compatibility_retirement(
    hermes=pathlib.Path(sys.argv[2]),
    adapter=pathlib.Path(sys.argv[3]),
    oneshot=pathlib.Path(sys.argv[4]),
)
`;
  try {
    return spawnSync("python3", ["-I", "-c", source, probes, hermes, adapterPath, oneshotPath], {
      encoding: "utf8",
      timeout: 5000,
    });
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

function runGeneratedConfigPreparation(doctorExit = 0) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-config-prepare-"));
  const hermesHome = path.join(temporaryRoot, ".hermes");
  const hermes = path.join(temporaryRoot, "hermes");
  const node = path.join(temporaryRoot, "node");
  const generator = path.join(temporaryRoot, "generate-config.ts");
  const orderLog = path.join(temporaryRoot, "order.log");
  fs.mkdirSync(hermesHome);
  fs.writeFileSync(generator, "// fixture\n");
  writeExecutable(
    hermes,
    `#!/usr/bin/env bash
set -euo pipefail
test "$*" = "doctor --fix"
printf 'doctor\n' >> "$ORDER_LOG"
printf 'doctor_migrated: true\n' > "$HERMES_HOME/config.yaml"
printf 'DOCTOR_MIGRATED=1\n' > "$HERMES_HOME/.env"
exit ${doctorExit}
`,
  );
  writeExecutable(
    node,
    `#!/usr/bin/env bash
set -euo pipefail
test "$1" = "--experimental-strip-types"
printf 'generate\n' >> "$ORDER_LOG"
printf 'model: trusted\n' > "$HERMES_HOME/config.yaml"
printf 'SAFE=1\n' > "$HERMES_HOME/.env"
chmod 600 "$HERMES_HOME/config.yaml" "$HERMES_HOME/.env"
`,
  );
  const source = `
import importlib.util
import os
import pathlib
import sys

spec = importlib.util.spec_from_file_location("image_build_probes", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.prepare_generated_config(
    hermes=pathlib.Path(sys.argv[2]),
    node=pathlib.Path(sys.argv[3]),
    generator=pathlib.Path(sys.argv[4]),
    hermes_home=pathlib.Path(sys.argv[5]),
    env={"PATH": os.environ["PATH"], "ORDER_LOG": sys.argv[6]},
)
`;
  const result = spawnSync(
    "python3",
    ["-I", "-c", source, probes, hermes, node, generator, hermesHome, orderLog],
    { encoding: "utf8", timeout: 5000 },
  );
  return { hermesHome, orderLog, result, temporaryRoot };
}

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
  it("rejects an upgrade that retains the Hermes 0.20.6 adapter", () => {
    const result = runCompatibilityRetirementProbe({ version: "hermes v0.20.0" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "installed Hermes 0.20.0 but Hermes v0.20.6 compatibility workarounds are still installed",
    );
  });

  it("accepts the reviewed Hermes version and exact one-shot completion scope", () => {
    const result = runCompatibilityRetirementProbe({ version: "hermes v0.20.6" });

    expect(result.status, result.stderr).toBe(0);
  });

  it("runs Hermes doctor before replacing its generated configuration", () => {
    const run = runGeneratedConfigPreparation();
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(fs.readFileSync(run.orderLog, "utf8")).toBe("doctor\ngenerate\n");
      expect(fs.readFileSync(path.join(run.hermesHome, "config.yaml"), "utf8")).toBe(
        "model: trusted\n",
      );
      expect(fs.readFileSync(path.join(run.hermesHome, ".env"), "utf8")).toBe("SAFE=1\n");
      expect(fs.statSync(path.join(run.hermesHome, "config.yaml")).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(run.hermesHome, ".env")).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(run.temporaryRoot, { force: true, recursive: true });
    }
  });

  it("does not generate configuration after Hermes doctor fails", () => {
    const run = runGeneratedConfigPreparation(7);
    try {
      expect(run.result.status).toBe(1);
      expect(run.result.stderr).toContain("Hermes doctor exited with status 7");
      expect(fs.readFileSync(run.orderLog, "utf8")).toBe("doctor\n");
      expect(fs.readFileSync(path.join(run.hermesHome, "config.yaml"), "utf8")).toContain(
        "doctor_migrated",
      );
    } finally {
      fs.rmSync(run.temporaryRoot, { force: true, recursive: true });
    }
  });

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
