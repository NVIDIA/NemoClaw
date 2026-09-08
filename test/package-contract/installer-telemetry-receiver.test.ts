// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { INSTALLER_PAYLOAD, TEST_SYSTEM_PATH } from "../helpers/installer-sourced-env";

const REPO_ROOT = path.join(import.meta.dirname, "../..");
const COMPILED_ENTRY = path.join(REPO_ROOT, "dist/lib/cli/installer-telemetry-entry.js");

async function runInstallerTelemetry(
  sourceRoot: string,
  cliPath: string,
): Promise<{ status: number | null; output: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        `source "$INSTALLER_UNDER_TEST" >/dev/null
NEMOCLAW_SOURCE_ROOT="$SOURCE_ROOT"
_CLI_PATH="$CLI_PATH"
resolve_nemoclaw_gateway_port() { printf '18789'; }
preflight_explicit_express_flags() { :; }
print_banner() { :; }
preflight_usage_notice_prompt() { :; }
prepare_installer_host() { :; }
validate_deferred_hermes_onboarding_request() { :; }
install_nemoclaw_before_onboarding() { :; }
command_exists() { return 0; }
registered_sandbox_count() { printf '0\\n'; }
should_defer_hermes_onboarding() { return 1; }
run_installer_host_preflight() { return 0; }
recover_preexisting_sandboxes_before_onboard() { return 0; }
run_onboard() { return 0; }
restore_onboard_forward_after_post_checks() { return 0; }
finalize_install() { :; }
clear_station_resume_after_completed_onboarding() { :; }
main --non-interactive --yes-i-accept-third-party-software`,
      ],
      {
        cwd: REPO_ROOT,
        killSignal: "SIGKILL",
        signal: AbortSignal.timeout(15_000),
        env: {
          HOME: sourceRoot,
          CLI_PATH: cliPath,
          INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
          NEMOCLAW_UPDATE_INVOKED: "1",
          PATH: `${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}`,
          SOURCE_ROOT: sourceRoot,
        },
      },
    );
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, output }));
  });
}

async function listen(server: http.Server): Promise<URL> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return new URL(`http://127.0.0.1:${address.port}/events`);
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

describe("installer telemetry compiled package", () => {
  it("sends one validated update event after installer success (#10440)", async () => {
    expect(fs.existsSync(COMPILED_ENTRY), "Run `npm run build:cli` before this test.").toBe(true);

    const requests: Array<{
      method: string | undefined;
      path: string | undefined;
      contentType: string | undefined;
      body: unknown;
    }> = [];
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push({
          method: request.method,
          path: request.url,
          contentType: request.headers["content-type"],
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
        });
        response.writeHead(204).end();
      });
    });
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-telemetry-receiver-"));

    try {
      const endpoint = await listen(server);
      const entryPath = path.join(temporaryRoot, "dist/lib/cli/installer-telemetry-entry.js");
      fs.mkdirSync(path.dirname(entryPath), { recursive: true });
      const cliPath = path.join(temporaryRoot, "nemoclaw");
      fs.writeFileSync(cliPath, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
      fs.writeFileSync(
        entryPath,
        `const { runInstallerTelemetryEntry } = require(${JSON.stringify(COMPILED_ENTRY)});\n` +
          `runInstallerTelemetryEntry(process.argv.slice(2), {\n` +
          `  loadConfig: () => ({ endpoint: new URL(${JSON.stringify(endpoint.href)}) }),\n` +
          `}).catch(() => { process.exitCode = 1; });\n`,
      );

      const result = await runInstallerTelemetry(temporaryRoot, cliPath);

      expect(result.status, result.output).toBe(0);
      expect(requests).toEqual([
        {
          method: "POST",
          path: "/events",
          contentType: "application/json",
          body: {
            event: "nemoclaw_install_completed",
            operation: "update",
          },
        },
      ]);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
      await close(server);
    }
  }, 25_000);
});
