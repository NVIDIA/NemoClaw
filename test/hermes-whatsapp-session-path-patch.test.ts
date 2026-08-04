// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  CANONICAL_SESSION_PATH,
  patchAdapterSource,
  patchMainSource,
  patchWebServerSource,
} from "../agents/hermes/patch-whatsapp-session-path.mts";

const ADAPTER_FIXTURE = `        self._session_path: Path = Path(config.extra.get(
            "session_path",
            get_hermes_dir("platforms/whatsapp/session", "whatsapp/session")
        ))
`;

const WEB_SERVER_FIXTURE = `def _whatsapp_session_path() -> Path:
    from hermes_constants import get_hermes_dir

    return get_hermes_dir("platforms/whatsapp/session", "whatsapp/session")

def _spawn():
    return subprocess.Popen(
        ["node", "bridge.js"],
        start_new_session=True,
        env=env,
        creationflags=windows_hide_flags(),
    )
`;

const MAIN_FIXTURE = `def cmd_whatsapp():
    session_dir = get_hermes_home() / "whatsapp" / "session"
    try:
        subprocess.run(
            [
                "node",
                "bridge.js",
                "--session",
                str(session_dir),
            ],
            cwd=str(bridge_dir),
            env=with_hermes_node_path(),
        )
`;

const patchers = {
  adapter: patchAdapterSource,
  webServer: patchWebServerSource,
  main: patchMainSource,
};

describe("Hermes WhatsApp session location", () => {
  it.each([
    ["gateway adapter", "adapter", ADAPTER_FIXTURE],
    ["dashboard QR pairing", "webServer", WEB_SERVER_FIXTURE],
    ["CLI QR pairing", "main", MAIN_FIXTURE],
  ] as const)("uses the manifest-owned durable directory for %s (#8184)", (_label, kind, fixture) => {
    const result = patchers[kind](fixture);

    expect(result).toContain(CANONICAL_SESSION_PATH);
    expect(result).not.toContain('get_hermes_dir("platforms/whatsapp/session"');
    expect(result).not.toContain('get_hermes_home() / "whatsapp" / "session"');
  });

  it("preserves the explicit adapter session path override (#8184)", () => {
    expect(patchAdapterSource(ADAPTER_FIXTURE)).toContain(
      'config.extra.get(\n            "session_path"',
    );
  });

  it.each([
    ["dashboard", patchWebServerSource, WEB_SERVER_FIXTURE],
    ["CLI", patchMainSource, MAIN_FIXTURE],
  ] as const)("preserves shared-group access when %s pairing creates session state (#8184)", (_label, patcher, fixture) => {
    expect(patcher(fixture)).toContain("umask=0o007");
  });

  it.each([
    ["adapter", ADAPTER_FIXTURE.replace('"whatsapp/session"', '"changed/session"')],
    ["webServer", WEB_SERVER_FIXTURE.replace('"whatsapp/session"', '"changed/session"')],
    ["webServer", WEB_SERVER_FIXTURE.replace("creationflags=", "changed_creationflags=")],
    ["main", MAIN_FIXTURE.replace('"whatsapp"', '"changed"')],
    ["main", MAIN_FIXTURE.replace("env=with_hermes_node_path()", "changed_env=True")],
  ] as const)("fails closed when the pinned %s pairing source changes", (kind, fixture) => {
    expect(() => patchers[kind](fixture)).toThrow("source shape changed");
  });
});
