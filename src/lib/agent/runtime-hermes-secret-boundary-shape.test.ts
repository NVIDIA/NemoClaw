// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Shape-only assertions for the Hermes recovery boundary guards. These tests
// check the generated shell string — what calls appear, in what order, and
// where the refusal markers land — without spawning a child shell. Behavioural
// tests that actually execute the synthesised script live in
// runtime-hermes-secret-boundary-behavioural.test.ts.

import { describe, expect, it } from "vitest";
import { HERMES_SECRET_BOUNDARY_VALIDATOR_PATH } from "../../../dist/lib/agent/hermes-recovery-boundary";
import {
  buildHermesDashboardProcessRecoveryScript,
  buildManualRecoveryCommand,
  buildRecoveryScript,
} from "../../../dist/lib/agent/runtime";
import { hermesAgent, minimalAgent } from "./hermes-recovery-boundary-fixtures";

const VALIDATOR_PATH = HERMES_SECRET_BOUNDARY_VALIDATOR_PATH;

describe("Hermes secret-boundary guard — generated shell shape", () => {
  it("invokes the env-file validator before launching the Hermes gateway", () => {
    const script = buildRecoveryScript(hermesAgent, 8642);
    expect(script).not.toBeNull();
    expect(script).toContain(VALIDATOR_PATH);
    expect(script).toContain(`python3 '${VALIDATOR_PATH}' env-file /sandbox/.hermes/.env`);
  });

  it("invokes the runtime-env validator after sourcing the generated recovery env", () => {
    const script = buildRecoveryScript(hermesAgent, 8642);
    expect(script).not.toBeNull();
    const proxyEnvIdx = script!.indexOf('. "$_NEMOCLAW_RECOVERY_SOURCE_ENV"');
    const runtimeGuardIdx = script!.indexOf(`python3 '${VALIDATOR_PATH}' runtime-env`);
    const launchIdx = script!.indexOf("nohup");
    expect(proxyEnvIdx).toBeGreaterThanOrEqual(0);
    expect(runtimeGuardIdx).toBeGreaterThanOrEqual(0);
    expect(launchIdx).toBeGreaterThanOrEqual(0);
    expect(proxyEnvIdx).toBeLessThan(runtimeGuardIdx);
    expect(runtimeGuardIdx).toBeLessThan(launchIdx);
  });

  it("refuses the relaunch with SECRET_BOUNDARY_REFUSED on env-file violation", () => {
    const script = buildRecoveryScript(hermesAgent, 8642);
    expect(script).toContain("SECRET_BOUNDARY_REFUSED");
    expect(script).toContain("exit 1");
  });

  it("env-file guard runs before the ALREADY_RUNNING health probe so a poisoned gateway gets stopped", () => {
    const script = buildRecoveryScript(hermesAgent, 8642);
    expect(script).not.toBeNull();
    const guardIdx = script!.indexOf(`python3 '${VALIDATOR_PATH}' env-file /sandbox/.hermes/.env`);
    const probeIdx = script!.indexOf("ALREADY_RUNNING");
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(probeIdx).toBeGreaterThanOrEqual(0);
    expect(guardIdx).toBeLessThan(probeIdx);
  });

  it("kills running Hermes gateway and dashboard on boundary failure", () => {
    const script = buildRecoveryScript(hermesAgent, 8642);
    expect(script).toContain("[h]ermes[[:space:]]+gateway");
    expect(script).toContain("[h]ermes[[:space:]]+dashboard");
    expect(script).toContain("pkill -TERM -f");
    expect(script).toContain("pkill -KILL -f");
  });

  it("warns and continues recovery on older sandbox images that lack the validator", () => {
    const script = buildRecoveryScript(hermesAgent, 8642);
    expect(script).not.toContain("SECRET_BOUNDARY_VALIDATOR_MISSING");
    expect(script).toContain("[gateway-recovery] WARNING");
    expect(script).toContain("secret-boundary validator");
    expect(script).toContain("missing on this sandbox image");
  });

  it("does not gate non-Hermes recovery on the Hermes-specific validator", () => {
    const script = buildRecoveryScript(minimalAgent, 19000);
    expect(script).not.toContain("validate-hermes-env-secret-boundary.py");
    expect(script).not.toContain("SECRET_BOUNDARY_REFUSED");
  });

  it("guards the dashboard-only recovery path with env-file before generated sourcing and runtime-env after", () => {
    const script = buildHermesDashboardProcessRecoveryScript({
      publicPort: 9119,
      internalPort: 19119,
      tuiEnabled: false,
    });
    const envFileIdx = script.indexOf(`python3 '${VALIDATOR_PATH}' env-file /sandbox/.hermes/.env`);
    const guardRecoveryIdx = script.indexOf("_nemoclaw_validate_recovery_proxy_env");
    const proxyEnvIdx = script.indexOf('. "$_NEMOCLAW_RECOVERY_SOURCE_ENV"');
    const bashrcIdx = script.indexOf("[ -f ~/.bashrc ] && . ~/.bashrc;");
    const runtimeIdx = script.indexOf(`python3 '${VALIDATOR_PATH}' runtime-env`);
    const launchIdx = script.indexOf('"$AGENT_BIN" dashboard');
    expect(envFileIdx).toBeGreaterThanOrEqual(0);
    expect(guardRecoveryIdx).toBeGreaterThanOrEqual(0);
    expect(proxyEnvIdx).toBeGreaterThanOrEqual(0);
    expect(bashrcIdx).toBeGreaterThanOrEqual(0);
    expect(runtimeIdx).toBeGreaterThanOrEqual(0);
    expect(launchIdx).toBeGreaterThanOrEqual(0);
    expect(envFileIdx).toBeLessThan(proxyEnvIdx);
    expect(guardRecoveryIdx).toBeLessThan(proxyEnvIdx);
    expect(proxyEnvIdx).toBeLessThan(runtimeIdx);
    expect(proxyEnvIdx).toBeLessThan(bashrcIdx);
    expect(bashrcIdx).toBeLessThan(runtimeIdx);
    expect(runtimeIdx).toBeLessThan(launchIdx);
    expect(script).not.toContain("if [ -r /tmp/nemoclaw-proxy-env.sh ]; then .");
    expect(script).toContain("SECRET_BOUNDARY_REFUSED");
  });

  it("guards manual Hermes recovery copy-paste command", () => {
    const cmd = buildManualRecoveryCommand(hermesAgent, 8642);
    expect(cmd).toContain(`python3 '${VALIDATOR_PATH}' env-file /sandbox/.hermes/.env`);
    expect(cmd).toContain(`python3 '${VALIDATOR_PATH}' runtime-env`);
    expect(cmd).toContain("SECRET_BOUNDARY_REFUSED");
    const guardIdx = cmd.indexOf(`python3 '${VALIDATOR_PATH}'`);
    const launchIdx = cmd.indexOf("nohup hermes gateway run");
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(launchIdx).toBeGreaterThanOrEqual(0);
    expect(guardIdx).toBeLessThan(launchIdx);
  });

  it("does not gate the non-Hermes manual recovery command", () => {
    const cmd = buildManualRecoveryCommand(minimalAgent, 19000);
    expect(cmd).not.toContain("validate-hermes-env-secret-boundary.py");
    expect(cmd).not.toContain("SECRET_BOUNDARY_REFUSED");
  });
});
