// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const PATCH = path.join(ROOT, "agents", "hermes", "whatsapp-proxy.patch");

it("stores Hermes dashboard pairing state in the gateway session directory (#8184)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-whatsapp-dashboard-"));
  const source = path.join(tmp, "hermes_cli", "web_server.py");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(
    source,
    "from pathlib import Path\nfrom typing import Any\n" +
      `${"\n".repeat(9720)}def _whatsapp_session_path() -> Path:\n` +
      "    from hermes_constants import get_hermes_dir\n\n" +
      '    return get_hermes_dir("platforms/whatsapp/session", "whatsapp/session")\n\n\n' +
      "def _whatsapp_phone_from_identifier(value: Any) -> str | None:\n" +
      "    return None\n",
  );

  try {
    const applied = spawnSync("git", ["apply", "--include=hermes_cli/web_server.py", PATCH], {
      cwd: tmp,
      encoding: "utf8",
    });
    expect(applied.status, applied.stderr).toBe(0);
    const invoked = spawnSync(
      "python3",
      [
        "-I",
        "-c",
        [
          "import importlib.util",
          "import pathlib",
          "import sys",
          'spec = importlib.util.spec_from_file_location("hermes_web_server", sys.argv[1])',
          "module = importlib.util.module_from_spec(spec)",
          "spec.loader.exec_module(module)",
          "session_path = module._whatsapp_session_path()",
          "assert isinstance(session_path, pathlib.Path)",
          "print(session_path)",
        ].join("\n"),
        source,
      ],
      { encoding: "utf8" },
    );
    expect(invoked.status, invoked.stderr).toBe(0);
    expect(invoked.stdout.trim()).toBe("/sandbox/.hermes/platforms/whatsapp/session");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
