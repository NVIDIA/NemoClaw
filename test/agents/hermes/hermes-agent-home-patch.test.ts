// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const root = path.join(import.meta.dirname, "../../..");
const patcher = path.join(root, "agents", "hermes", "patch-agent-home.py");
const fixtures: string[] = [];
const systemPromptFallback = "        return Path(db_path).parent if db_path else None\n";
const botModeFallback = "            return str(Path(db_path).parent)\n";

const systemPromptSource = `from __future__ import annotations

from pathlib import Path
from typing import Any, Optional


def _agent_home(agent: Any) -> Optional[Path]:
    try:
        db_path = getattr(getattr(agent, "_session_db", None), "db_path", None)
${systemPromptFallback}    except Exception:
        return None


def _agent_skills_dir(agent: Any) -> Optional[Path]:
    home = _agent_home(agent)
    return home / "skills" if home is not None else None
`;

const botModeSource = `from __future__ import annotations

import contextlib
from pathlib import Path
from typing import Any


def _default_home() -> str:
    return "ambient-home"


def _agent_home(agent: Any) -> str:
    with contextlib.suppress(Exception):
        db_path = getattr(getattr(agent, "_session_db", None), "db_path", None)
        if db_path:
${botModeFallback}    return _default_home()


def _session_title(agent: Any) -> str:
    return ""
`;

const ledgerProbe = `
import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


system_prompt = load("patched_system_prompt", sys.argv[1])
bot_mode_dm = load("patched_bot_mode_dm", sys.argv[2])
home = Path(sys.argv[3]) / ".hermes"
(home / "runtime").mkdir(parents=True)
link = home / "state.db"
system_prompt._NEMOCLAW_SHARED_STATE_LINK = link
bot_mode_dm._NEMOCLAW_SHARED_STATE_LINK = link


def homes(db_path):
    agent = SimpleNamespace(_session_db=SimpleNamespace(db_path=db_path))
    return [
        str(Path(str(system_prompt._agent_home(agent))).relative_to(home.parent)),
        str(Path(bot_mode_dm._agent_home(agent)).relative_to(home.parent)),
    ]


ledger = home / "runtime" / "state.db"
observed = {"missing link": homes(ledger)}
link.symlink_to("runtime/state.db")
observed["linked ledger"] = homes(ledger)
observed["named profile"] = homes(home / "profiles" / "work" / "state.db")
link.unlink()
link.symlink_to("other/state.db")
observed["other link target"] = homes(ledger)
print(json.dumps(observed))
`;

function fixtureFiles(systemPrompt = systemPromptSource, botMode = botModeSource) {
  const fixture = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-agent-home-")),
  );
  fixtures.push(fixture);
  const systemPromptModule = path.join(fixture, "system_prompt.py");
  const botModeModule = path.join(fixture, "bot_mode_dm.py");
  fs.writeFileSync(systemPromptModule, systemPrompt);
  fs.writeFileSync(botModeModule, botMode);
  return { botModeModule, fixture, systemPromptModule };
}

function runPatcher(systemPromptModule: string, botModeModule: string) {
  return spawnSync(
    "python3",
    [
      "-I",
      patcher,
      "--system-prompt-path",
      systemPromptModule,
      "--bot-mode-dm-path",
      botModeModule,
    ],
    { encoding: "utf8", timeout: 5000 },
  );
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

describe("Hermes agent-home patch", () => {
  it("maps only the linked default-profile ledger to the Hermes home", () => {
    const { botModeModule, fixture, systemPromptModule } = fixtureFiles();

    const result = runPatcher(systemPromptModule, botModeModule);

    expect(result.status, result.stderr).toBe(0);
    const probe = spawnSync(
      "python3",
      ["-I", "-c", ledgerProbe, systemPromptModule, botModeModule, fixture],
      { encoding: "utf8", timeout: 5000 },
    );
    expect(probe.status, probe.stderr).toBe(0);
    expect(JSON.parse(probe.stdout)).toEqual({
      "linked ledger": [".hermes", ".hermes"],
      "missing link": [".hermes/runtime", ".hermes/runtime"],
      "named profile": [".hermes/profiles/work", ".hermes/profiles/work"],
      "other link target": [".hermes/runtime", ".hermes/runtime"],
    });
  });

  it("leaves both modules unchanged when they are already patched", () => {
    const { botModeModule, systemPromptModule } = fixtureFiles();
    expect(runPatcher(systemPromptModule, botModeModule).status).toBe(0);
    const patchedSystemPrompt = fs.readFileSync(systemPromptModule, "utf8");
    const patchedBotMode = fs.readFileSync(botModeModule, "utf8");

    const result = runPatcher(systemPromptModule, botModeModule);

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(systemPromptModule, "utf8")).toBe(patchedSystemPrompt);
    expect(fs.readFileSync(botModeModule, "utf8")).toBe(patchedBotMode);
    expect(patchedSystemPrompt).not.toBe(systemPromptSource);
    expect(patchedBotMode).not.toBe(botModeSource);
  });

  it.each([
    [
      "missing system prompt ledger fallback",
      systemPromptSource.replace(systemPromptFallback, "        return None\n"),
      botModeSource,
    ],
    [
      "duplicate system prompt ledger fallback",
      `${systemPromptSource}\n\n${systemPromptSource}`,
      botModeSource,
    ],
    [
      "missing Bot Mode DM ledger fallback",
      systemPromptSource,
      botModeSource.replace(botModeFallback, "            return str(db_path)\n"),
    ],
  ])("rejects a %s without writing either module", (_case, systemPrompt, botMode) => {
    const { botModeModule, systemPromptModule } = fixtureFiles(systemPrompt, botMode);

    const result = runPatcher(systemPromptModule, botModeModule);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("agent-home shape changed");
    expect(fs.readFileSync(systemPromptModule, "utf8")).toBe(systemPrompt);
    expect(fs.readFileSync(botModeModule, "utf8")).toBe(botMode);
  });
});
