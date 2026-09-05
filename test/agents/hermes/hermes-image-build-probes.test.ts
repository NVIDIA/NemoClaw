// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { dockerfileInstructions } from "../../../src/lib/onboard/dockerfile-tool-disclosure-contract";

const root = path.join(import.meta.dirname, "../../..");
const probes = path.join(root, "agents", "hermes", "image-build-probes.py");
const dockerfile = fs.readFileSync(path.join(root, "agents", "hermes", "Dockerfile"), "utf8");
const a2aNeutralPatch = fs.readFileSync(path.join(root, "agents", "hermes", "a2a-neutral.patch"));
const probeSource = fs.readFileSync(probes, "utf8");
const imageProbePath = "/opt/nemoclaw-hermes-config/image-build-probes.py";
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
  "session-delete",
  "session-preview",
  "session-state-create",
  "session-state-reopen",
  "secure-directory-modes",
] as const;

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
  it("verifies the A2A neutralization patch before root applies it", () => {
    const digest = createHash("sha256").update(a2aNeutralPatch).digest("hex");
    const digestBinding = `ARG NEMOCLAW_HERMES_A2A_NEUTRAL_PATCH_SHA256=${digest}`;
    const integrityCheck =
      '"$NEMOCLAW_HERMES_A2A_NEUTRAL_PATCH_SHA256" /opt/nemoclaw-hermes-config/a2a-neutral.patch';
    const shaCheck = "| sha256sum -c -";
    const applyCheck = "git -C /opt/hermes apply --check";
    const integrityCheckIndex = dockerfile.indexOf(integrityCheck);
    const shaCheckIndex = dockerfile.indexOf(shaCheck, integrityCheckIndex);

    expect(dockerfile).toContain(digestBinding);
    expect(integrityCheckIndex).toBeGreaterThan(dockerfile.indexOf(digestBinding));
    expect(shaCheckIndex).toBeGreaterThan(integrityCheckIndex);
    expect(dockerfile.indexOf(applyCheck, shaCheckIndex)).toBeGreaterThan(shaCheckIndex);
  });

  // source-shape-contract: security -- The final image must execute the reviewed runtime environment validator bytes
  it("binds the runtime environment validator to its source digest", () => {
    const imageDockerfile = fs.readFileSync(
      path.join(import.meta.dirname, "../../../agents/hermes/Dockerfile"),
      "utf8",
    );
    const runtimeEnvValidator = fs.readFileSync(
      path.join(import.meta.dirname, "../../../agents/hermes/validate-env-secret-boundary.py"),
    );
    const digest = createHash("sha256").update(runtimeEnvValidator).digest("hex");
    const digestBinding = `ARG NEMOCLAW_HERMES_VALIDATOR_SHA256=${digest}`;
    const integrityCheck =
      '"$NEMOCLAW_HERMES_VALIDATOR_SHA256" /usr/local/lib/nemoclaw/validate-hermes-env-secret-boundary.py';
    const bindingIndex = imageDockerfile.indexOf(digestBinding);
    const integrityCheckIndex = imageDockerfile.indexOf(integrityCheck, bindingIndex);

    expect(bindingIndex).toBeGreaterThan(-1);
    expect(integrityCheckIndex).toBeGreaterThan(bindingIndex);
    expect(imageDockerfile.indexOf("| sha256sum -c -", integrityCheckIndex)).toBeGreaterThan(
      integrityCheckIndex,
    );
  });

  // source-shape-contract: security -- The final image must execute the reviewed Hermes wrapper bytes
  it("binds the Hermes wrapper to its source digest", () => {
    const imageDockerfile = fs.readFileSync(
      path.join(import.meta.dirname, "../../../agents/hermes/Dockerfile"),
      "utf8",
    );
    const hermesWrapper = fs.readFileSync(
      path.join(import.meta.dirname, "../../../agents/hermes/hermes-wrapper.py"),
    );
    const digest = createHash("sha256").update(hermesWrapper).digest("hex");
    const digestBinding = `ARG NEMOCLAW_HERMES_WRAPPER_SHA256=${digest}`;
    const integrityCheck =
      '"$NEMOCLAW_HERMES_WRAPPER_SHA256" /usr/local/lib/nemoclaw/hermes-wrapper.py';
    const bindingIndex = imageDockerfile.indexOf(digestBinding);
    const integrityCheckIndex = imageDockerfile.indexOf(integrityCheck, bindingIndex);

    expect(bindingIndex).toBeGreaterThan(-1);
    expect(integrityCheckIndex).toBeGreaterThan(bindingIndex);
    expect(imageDockerfile.indexOf("| sha256sum -c -", integrityCheckIndex)).toBeGreaterThan(
      integrityCheckIndex,
    );
  });

  it("removes the Hindsight probe wheel after staging its temporary copy", () => {
    const probeWheel = "/opt/nemoclaw-hermes-config/hindsight-probe-aiohttp-retry.whl";
    const copyIndex = dockerfile.indexOf(`cp ${probeWheel}`);
    const removalIndex = dockerfile.indexOf(`rm ${probeWheel}`, copyIndex);
    const absenceCheckIndex = dockerfile.indexOf(`check_absent ${probeWheel}`);

    expect(copyIndex).toBeGreaterThan(-1);
    expect(removalIndex).toBeGreaterThan(copyIndex);
    expect(absenceCheckIndex).toBeGreaterThan(removalIndex);
  });

  it.each([
    {
      digest: "$NEMOCLAW_HERMES_PROFILE_POLICY_PATCHER_SHA256",
      invocation:
        "/usr/bin/python3 -I /opt/nemoclaw-hermes-config/patch-profile-policy-defaults.py",
      name: "profile policy",
    },
    {
      digest: "$NEMOCLAW_HERMES_NEUTRAL_PLATFORM_PATCHER_SHA256",
      invocation:
        "/usr/bin/python3 -I /opt/nemoclaw-hermes-config/patch-neutral-platform-env-activation.py",
      name: "neutral platform",
    },
  ])("keeps $name patch verification and application in one layer", ({ digest, invocation }) => {
    const verificationLayer = dockerfileInstructions(dockerfile).find(
      ({ text }) => text.startsWith("RUN ") && text.includes(digest),
    );

    expect(verificationLayer?.text).toContain("sha256sum -c -");
    expect(verificationLayer?.text).toContain(invocation);
  });

  it("keeps wrapper prerequisites and compatibility validation in one layer", () => {
    const runInstructions = dockerfileInstructions(dockerfile).filter(({ text }) =>
      text.startsWith("RUN "),
    );
    const prerequisiteLayer = runInstructions.find(({ text }) =>
      text.includes("test -x /usr/bin/python3"),
    );

    expect(prerequisiteLayer?.text).toContain(`${imageProbePath} compatibility-retirement`);
  });

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

  it("keeps A2A, Buzz, Google Chat, and WhatsApp Cloud disabled under hostile build inputs", () => {
    const result = runNeutralPlatformProbe(
      `from enum import Enum
from types import SimpleNamespace

class Platform(Enum):
    A2A = "a2a"
    BUZZ = "buzz"
    GOOGLE_CHAT = "google_chat"
    WHATSAPP_CLOUD = "whatsapp_cloud"

def load_gateway_config():
    disabled = lambda: SimpleNamespace(enabled=False, token=None, api_key=None, extra={})
    return SimpleNamespace(platforms={
        Platform.A2A: disabled(),
        Platform.BUZZ: disabled(),
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
    A2A = "a2a"
    BUZZ = "buzz"
    GOOGLE_CHAT = "google_chat"
    WHATSAPP_CLOUD = "whatsapp_cloud"

def load_gateway_config():
    disabled = SimpleNamespace(enabled=False, token=None, api_key=None, extra={})
    enabled = SimpleNamespace(enabled=True, token="unexpected", api_key=None, extra={})
    return SimpleNamespace(platforms={
        Platform.A2A: disabled,
        Platform.BUZZ: disabled,
        Platform.GOOGLE_CHAT: enabled,
        Platform.WHATSAPP_CLOUD: disabled,
    })
`,
    );

    expect(result.status).not.toBe(0);
  });

  it("validates session state sidecars according to SQLite's selected journal mode", () => {
    expect(probeSource).toContain('connection.execute("PRAGMA journal_mode")');
    expect(probeSource).toContain('if journal_mode == "wal":');
    expect(probeSource).toContain('elif journal_mode == "delete":');

    const behavior = String.raw`
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("nemoclaw_image_build_probes", sys.argv[1])
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

sys.modules["pwd"] = SimpleNamespace(
    getpwuid=lambda _uid: SimpleNamespace(pw_name="probe-owner")
)
sys.modules["grp"] = SimpleNamespace(
    getgrgid=lambda _gid: SimpleNamespace(gr_name="sandbox")
)

with tempfile.TemporaryDirectory() as temporary_directory:
    runtime = Path(temporary_directory)
    module._SESSION_STATE_DIRECTORY = runtime

    def create(name):
        path = runtime / name
        path.write_bytes(b"probe")
        os.chmod(path, 0o660)
        return path

    create("state.db")
    create("state.db-wal")
    create("state.db-shm")
    module._verify_session_state_metadata(
        "wal",
        {
            "state.db": "probe-owner",
            "state.db-wal": "probe-owner",
            "state.db-shm": "probe-owner",
        },
    )

    (runtime / "state.db-wal").unlink()
    (runtime / "state.db-shm").unlink()
    module._verify_session_state_metadata("delete", {"state.db": "probe-owner"})

    (runtime / "state.db-wal").symlink_to("missing")
    try:
        module._verify_session_state_metadata("delete", {"state.db": "probe-owner"})
    except AssertionError:
        pass
    else:
        raise AssertionError("DELETE mode accepted a WAL sidecar")

class JournalModeResult:
    def fetchone(self):
        return ("WAL",)

class Connection:
    def execute(self, statement):
        assert statement == "PRAGMA journal_mode"
        return JournalModeResult()

assert module._session_state_journal_mode(SimpleNamespace(_conn=Connection())) == "wal"
`;
    const result = spawnSync("python3", ["-I", "-c", behavior, probes], {
      encoding: "utf8",
      timeout: 5000,
    });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("keeps cross-identity ledger probes consolidated below the Docker layer-depth ceiling", () => {
    const runInstructions = dockerfileInstructions(dockerfile).filter(({ text }) =>
      text.startsWith("RUN "),
    );
    const layersFor = (family: "cron" | "discord") =>
      runInstructions.filter(({ text }) => text.includes(`${imageProbePath} ${family}-`));
    const sessionStateLayers = runInstructions.filter(({ text }) =>
      text.includes(`${imageProbePath} session-state-`),
    );

    expect({
      cron: layersFor("cron").length,
      discord: layersFor("discord").length,
      sessionState: sessionStateLayers.length,
    }).toEqual({ cron: 2, discord: 2, sessionState: 1 });
    expect(sessionStateLayers[0]?.start).toBe(
      layersFor("cron").find(({ text }) => text.includes(`${imageProbePath} cron-create`))?.start,
    );
    expect(sessionStateLayers[0]?.text).toContain("rm -f /sandbox/.hermes/runtime/state.db");
    const pluginIsolationLayer = runInstructions.find(({ text }) =>
      text.includes("nemoclaw-hostile-user-plugin"),
    );
    const pluginIsolationText = pluginIsolationLayer?.text ?? "";
    const pluginStateCleanup = "rm -f /sandbox/.hermes/runtime/state.db";
    expect(pluginIsolationText.lastIndexOf(pluginStateCleanup)).toBeGreaterThan(
      pluginIsolationText.lastIndexOf("discover_plugins()"),
    );
    expect(pluginIsolationText).toContain("/sandbox/.hermes/runtime/state.db");
    expect(pluginIsolationText).toContain("/sandbox/.hermes/runtime/state.db-wal");
    expect(pluginIsolationText).toContain("/sandbox/.hermes/runtime/state.db-shm");
    expect(pluginIsolationText).not.toContain("/sandbox/.hermes/runtime/state.db*");
    expect(dockerfile).toContain('rm -f "/sandbox/.hermes/runtime/${name}"');
    expect(dockerfile).toContain("check_absent /sandbox/.hermes/runtime/state.db");
  });

  it("does not normalize modes on removed Hermes compatibility patchers", () => {
    const modeInstruction = dockerfileInstructions(dockerfile).find(({ text }) =>
      text.startsWith("RUN chmod 755 /usr/local/bin/nemoclaw-start "),
    );

    expect(modeInstruction?.text).toBeDefined();
    expect(modeInstruction?.text).not.toContain(
      "/usr/local/lib/nemoclaw/patch-hermes-session-list-preview.py",
    );
    expect(modeInstruction?.text).not.toContain(
      "/usr/local/lib/nemoclaw/patch-hermes-profile-policy-defaults.py",
    );
  });

  it.each(commands)(
    "uses a checked-in probe runner instead of builder-dependent heredocs [case %#] (#7981)",
    (command) => {
      expect(dockerfile).not.toMatch(/<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/u);
      expect(dockerfile).toMatch(
        /^COPY agents\/hermes\/image-build-probes[.]py .* \/opt\/nemoclaw-hermes-config\/$/mu,
      );
      const normalizedDockerfile = dockerfile.replace(/\\\n/gu, "").replace(/\s+/gu, " ");

      expect(normalizedDockerfile).toContain(`${imageProbePath} ${command}`);

      const removal = dockerfile.indexOf(`rm -f ${imageProbePath}`);
      expect(removal).toBeGreaterThan(dockerfile.indexOf(`${imageProbePath} discord-reopen`));
      expect(dockerfile.indexOf(`check_absent ${imageProbePath}`)).toBeGreaterThan(removal);
    },
  );

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
