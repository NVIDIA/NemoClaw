// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const PATCH = path.join(ROOT, "agents", "hermes", "whatsapp-proxy.patch");
const DASHBOARD_PATCH = path.join(ROOT, "agents", "hermes", "dashboard-external-host.patch");

const dashboardSourceVariants = [
  {
    label: "published 0.20.6 base layout",
    loopbackDeclaration:
      '_LOOPBACK_HOST_VALUES: frozenset = frozenset({\n    "localhost", "127.0.0.1", "::1",\n})',
  },
  {
    label: "active 0.21.3 source layout",
    loopbackDeclaration:
      '_LOOPBACK_HOST_VALUES: frozenset = frozenset({"localhost", "127.0.0.1", "::1"})',
  },
] as const;

it.each(dashboardSourceVariants)(
  "applies the dashboard external Host guard to the $label",
  ({ loopbackDeclaration }) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-dashboard-host-"));
    const source = path.join(tmp, "hermes_cli", "web_server.py");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(
      source,
      [
        "import os",
        "",
        loopbackDeclaration,
        "",
        "",
        "def _dashboard_public_hosts() -> frozenset[str]:",
        "    return frozenset()",
        "",
        "",
        "def _is_accepted_host(host_only: str, bound_host: str) -> bool:",
        "    bound_lc = bound_host.lower()",
        "    if bound_lc in _LOOPBACK_HOST_VALUES:",
        "        return host_only in _LOOPBACK_HOST_VALUES",
        "    return host_only == bound_lc",
        "",
      ].join("\n"),
    );

    try {
      const applied = spawnSync(
        "git",
        ["apply", "--include=hermes_cli/web_server.py", DASHBOARD_PATCH],
        {
          cwd: tmp,
          encoding: "utf8",
        },
      );
      expect(applied.status, applied.stderr).toBe(0);
      const patched = fs.readFileSync(source, "utf8");
      expect(patched).toContain(
        '_NEMOCLAW_DASHBOARD_EXTERNAL_HOST_ENV = "_NEMOCLAW_HERMES_DASHBOARD_EXTERNAL_HOST"',
      );
      expect(patched).toContain("if external_host and host_only == external_host:");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  },
);

it("stores Hermes dashboard pairing state in the gateway session directory (#8184)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-whatsapp-dashboard-"));
  const source = path.join(tmp, "hermes_cli", "web_server_messaging.py");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(
    source,
    "from pathlib import Path\nfrom typing import Any\nclass _WhatsAppOnboardingSession: pass\n" +
      `${"\n".repeat(347)}_whatsapp_onboarding_sessions: dict[str, _WhatsAppOnboardingSession] = {}\n\n\n` +
      "def _whatsapp_session_path() -> Path:\n" +
      "    from hermes_constants import get_hermes_dir\n" +
      '    return get_hermes_dir("platforms/whatsapp/session", "whatsapp/session")\n\n\n' +
      "_WHATSAPP_PAYLOAD_FIELDS = (\n)\n\n\n" +
      "def _whatsapp_phone_from_identifier(value: Any) -> str | None:\n" +
      "    return None\n",
  );

  try {
    const applied = spawnSync(
      "git",
      ["apply", "--include=hermes_cli/web_server_messaging.py", PATCH],
      {
        cwd: tmp,
        encoding: "utf8",
      },
    );
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
