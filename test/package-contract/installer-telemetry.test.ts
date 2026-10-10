// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
const require = createRequire(import.meta.url);
const { isOperationEvent } =
  require("../../dist/lib/domain/telemetry/schema.js") as typeof import("../../src/lib/domain/telemetry/schema");

const INSTALLER = path.join(import.meta.dirname, "../..", "install.sh");

it("skips telemetry for Station validation without onboarding (#12859)", () => {
  const result = spawnSync(
    "bash",
    [
      "-c",
      'source "$INSTALLER_UNDER_TEST"; _installer_telemetry_begin before; [[ "${_INSTALLER_TELEMETRY_ACTIVE:-}" != true && -z "${NEMOCLAW_TELEMETRY_CONTEXT_DIR:-}" ]]',
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CI: "",
        GITHUB_ACTIONS: "",
        VITEST: "",
        NODE_ENV: "",
        NEMOCLAW_TELEMETRY_TEST_LABEL: "qa-telemetry:client:attempt-1",
        NEMOCLAW_TELEMETRY_CONTEXT_DIR: "",
        FORCE_STATION_INSTALL: "1",
        INSTALLER_UNDER_TEST: INSTALLER,
      },
    },
  );
  expect(result.status, result.stderr).toBe(0);
});

it.each([
  { name: "shell exit 0", exitCode: 0, outcome: "completed", state: "applied", lifecycle: false },
  {
    name: "shell exit 10",
    exitCode: 10,
    outcome: "unverified",
    state: "pending",
    lifecycle: false,
  },
  {
    name: "shell exit 11",
    exitCode: 11,
    outcome: "unverified",
    state: "pending",
    lifecycle: false,
  },
  {
    name: "successful installer lifecycle",
    exitCode: 0,
    outcome: "completed",
    state: "applied",
    lifecycle: true,
  },
  {
    name: "installer host failure after telemetry starts",
    exitCode: 47,
    outcome: "failed",
    state: "unchanged",
    lifecycle: true,
  },
])(
  "delivers one installer record for $name (#12859)",
  async ({ exitCode, outcome, state, lifecycle }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-installer-telemetry-"));
    const receipts = path.join(root, "received.ndjson");
    const sourceRoot = path.join(import.meta.dirname, "../..");
    const entry = path.join(sourceRoot, "dist/lib/cli/installer-telemetry-entry.js");
    const adapter = path.join(sourceRoot, "dist/lib/adapters/telemetry/http.js");
    const identity = JSON.parse(
      fs.readFileSync(path.join(sourceRoot, "dist/build-identity.json"), "utf8"),
    ) as { nemoclawVersion: string };
    const preload = path.join(root, "local-receiver.cjs");
    const trace = path.join(root, "delivery-trace.log");
    const stubScripts = path.join(root, "scripts");
    const fakeCli = path.join(root, "nemoclaw");
    fs.mkdirSync(stubScripts);
    fs.writeFileSync(path.join(stubScripts, "setup-jetson.sh"), "#!/usr/bin/env bash\nexit 0\n");
    fs.writeFileSync(fakeCli, "#!/usr/bin/env bash\nexit 0\n");
    fs.chmodSync(fakeCli, 0o755);
    fs.writeFileSync(
      preload,
      `const fs = require('node:fs');
const { TEST_TELEMETRY_ENDPOINT } = require(${JSON.stringify(adapter)});
fs.appendFileSync(process.env.NEMOCLAW_TEST_TRACE, 'loaded ' + process.argv[1] + '\\n');
const fetchOriginal = globalThis.fetch;
globalThis.fetch = (input, init) => {
  fs.appendFileSync(process.env.NEMOCLAW_TEST_TRACE, 'fetch ' + String(input) + '\\n');
  if (String(input) !== TEST_TELEMETRY_ENDPOINT) throw new Error('Unexpected network request');
  return fetchOriginal(process.env.NEMOCLAW_TEST_RECEIVER_URL, init);
};
`,
    );
    const server = new Worker(
      `const http = require('node:http');
     const fs = require('node:fs');
     const { parentPort, workerData } = require('node:worker_threads');
     const server = http.createServer((request, response) => {
       let body = '';
       request.on('data', (chunk) => { body += String(chunk); });
       request.on('end', () => {
         fs.appendFileSync(workerData.receipts, JSON.stringify({ method: request.method, body }) + '\\n');
         response.writeHead(200).end();
       });
     });
     server.listen(0, '127.0.0.1', () => parentPort.postMessage(server.address().port));
     setTimeout(() => { server.closeAllConnections(); server.close(); }, 10000).unref();`,
      { eval: true, workerData: { receipts } },
    );
    try {
      expect(fs.existsSync(entry)).toBe(true);
      const [port] = (await once(server, "message")) as [number];
      const shell = lifecycle
        ? `set -euo pipefail
source "$INSTALLER_UNDER_TEST"
SCRIPT_DIR="$TEST_SCRIPT_DIR"
apply_persisted_automatic_gateway_port() { :; }
validate_deferred_onboarding_request() { :; }
validate_forwarded_service_port_overrides() { :; }
load_station_vllm_conflict_helpers() { :; }
consume_station_local_vllm_resume() { return 1; }
resolve_nemoclaw_gateway_port() { printf '8080\\n'; }
preflight_explicit_express_flags() { :; }
validate_installer_docker_target_before_host_changes() { :; }
print_banner() { :; }
preflight_usage_notice_prompt() { :; }
prepare_installer_host() { [[ "$TEST_EXIT_CODE" != 47 ]] || return 47; }
prepare_installer_node_runtime() { :; }
ensure_station_express_pair() { :; }
step() { :; }
fix_npm_permissions() { :; }
preflight_nemoclaw_acp_shim() { :; }
preinstall_backup_and_retire_legacy_gateway() { :; }
spin() { :; }
command_exists() { [[ "$1" == git ]]; }
resolve_repo_root() { printf '%s\\n' "$NEMOCLAW_SOURCE_ROOT"; }
is_source_checkout() { return 0; }
verify_nemoclaw() { _NEMOCLAW_VERIFIED_VERSION="$EXPECTED_VERSION"; _CLI_PATH="$TEST_CLI_PATH"; }
maybe_install_openshell_during_install() { :; }
ensure_nemoclaw_shim() { :; }
refresh_path() { :; }
require_reportable_openshell_version() { :; }
registered_sandbox_count() { printf '0\\n'; }
should_defer_onboarding() { return 0; }
print_done() { :; }
main --non-interactive --yes-i-accept-third-party-software`
        : `set -euo pipefail
source "$INSTALLER_UNDER_TEST"
_NEMOCLAW_VERIFIED_VERSION="$EXPECTED_VERSION"
_installer_telemetry_begin ${exitCode === 0 ? "installed" : "before"}
[[ "$_INSTALLER_TELEMETRY_ACTIVE" == true ]]
${exitCode === 0 ? "_INSTALLER_TELEMETRY_OUTCOME=completed\n_INSTALLER_TELEMETRY_STATE=applied" : ""}
exit ${exitCode}`;
      const result = spawnSync("bash", ["-c", shell], {
        cwd: sourceRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "",
          GITHUB_ACTIONS: "",
          VITEST: "",
          NODE_ENV: "",
          NEMOCLAW_DISABLE_TELEMETRY: "",
          NEMOCLAW_TELEMETRY_TEST_LABEL: "qa-telemetry:client:attempt-1",
          NEMOCLAW_TEST_RECEIVER_URL: `http://127.0.0.1:${port}/`,
          NEMOCLAW_TEST_TRACE: trace,
          NEMOCLAW_SOURCE_ROOT: sourceRoot,
          NODE_OPTIONS: `--require=${preload}`,
          HOME: root,
          INSTALLER_UNDER_TEST: INSTALLER,
          EXPECTED_VERSION: identity.nemoclawVersion,
          TEST_SCRIPT_DIR: stubScripts,
          TEST_CLI_PATH: fakeCli,
          TEST_EXIT_CODE: String(exitCode),
        },
      });
      expect(result.status, result.stderr).toBe(exitCode);
      expect(
        fs.existsSync(receipts),
        `${result.stderr} ${fs.existsSync(trace) ? fs.readFileSync(trace, "utf8") : "no trace"}`,
      ).toBe(true);
      const requests = fs
        .readFileSync(receipts, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(requests).toHaveLength(1);
      expect(requests[0].method).toBe("POST");
      const envelope = JSON.parse(requests[0].body);
      expect(envelope.events).toHaveLength(1);
      expect(isOperationEvent(envelope.events[0])).toBe(true);
      const parameters = envelope.events[0].parameters;
      expect(parameters).toMatchObject({
        operation: "install",
        outcome,
        state,
        ...(exitCode === 0
          ? { versions: { installedStatus: "reported", targetStatus: "reported" } }
          : lifecycle
            ? { versions: { installedStatus: "not_observed", targetStatus: "not_observed" } }
            : {}),
      });
    } finally {
      await server.terminate();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  20_000,
);
