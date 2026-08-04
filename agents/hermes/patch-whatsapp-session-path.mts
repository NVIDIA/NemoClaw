// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Keep pinned Hermes WhatsApp pairing state in one durable directory.
 *
 * Hermes v0.19.0 resolves WhatsApp session state relative to each process's
 * `HERMES_HOME`. NemoClaw gives the dashboard an isolated home, so dashboard QR
 * pairing writes credentials that the gateway cannot read. The interactive
 * `hermes whatsapp` command also uses the legacy `whatsapp/session` path.
 *
 * Patch the dashboard onboarding handler, gateway adapter, and CLI command to use
 * the manifest-owned `/sandbox/.hermes/platforms/whatsapp/session` directory.
 * Dashboard and CLI pairing child processes use umask 0007 so the Hermes gateway
 * user can read pairing state through the shared sandbox group. Other processes
 * keep their inherited umask.
 * The Dockerfile binds each input to its reviewed source hash. Remove this patch
 * when the minimum supported Hermes release provides one authoritative WhatsApp
 * session path for these three consumers.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

export const CANONICAL_SESSION_PATH = "/sandbox/.hermes/platforms/whatsapp/session";

const EXPECTED_SOURCE_SHA256 = {
  adapter: "96730b2261eed2eb34affd1cec980a039c8cb8a7cc864b798b6e1b7f17a354a9",
  webServer: "0bf9d4dd17a1b7c3d96c94dacea9884426e7bbb5c8818685b43ef68f2465b3f2",
  // patch-profile-policy-defaults.py changes independent update-policy code first.
  main: "18bab193cf86e1198bcea7ca09f62b88f1d30615aeed367b88388de21c3723c0",
} as const;

const ADAPTER_OLD = `        self._session_path: Path = Path(config.extra.get(
            "session_path",
            get_hermes_dir("platforms/whatsapp/session", "whatsapp/session")
        ))
`;
const ADAPTER_NEW = `        self._session_path: Path = Path(config.extra.get(
            "session_path",
            # NemoClaw keeps WhatsApp pairing credentials in manifest-owned durable state.
            "${CANONICAL_SESSION_PATH}"
        ))
`;

const WEB_SERVER_OLD = `def _whatsapp_session_path() -> Path:
    from hermes_constants import get_hermes_dir

    return get_hermes_dir("platforms/whatsapp/session", "whatsapp/session")
`;
const WEB_SERVER_NEW = `def _whatsapp_session_path() -> Path:
    # NemoClaw isolates the dashboard home from gateway configuration and state.
    return Path("${CANONICAL_SESSION_PATH}")
`;
const WEB_SERVER_POPEN_OLD = `        start_new_session=True,
        env=env,
        creationflags=windows_hide_flags(),
`;
const WEB_SERVER_POPEN_NEW = `        start_new_session=True,
        env=env,
        # Preserve pairing-state group access for the Hermes gateway user in the shared sandbox group.
        umask=0o007,
        creationflags=windows_hide_flags(),
`;

const MAIN_OLD = `    session_dir = get_hermes_home() / "whatsapp" / "session"
`;
const MAIN_NEW = `    # NemoClaw keeps CLI and dashboard pairing in the gateway's durable state.
    session_dir = Path("${CANONICAL_SESSION_PATH}")
`;
const MAIN_PAIRING_PROCESS_OLD = `                str(session_dir),
            ],
            cwd=str(bridge_dir),
            env=with_hermes_node_path(),
        )
`;
const MAIN_PAIRING_PROCESS_NEW = `                str(session_dir),
            ],
            cwd=str(bridge_dir),
            env=with_hermes_node_path(),
            # Preserve pairing-state group access for the Hermes gateway user in the shared sandbox group.
            umask=0o007,
        )
`;

function sha256(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function replaceExact(source: string, oldValue: string, newValue: string, label: string): string {
  const oldCount = source.split(oldValue).length - 1;
  const newCount = source.split(newValue).length - 1;
  if (oldCount !== 1 || newCount !== 0) {
    throw new Error(
      `Hermes ${label} source shape changed: expected one unpatched occurrence, found ${oldCount}; prepatched occurrences: ${newCount}`,
    );
  }
  return source.replace(oldValue, newValue);
}

export function patchAdapterSource(source: string): string {
  return replaceExact(source, ADAPTER_OLD, ADAPTER_NEW, "WhatsApp adapter");
}

export function patchWebServerSource(source: string): string {
  const patchedPath = replaceExact(source, WEB_SERVER_OLD, WEB_SERVER_NEW, "WhatsApp dashboard");
  return replaceExact(
    patchedPath,
    WEB_SERVER_POPEN_OLD,
    WEB_SERVER_POPEN_NEW,
    "WhatsApp dashboard pairing process",
  );
}

export function patchMainSource(source: string): string {
  const patchedPath = replaceExact(source, MAIN_OLD, MAIN_NEW, "WhatsApp CLI");
  return replaceExact(
    patchedPath,
    MAIN_PAIRING_PROCESS_OLD,
    MAIN_PAIRING_PROCESS_NEW,
    "WhatsApp CLI pairing process",
  );
}

function patchFile(
  sourcePath: string,
  kind: keyof typeof EXPECTED_SOURCE_SHA256,
  patcher: (source: string) => string,
): void {
  const source = fs.readFileSync(sourcePath, "utf8");
  const actualSha256 = sha256(source);
  const expectedSha256 = EXPECTED_SOURCE_SHA256[kind];
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `${sourcePath} is not the reviewed Hermes v2026.7.20 ${kind} source; expected sha256 ${expectedSha256}, got ${actualSha256}`,
    );
  }
  fs.writeFileSync(sourcePath, patcher(source), "utf8");
}

function main(): void {
  const { values } = parseArgs({
    options: {
      adapter: {
        type: "string",
        default: "/opt/hermes/plugins/platforms/whatsapp/adapter.py",
      },
      "web-server": {
        type: "string",
        default: "/opt/hermes/hermes_cli/web_server.py",
      },
      main: { type: "string", default: "/opt/hermes/hermes_cli/main.py" },
    },
    strict: true,
  });

  patchFile(values.adapter, "adapter", patchAdapterSource);
  patchFile(values["web-server"], "webServer", patchWebServerSource);
  patchFile(values.main, "main", patchMainSource);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
