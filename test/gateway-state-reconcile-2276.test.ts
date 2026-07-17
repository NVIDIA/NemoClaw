// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Cross-command regression contract for issues #2276 and #4497. Direct
// gateway-state, status, and skill-action tests own the individual lifecycle
// decisions; this file retains the one process boundary that proves a failed
// `connect` preserves enough local state for a subsequent `rebuild --yes`.
// See gateway-state-drift.test.ts, status-flow.test.ts,
// gateway-runtime-action.test.ts, skill-install.test.ts, and the typed skill
// command adapter tests for scenarios 1-12.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { testTimeout } from "./helpers/timeouts";

const TIMEOUT_MS = testTimeout(20_000);
const SANDBOX_NAME = "my-assistant";

// Output fixtures that mirror real OpenShell CLI output.
const GATEWAY_INFO_NEMOCLAW =
  "Gateway Info\n\nGateway: nemoclaw\nGateway endpoint: https://127.0.0.1:8080/\n";

const STATUS_CONNECTED_NEMOCLAW =
  "Server Status\n\nGateway: nemoclaw\nServer: https://127.0.0.1:8080/\nStatus: Connected\n";
const SANDBOX_GET_NOT_FOUND = "Error:   × Not Found: sandbox not found";

interface ScenarioScript {
  // sandbox get responses, one per call (cycled / stops at last)
  sandboxGet: Array<{ output: string; exit: number }>;
  // openshell status responses, cycled
  status: Array<{ output: string; exit: number }>;
  // openshell gateway info responses, cycled
  gatewayInfo: Array<{ output: string; exit: number }>;
  // openshell gateway select response
  gatewaySelect: { output: string; exit: number };
  // whether `gateway select nemoclaw` flips the active gateway to nemoclaw
  selectFlipsActive: boolean;
  // `sandbox list` output; scenario 14 uses an empty list to enter stale recovery.
  sandboxList?: string;
}

interface HarnessResult {
  status: number | null;
  stdout: string;
  stderr: string;
  registryExists: boolean;
  registry: any;
  sessionSandboxName: string | null | undefined;
}

let tmpDir: string;
let registryDir: string;
let homeLocalBin: string;
let openshellPath: string;
let stateFile: string;
let scriptFile: string;

function writeDefaultRegistry() {
  fs.writeFileSync(
    path.join(registryDir, "sandboxes.json"),
    JSON.stringify({
      defaultSandbox: SANDBOX_NAME,
      sandboxes: {
        [SANDBOX_NAME]: {
          name: SANDBOX_NAME,
          model: "nvidia/nemotron-3-super-120b-a12b",
          provider: "nvidia-prod",
          gpuEnabled: false,
          sandboxGpuMode: "0",
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
          dashboardPort: 28790,
          fromDockerfile: null,
          policies: [],
        },
      },
    }),
    { mode: 0o600 },
  );
}

function writeDefaultSession() {
  fs.writeFileSync(
    path.join(registryDir, "onboard-session.json"),
    JSON.stringify({
      version: 1,
      sandboxName: SANDBOX_NAME,
      provider: "nvidia-prod",
    }),
    { mode: 0o600 },
  );
}

function writeStubOpenshell(script: ScenarioScript) {
  fs.writeFileSync(scriptFile, JSON.stringify(script));
  fs.writeFileSync(stateFile, JSON.stringify({}));

  // Inline stub — uses node as interpreter via execPath shebang. Reads
  // script each call so tests can tweak state between runs (not used here).
  const stub = `#!${process.execPath}
const fs = require("fs");
const scriptPath = ${JSON.stringify(scriptFile)};
const statePath = ${JSON.stringify(stateFile)};
const script = JSON.parse(fs.readFileSync(scriptPath, "utf8"));
const state = JSON.parse(fs.readFileSync(statePath, "utf8") || "{}");
const args = process.argv.slice(2);
const requiredFeatures = "request-body-credential-rewrite websocket-credential-rewrite allow_all_known_mcp_methods";

function cycle(key, list) {
  state[key] = (state[key] || 0) + 1;
  const idx = Math.min(state[key] - 1, list.length - 1);
  fs.writeFileSync(statePath, JSON.stringify(state));
  return list[idx];
}

function emit(r) {
  if (r.output) process.stdout.write(r.output);
  process.exit(r.exit || 0);
}

if (args[0] === "-V" || args[0] === "--version") {
  process.stdout.write("openshell 0.0.85\\n");
  process.exit(0);
}

if (args[0] === "status") {
  emit(cycle("status", script.status));
}

if (args[0] === "gateway" && args[1] === "info") {
  emit(cycle("gatewayInfo", script.gatewayInfo));
}

if (args[0] === "gateway" && args[1] === "select") {
  state.selectCalled = (state.selectCalled || 0) + 1;
  if (script.selectFlipsActive) {
    // After a successful select, subsequent status/sandbox get use
    // healthy_named responses. We implement this by advancing counters
    // to "healthy" arrays. For simplicity: if selectFlipsActive, we
    // rewrite status/sandboxGet state so next cycle returns healthy.
    state.postSelect = true;
  }
  fs.writeFileSync(statePath, JSON.stringify(state));
  emit(script.gatewaySelect);
}

if (args[0] === "sandbox" && args[1] === "get") {
  // Use a separate key so retries after select advance properly.
  emit(cycle("sandboxGet", script.sandboxGet));
}

if (args[0] === "policy" && args[1] === "get") {
  process.stdout.write("version: 1\\nnetwork_policies:\\n");
  process.exit(0);
}

if (args[0] === "sandbox" && args[1] === "list") {
  process.stdout.write(script.sandboxList === undefined ? "Sandboxes:\\n  - ${SANDBOX_NAME}\\n" : script.sandboxList);
  process.exit(0);
}

if (args[0] === "inference" && args[1] === "get") {
  process.stdout.write("Gateway inference:\\n  Provider: nvidia-prod\\n  Model: nvidia/nemotron-3-super-120b-a12b\\n");
  process.exit(0);
}

if (args[0] === "provider" && args[1] === "get") process.exit(0);

// forward stop/start, provider delete, logs, etc. — no-op success
process.exit(0);
`;
  fs.writeFileSync(openshellPath, stub, { mode: 0o755 });
  for (const component of ["openshell-gateway", "openshell-sandbox"]) {
    fs.writeFileSync(
      path.join(homeLocalBin, component),
      `#!${process.execPath}
const requiredFeatures = "request-body-credential-rewrite websocket-credential-rewrite allow_all_known_mcp_methods";
if (process.argv[2] === "-V" || process.argv[2] === "--version") process.stdout.write("${component} 0.0.85\\n");
process.exit(0);
`,
      { mode: 0o755 },
    );
  }
}

