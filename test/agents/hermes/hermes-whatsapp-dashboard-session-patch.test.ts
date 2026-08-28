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
    `${"\n".repeat(8109)}def _whatsapp_session_path() -> Path:\n` +
      "    from hermes_constants import get_hermes_dir\n\n" +
      '    return get_hermes_dir("platforms/whatsapp/session", "whatsapp/session")\n\n',
  );

  try {
    const applied = spawnSync("git", ["apply", "--include=hermes_cli/web_server.py", PATCH], {
      cwd: tmp,
      encoding: "utf8",
    });
    expect(applied.status, applied.stderr).toBe(0);
    const patched = fs.readFileSync(source, "utf8");
    expect(patched).toContain('return Path("/sandbox/.hermes/platforms/whatsapp/session")');
    expect(patched).not.toContain("get_hermes_dir");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

it("leaves the Hermes CLI and gateway unpatched (#8184)", () => {
  const patch = fs.readFileSync(PATCH, "utf8");
  expect(patch).not.toContain("diff --git a/hermes_cli/main.py");
  expect(patch).not.toContain("diff --git a/gateway/");
});
