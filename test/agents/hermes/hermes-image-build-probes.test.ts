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
const baseDockerfile = fs.readFileSync(
  path.join(root, "agents", "hermes", "Dockerfile.base"),
  "utf8",
);
const a2aNeutralPatch = fs.readFileSync(path.join(root, "agents", "hermes", "a2a-neutral.patch"));
const securityDependenciesPatch = fs.readFileSync(
  path.join(root, "agents", "hermes", "security-dependencies.patch"),
  "utf8",
);
const probeSource = fs.readFileSync(probes, "utf8");
const imageProbePath = "/opt/nemoclaw-hermes-config/image-build-probes.py";
const hermesDownloaderMarker = "download-hermes-source-archive.sh invoked";
const reviewedHermesReleaseIdentities = [
  {
    label: "previous 0.20.6",
    environment: {
      HERMES_VERSION: "v2026.8.27",
      HERMES_SEMVER: "0.20.6",
      HERMES_TARBALL_SHA256: "e622723b5bf3cd6c1db974d92d32242f1cb63f61c1112b6f708b34d619ef0fc7",
      HERMES_NPM_INTEGRITY:
        "sha512-s5q1IEBifCBb77QMwkse4MRaAaoZSxIa4IkicIO3jL7MIdq15YvnSyiNvsTOWNBi6t3shFpIg+H7+9MJsOiSkg==",
    },
  },
  {
    label: "active 0.21.3",
    environment: {
      HERMES_VERSION: "v2026.9.14",
      HERMES_SEMVER: "0.21.3",
      HERMES_TARBALL_SHA256: "47df72ebd3f9c96d806a94541163f7fe7d7ce5b84f85c1d3787e6dfeea1d7834",
      HERMES_NPM_INTEGRITY:
        "sha512-LvPt2/1z6hm4pTRJu34F6uAkBVSlSt94QeZp8fMBLFqASU9/wv7iMODSGMzF1WmrpNENXYGMnWN8s9hi/EUM5Q==",
    },
  },
] as const;
const hermesReleaseIdentityFields = [
  "HERMES_VERSION",
  "HERMES_SEMVER",
  "HERMES_TARBALL_SHA256",
  "HERMES_NPM_INTEGRITY",
] as const;
type HermesReleaseIdentityEnvironment = {
  [Field in (typeof hermesReleaseIdentityFields)[number]]: string;
};
const rejectedHermesReleaseIdentities = reviewedHermesReleaseIdentities.flatMap(
  ({ label, environment }) =>
    hermesReleaseIdentityFields.map((field) => ({
      label,
      field,
      environment: {
        ...environment,
        [field]: `${environment[field]}-unreviewed`,
      },
    })),
);
const commands = [
  "auxiliary-token-limit",
  "cron-backup",
  "cron-create",
  "cron-reopen",
  "cron-runtime-source",
  "dashboard-policy",
  "discord-backup",
  "discord-create",
  "discord-recovery-source",
  "discord-reopen",
  "external-supervisor-restart",
  "gateway-process-identity",
  "gateway-runtime-metadata",
  "googlechat-override-seams",
  "langfuse-credentials",
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

function runHermesReleaseIdentityGuard(environment: HermesReleaseIdentityEnvironment) {
  const guardStartMarker =
    'RUN case "${HERMES_VERSION}|${HERMES_SEMVER}|${HERMES_TARBALL_SHA256}|${HERMES_NPM_INTEGRITY}" in';
  const guardStart = baseDockerfile.indexOf(guardStartMarker);
  const guardEndMarker = "    esac";
  const guardEnd = baseDockerfile.indexOf(guardEndMarker, guardStart);
  const guard = baseDockerfile
    .slice(guardStart + "RUN ".length, guardEnd + guardEndMarker.length)
    .replaceAll("\\", "");

  const guardedDownload = `${guard}\nprintf '%s\\n' '${hermesDownloaderMarker}'`;

  return spawnSync("bash", ["-eu", "-c", guardedDownload], {
    encoding: "utf8",
    env: { ...process.env, ...environment },
    timeout: 5000,
  });
}

function runCompatibilityRetirementProbe({
  version,
  adapter = '{"upstream_cli_version":"0.21.3","translations":{"provider_model_composition":{}}}\n',
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

function runCronRuntimeSourceProbe() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cron-source-probe-"));
  const source = `
import importlib.util
import pathlib
import sqlite3
import sys
import types

home = pathlib.Path(sys.argv[2])
database = home / "runtime" / "cron-executions.db"
database.parent.mkdir(parents=True)

cron = types.ModuleType("cron")
cron.__path__ = []
executions = types.ModuleType("cron.executions")
executions.EXECUTIONS_FILE = None
def connect():
    connection = sqlite3.connect(database)
    connection.row_factory = sqlite3.Row
    return connection
executions._connect = connect

hermes_cli = types.ModuleType("hermes_cli")
hermes_cli.__path__ = []
backup = types.ModuleType("hermes_cli.backup")
backup._QUICK_STATE_FILES = ["runtime/cron-executions.db"]

constants = types.ModuleType("hermes_constants")
constants.get_hermes_home = lambda: home

sys.modules.update({
    "cron": cron,
    "cron.executions": executions,
    "hermes_cli": hermes_cli,
    "hermes_cli.backup": backup,
    "hermes_constants": constants,
})

spec = importlib.util.spec_from_file_location("image_build_probes", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.verify_cron_runtime_source()
`;
  try {
    return spawnSync("python3", ["-I", "-c", source, probes, temporaryRoot], {
      encoding: "utf8",
      timeout: 5000,
    });
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

function runSessionDeleteProbe() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-session-delete-probe-"));
  const source = `
import importlib.util
import json
import pathlib
import sqlite3
import sys
import types

database = pathlib.Path(sys.argv[2]) / "state.db"
config = json.loads((database.parent / "config.yaml").read_text())

class SessionDB:
    def __init__(self):
        self._conn = sqlite3.connect(database)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute(f"PRAGMA temp_store={config['database']['temp_store']}")
        self._sessions = set()

    def create_session(self, session_id, _source):
        self._sessions.add(session_id)

    def append_message(self, _session_id, _role, _content):
        pass

    def delete_session(self, session_id):
        self._sessions.remove(session_id)
        return True

    def list_sessions_rich(self, limit):
        return [{"id": session_id} for session_id in list(self._sessions)[:limit]]

hermes_state = types.ModuleType("hermes_state")
hermes_state.SessionDB = SessionDB
sys.modules["hermes_state"] = hermes_state

spec = importlib.util.spec_from_file_location("image_build_probes", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.verify_session_delete()
`;
  try {
    fs.writeFileSync(
      path.join(temporaryRoot, "config.yaml"),
      JSON.stringify({ database: { temp_store: 2 } }),
    );
    return spawnSync("python3", ["-I", "-c", source, probes, temporaryRoot], {
      encoding: "utf8",
      timeout: 5000,
    });
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

function runGoogleChatOverrideSeamsProbe() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-googlechat-seams-"));
  const adapter = path.join(temporaryRoot, "adapter.py");
  fs.writeFileSync(
    adapter,
    `
def _validate_config(self) -> Tuple[str, Optional[str]]:
    pass
def _load_sa_credentials(self) -> Any:
    pass
def _new_authed_http(self) -> Any:
    pass
async def connect(self, *, is_reconnect: bool = False) -> bool:
    if subscription_path is not None and not await self._check_subscription(subscription_path, credentials):
        return False
    self._supervisor_task = asyncio.create_task(self._run_supervisor()) if subscription_path is not None else None
`,
  );
  const source = `
import importlib.util
import pathlib
import sys

spec = importlib.util.spec_from_file_location("image_build_probes", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.verify_googlechat_override_seams(pathlib.Path(sys.argv[2]))
`;
  try {
    return spawnSync("python3", ["-I", "-c", source, probes, adapter], {
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
test "$#" -eq 1
test "$1" = "${generator}"
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

describe("Hermes image build probes", () => {
  it("keeps the active Hermes release defaults pinned to exact 0.21.3 identity", () => {
    const currentIdentity = reviewedHermesReleaseIdentities[1].environment;

    expect(baseDockerfile).toContain(`ARG HERMES_VERSION=${currentIdentity.HERMES_VERSION}`);
    expect(baseDockerfile).toContain(`ARG HERMES_SEMVER=${currentIdentity.HERMES_SEMVER}`);
    expect(baseDockerfile).toContain(
      `ARG HERMES_TARBALL_SHA256=${currentIdentity.HERMES_TARBALL_SHA256}`,
    );
    expect(baseDockerfile).toContain(
      `ARG HERMES_NPM_INTEGRITY=${currentIdentity.HERMES_NPM_INTEGRITY}`,
    );
  });

  it("pins the image dependency probe to the exact Hermes 0.21.3 lock", () => {
    expect(baseDockerfile).toContain("'tornado': '6.5.8'");
    expect(baseDockerfile).not.toContain("'tornado': '6.5.7'");
    expect(baseDockerfile).toContain("from tools.browser_tool_install import _find_agent_browser");
    expect(baseDockerfile).not.toContain("browser_tool._find_agent_browser() ");
  });

  it("pins the inherited Hindsight lazy dependency before the final image verifies it", () => {
    expect(securityDependenciesPatch).toContain(
      '-  - "hindsight-client>=0.6.1"\n+  - "hindsight-client==0.6.1"',
    );
    expect(dockerfile).toContain(
      "grep -Fqx '  - \"hindsight-client==0.6.1\"' /opt/hermes/plugins/memory/hindsight/plugin.yaml",
    );
  });

  it("accepts the Hermes SQLite row factory when verifying the cron database path", () => {
    const result = runCronRuntimeSourceProbe();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("accepts the Hermes SQLite row factory when verifying session deletion", () => {
    const result = runSessionDeleteProbe();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(dockerfile).toContain(
      `printf '%s\\n' 'database:' '  temp_store: 2' > "$session_probe_home/config.yaml"`,
    );
  });

  it("accepts the Hermes 0.21.3 Google Chat override seams", () => {
    const result = runGoogleChatOverrideSeamsProbe();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("accepts the exact previous 0.20.6 Hermes release identity tuple", () => {
    const result = runHermesReleaseIdentityGuard(reviewedHermesReleaseIdentities[0].environment);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(hermesDownloaderMarker);
  });

  it("accepts the exact active 0.21.3 Hermes release identity tuple", () => {
    const result = runHermesReleaseIdentityGuard(reviewedHermesReleaseIdentities[1].environment);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(hermesDownloaderMarker);
  });

  it.each(rejectedHermesReleaseIdentities)(
    "rejects altered $field from the $label Hermes release identity tuple",
    ({ field, environment }) => {
      const result = runHermesReleaseIdentityGuard(environment);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("ERROR: unreviewed Hermes release identity tuple");
      expect(result.stderr).not.toContain(environment[field]);
      expect(result.stdout).not.toContain(hermesDownloaderMarker);
    },
  );

  // source-shape-contract: security -- The final image must bind the image-build probes and cron restore controller to their reviewed source digests
  it("binds the image build probes and cron restore controller to their source digests", () => {
    const imageDockerfile = fs.readFileSync(
      path.join(import.meta.dirname, "../../../agents/hermes/Dockerfile"),
      "utf8",
    );
    const imageBuildProbes = fs.readFileSync(
      path.join(import.meta.dirname, "../../../agents/hermes/image-build-probes.py"),
    );
    const digest = createHash("sha256").update(imageBuildProbes).digest("hex");
    const digestBinding = `ARG NEMOCLAW_HERMES_IMAGE_BUILD_PROBES_SHA256=${digest}`;
    const cronRestoreControl = fs.readFileSync(
      path.join(import.meta.dirname, "../../../agents/hermes/cron-restore-control.py"),
    );
    const cronRestoreDigest = createHash("sha256").update(cronRestoreControl).digest("hex");

    expect(imageDockerfile).toContain(digestBinding);
    expect(imageDockerfile).toContain(
      `ARG NEMOCLAW_HERMES_CRON_RESTORE_CONTROLLER_SHA256=${cronRestoreDigest}`,
    );
    expect(
      Array.from(
        imageDockerfile.matchAll(
          /^ARG NEMOCLAW_HERMES_IMAGE_BUILD_PROBES_SHA256=([0-9a-f]{64})$/gmu,
        ),
        (match) => match[1],
      ),
    ).toEqual([digest, digest]);
    const normalizedDockerfile = imageDockerfile.replace(/\\\n/gu, " ");
    expect(normalizedDockerfile).toContain("install -d -o root -g root -m 0755 /etc/nemoclaw");
    expect(normalizedDockerfile).toMatch(
      /touch \/etc\/nemoclaw\/hermes-mcp-transaction\.lock[\s\S]*chown root:root[\s\S]*\/etc\/nemoclaw\/hermes-mcp-transaction\.lock[\s\S]*chmod 444[\s\S]*\/etc\/nemoclaw\/hermes-mcp-transaction\.lock/u,
    );
    expect(normalizedDockerfile).toContain(
      "check_metadata /etc/nemoclaw/hermes-mcp-transaction.lock 'root:root 444'",
    );
  });

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

  it("keeps profile policy patch verification and application in one layer", () => {
    const digest = "$NEMOCLAW_HERMES_PROFILE_POLICY_PATCHER_SHA256";
    const invocation =
      "/usr/bin/python3 -I /opt/nemoclaw-hermes-config/patch-profile-policy-defaults.py";
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

  it("rejects an adapter for a different Hermes version", () => {
    const result = runCompatibilityRetirementProbe({ version: "hermes v0.21.2" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("installed Hermes 0.21.2 but the CLI adapter targets 0.21.3");
  });

  it("rejects the retired resumed one-shot translation", () => {
    const result = runCompatibilityRetirementProbe({
      version: "hermes v0.21.3",
      adapter:
        '{"upstream_cli_version":"0.21.3","translations":{"provider_model_composition":{},"resumed_oneshot":{}}}\n',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "retired resumed one-shot compatibility translation is still installed",
    );
  });

  it("accepts the reviewed Hermes version and exact one-shot completion scope", () => {
    const result = runCompatibilityRetirementProbe({ version: "hermes v0.21.3" });

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

  it("keeps state ledger probes consolidated below the Docker layer-depth ceiling", () => {
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