function runCli(action: string, extraEnv: Record<string, string | undefined> = {}): HarnessResult {
  const repoRoot = path.join(import.meta.dirname, "..");
  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, "bin", "nemoclaw.js"), SANDBOX_NAME, action],
    {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: TIMEOUT_MS,
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${homeLocalBin}:/usr/bin:/bin`,
        // Keep output deterministic.
        NO_COLOR: "1",
        ...extraEnv,
      },
    },
  );

  const registryPath = path.join(registryDir, "sandboxes.json");
  const registryExists = fs.existsSync(registryPath);
  const registry = registryExists ? JSON.parse(fs.readFileSync(registryPath, "utf-8")) : null;
  const sessionPath = path.join(registryDir, "onboard-session.json");
  let sessionSandboxName: string | null | undefined = undefined;
  if (fs.existsSync(sessionPath)) {
    try {
      const s = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
      sessionSandboxName = s.sandboxName;
    } catch {
      sessionSandboxName = undefined;
    }
  }

  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    registryExists,
    registry,
    sessionSandboxName,
  };
}

function registrySandboxPresent(r: HarnessResult): boolean {
  return (
    r.registryExists &&
    !!r.registry &&
    !!r.registry.sandboxes &&
    Object.prototype.hasOwnProperty.call(r.registry.sandboxes, SANDBOX_NAME)
  );
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-2276-"));
  homeLocalBin = path.join(tmpDir, ".local", "bin");
  registryDir = path.join(tmpDir, ".nemoclaw");
  openshellPath = path.join(homeLocalBin, "openshell");
  stateFile = path.join(tmpDir, "state.json");
  scriptFile = path.join(tmpDir, "script.json");

  fs.mkdirSync(homeLocalBin, { recursive: true });
  fs.mkdirSync(registryDir, { recursive: true });
  writeDefaultRegistry();
  writeDefaultSession();
  fs.writeFileSync(
    path.join(homeLocalBin, "docker"),
    `#!${process.execPath}
const a = process.argv.slice(2);
if (a[0] === "info") {
  process.stdout.write(JSON.stringify({ServerVersion:"27.0.0", OperatingSystem:"Docker Engine", NCPU:8, MemTotal:17179869184}) + "\\n");
  process.exit(0);
}
if (a[0] === "build") process.exit(0);
if (a[0] === "image" && a[1] === "inspect") {
  const formatIndex = a.indexOf("--format");
  const format = formatIndex >= 0 ? a[formatIndex + 1] : "";
  if (format === "{{.Id}}") process.stdout.write("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n");
  if (format === "{{json .RepoDigests}}") process.stdout.write("[]\\n");
  process.exit(0);
}
if (a[0] === "tag" || a[0] === "rmi") process.exit(0);
if (a[0] === "run") {
  if (a.includes("nslookup")) process.stdout.write("Server: 127.0.0.11\\n** server can't find nemoclaw.invalid: NXDOMAIN\\n");
  else if (a.includes("/usr/bin/ldd")) process.stdout.write("ldd (GNU libc) 2.41\\n");
  process.exit(0);
}
process.exit(0);
`,
    { mode: 0o755 },
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Scenario 14 (#4497) ─── connect preserves enough state for rebuild ─────
// End-to-end recovery contract for the REOPENED issue: a healthy gateway
// reports the sandbox as gone, `connect` must NOT delete the registry entry,
// and the follow-up `rebuild --yes` must actually RECOVER it.
//
// The first fix (PR #4647) only stopped `connect` from deleting the entry. But
// `rebuild` then still dead-ended at its backup step with "Cannot back up
// state" because the live sandbox was absent — exactly this stale state. So the
// recommended recovery path was still broken. This scenario now asserts rebuild
// (a) locates the preserved entry (no "does not exist"), (b) does NOT dead-end
// at "Cannot back up state", and (c) reports the stale state and proceeds to
// recreate from the preserved registry metadata instead of aborting.
describe("connect preserves the registry so rebuild can recover in scenario 14 (#4497)", () => {
  it("after a non-destructive connect, `rebuild --yes` recovers the stale sandbox", {
    timeout: TIMEOUT_MS,
  }, () => {
    writeStubOpenshell({
      sandboxGet: [{ output: SANDBOX_GET_NOT_FOUND, exit: 1 }],
      status: [{ output: STATUS_CONNECTED_NEMOCLAW, exit: 0 }],
      gatewayInfo: [{ output: GATEWAY_INFO_NEMOCLAW, exit: 0 }],
      gatewaySelect: { output: "", exit: 0 },
      selectFlipsActive: false,
      sandboxList: "",
    });

    // Step 3: routine connect must preserve the registry entry.
    const connect = runCli("connect");
    assert.equal(connect.status, 1, `connect expected exit 1, got ${connect.status}`);
    assert.equal(
      registrySandboxPresent(connect),
      true,
      `connect must preserve the registry entry, got: ${JSON.stringify(connect.registry)}`,
    );
    assert.equal(connect.sessionSandboxName, SANDBOX_NAME, "session must survive connect");
    assert.doesNotMatch(connect.stderr, /Removed stale local registry entry/);

    // Step 4: the previously-suggested rebuild must RECOVER the stale sandbox.
    // The live `sandbox list` does not report it, so rebuild enters its
    // stale-recovery path: it locates the preserved registry entry, skips the
    // impossible backup (instead of dead-ending at "Cannot back up state"),
    // and proceeds to recreate from the preserved metadata.
    const repoRoot = path.join(import.meta.dirname, "..");
    const rebuild = spawnSync(
      process.execPath,
      [path.join(repoRoot, "bin", "nemoclaw.js"), SANDBOX_NAME, "rebuild", "--yes"],
      {
        cwd: repoRoot,
        encoding: "utf-8",
        timeout: TIMEOUT_MS,
        env: {
          ...process.env,
          HOME: tmpDir,
          PATH: `${homeLocalBin}:/usr/bin:/bin`,
          NO_COLOR: "1",
          NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
          NEMOCLAW_SKIP_HOST_DNS_PREFLIGHT: "1",
          NEMOCLAW_NON_INTERACTIVE: "1",
          // The recreate handoff (onboard --resume) fails fast in this stubbed
          // HOME — fine: the assertions below target the recovery markers that
          // are emitted BEFORE the recreate, proving rebuild crossed the
          // backup gate that previously blocked it.
          NVIDIA_INFERENCE_API_KEY: "nvapi-test-key-for-rebuild",
          NEMOCLAW_PROVIDER_KEY: "",
        },
      },
    );
    const rebuildOut = `${rebuild.stdout || ""}\n${rebuild.stderr || ""}`;

    assert.doesNotMatch(
      rebuildOut,
      /does not exist/,
      `rebuild must locate the preserved sandbox, got:\n${rebuildOut}`,
    );
    // The reopened-issue dead-end must be gone.
    assert.doesNotMatch(
      rebuildOut,
      /Cannot back up state/,
      `rebuild must not dead-end on the stale sandbox (#4497), got:\n${rebuildOut}`,
    );
    assert.match(
      rebuildOut,
      new RegExp(`Rebuild sandbox '${SANDBOX_NAME}'`),
      `rebuild must enter the rebuild flow, got:\n${rebuildOut}`,
    );
    // It must recognize the stale state and skip the impossible backup.
    assert.match(
      rebuildOut,
      /absent from the live OpenShell gateway/,
      `rebuild must report the stale-recovery state (#4497), got:\n${rebuildOut}`,
    );
    assert.match(
      rebuildOut,
      /No live workspace state to back up/,
      `rebuild must skip backup on stale recovery (#4497), got:\n${rebuildOut}`,
    );
    assert.doesNotMatch(
      rebuildOut,
      /Backing up sandbox state/,
      `rebuild must not attempt backup on a stale sandbox (#4497), got:\n${rebuildOut}`,
    );
    // And it must proceed to recreate from the preserved metadata — this line
    // is printed right before the onboard --resume handoff.
    assert.match(
      rebuildOut,
      /Creating new sandbox with current image/,
      `rebuild must proceed to recreate the sandbox (#4497), got:\n${rebuildOut}`,
    );
  });
});
