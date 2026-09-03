// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { dockerfileInstructions } from "../../../src/lib/onboard/dockerfile-tool-disclosure-contract";

const root = path.join(import.meta.dirname, "../../..");
const dockerfile = fs.readFileSync(path.join(root, "agents", "hermes", "Dockerfile"), "utf8");
const probes = path.join(root, "agents", "hermes", "image-build-probes.py");
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
] as const;

describe("Hermes image build probes", () => {
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
    expect(sessionStateLayers[0]?.text).toContain(
      "rm -f /sandbox/.hermes/runtime/state.db",
    );
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

  it.each(commands)(
    "uses a checked-in probe runner instead of builder-dependent heredocs [case %#] (#7981)",
    (command) => {
      expect(dockerfile).not.toMatch(/<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/u);
      expect(dockerfile).toContain(`COPY agents/hermes/image-build-probes.py ${imageProbePath}`);
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
