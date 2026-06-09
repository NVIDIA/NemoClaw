// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { HostCliClient } from "../scenarios/clients/host-cli.ts";
import { compileRunPlans } from "../scenarios/compiler.ts";
import { PhaseOrchestrator } from "../scenarios/orchestrators/phase.ts";
import { ScenarioRunner } from "../scenarios/orchestrators/runner.ts";
import type {
  AssertionStep,
  PhaseAction,
  PhaseName,
  PhaseResult,
  RunContext,
  RunPlanPhase,
} from "../scenarios/types.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

function freshCtx(): RunContext {
  return { contextDir: fs.mkdtempSync(path.join(os.tmpdir(), "e2e-phase-")) };
}

function shellStep(id: string, phase: PhaseName, ref: string, reliability?: AssertionStep["reliability"]): AssertionStep {
  return {
    id,
    phase,
    implementation: { kind: "shell", ref },
    evidencePath: `.e2e/assertions/${id}.log`,
    reliability,
  };
}

function probeStep(id: string, phase: PhaseName, ref = "no-such-probe"): AssertionStep {
  return {
    id,
    phase,
    implementation: { kind: "probe", ref },
    evidencePath: `.e2e/assertions/${id}.json`,
  };
}

function pendingStep(id: string, phase: PhaseName): AssertionStep {
  return {
    id,
    phase,
    implementation: { kind: "pending", ref: "not-yet" },
  };
}

function makePhase(steps: AssertionStep[]): RunPlanPhase {
  return {
    name: steps[0].phase,
    actions: [],
    assertionGroups: [{ id: `group.${steps[0].id}`, phase: steps[0].phase, migrationStatus: "complete", steps }],
  };
}

function writeTempScript(dir: string, name: string, body: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, { mode: 0o755 });
  return p;
}

function shellAction(
  id: string,
  phase: PhaseName,
  scriptRef: string,
  opts: { timeoutSeconds?: number; arg?: string } = {},
): PhaseAction {
  return {
    id,
    phase,
    kind: "shell",
    scriptRef,
    arg: opts.arg,
    timeoutSeconds: opts.timeoutSeconds,
  };
}

function makePhaseWithActions(
  phase: PhaseName,
  actions: PhaseAction[],
  steps: AssertionStep[],
): RunPlanPhase {
  return {
    name: phase,
    actions,
    assertionGroups:
      steps.length > 0
        ? [{ id: `group.${steps[0].id}`, phase, migrationStatus: "complete", steps }]
        : [],
  };
}

describe("phase orchestrators - top-level delegation", () => {
  it("test_should_execute_phase_assertions_from_phase_orchestrators_not_top_level_runner", async () => {
    const ctx = freshCtx();
    try {
      const [plan] = compileRunPlans(["ubuntu-repo-cloud-openclaw"]);
      const calls: string[] = [];
      const fakeOrchestrator = (phase: PhaseName) => ({
        run: async (_ctx: RunContext, runPhase: RunPlanPhase, _prior?: PhaseResult[]): Promise<PhaseResult> => {
          calls.push(runPhase.name);
          return { phase, status: "passed", actions: [], assertions: [] };
        },
      });
      const runner = new ScenarioRunner({
        environment: fakeOrchestrator("environment"),
        onboarding: fakeOrchestrator("onboarding"),
        stateValidation: fakeOrchestrator("state-validation"),
        lifecycle: fakeOrchestrator("lifecycle"),
        runtime: fakeOrchestrator("runtime"),
      });

      const results = await runner.run(ctx, plan);

      expect(calls).toEqual([
        "environment",
        "onboarding",
        "state-validation",
        "lifecycle",
        "runtime",
      ]);
      expect(results.map((result) => result.phase)).toEqual([
        "environment",
        "onboarding",
        "state-validation",
        "lifecycle",
        "runtime",
      ]);
    } finally {
      fs.rmSync(ctx.contextDir, { recursive: true, force: true });
    }
  });
});

describe("phase orchestrators - real shell execution", () => {
  it("shell_step_passes_when_script_exits_zero", async () => {
    const ctx = freshCtx();
    try {
      const script = writeTempScript(ctx.contextDir, "ok.sh", "echo hello-from-real-shell");
      const ref = path.relative(REPO_ROOT, script);
      const step = shellStep("runtime.real-pass", "runtime", ref);
      const orchestrator = new PhaseOrchestrator("runtime");

      const result = await orchestrator.run(ctx, makePhase([step]));

      expect(result.status).toBe("passed");
      expect(result.assertions[0]).toEqual(
        expect.objectContaining({ id: "runtime.real-pass", status: "passed", attempts: 1 }),
      );
      const log = fs.readFileSync(result.assertions[0].evidence!, "utf8");
      expect(log).toContain("hello-from-real-shell");
    } finally {
      fs.rmSync(ctx.contextDir, { recursive: true, force: true });
    }
  });

  it("shell_step_fails_when_script_exits_nonzero_and_records_stderr_tail", async () => {
    const ctx = freshCtx();
    try {
      const script = writeTempScript(ctx.contextDir, "fail.sh", 'echo "boom: real failure" >&2; exit 7');
      const ref = path.relative(REPO_ROOT, script);
      const step = shellStep("runtime.real-fail", "runtime", ref);
      const orchestrator = new PhaseOrchestrator("runtime");

      const result = await orchestrator.run(ctx, makePhase([step]));

      expect(result.status).toBe("failed");
      expect(result.assertions[0].status).toBe("failed");
      expect(result.assertions[0].message).toMatch(/exit 7/);
      expect(result.assertions[0].message).toMatch(/boom: real failure/);
    } finally {
      fs.rmSync(ctx.contextDir, { recursive: true, force: true });
    }
  });

  it("shell_step_times_out_via_orchestrator_policy_not_script", async () => {
    const ctx = freshCtx();
    try {
      const script = writeTempScript(ctx.contextDir, "slow.sh", "sleep 30");
      const ref = path.relative(REPO_ROOT, script);
      const step = shellStep("runtime.real-timeout", "runtime", ref, { timeoutSeconds: 1 });
      const orchestrator = new PhaseOrchestrator("runtime");

      const started = Date.now();
      const result = await orchestrator.run(ctx, makePhase([step]));
      const elapsed = Date.now() - started;

      expect(result.status).toBe("failed");
      expect(result.assertions[0].message).toMatch(/exceeded 1s/);
      expect(elapsed).toBeLessThan(15_000);
    } finally {
      fs.rmSync(ctx.contextDir, { recursive: true, force: true });
    }
  }, 20_000);

  it("shell_step_retries_on_classified_transient_then_passes", async () => {
    const ctx = freshCtx();
    try {
      const counterFile = path.join(ctx.contextDir, "counter");
      fs.writeFileSync(counterFile, "0");
      const script = writeTempScript(
        ctx.contextDir,
        "gateway-flaky.sh",
        `n=$(cat "${counterFile}"); n=$((n+1)); echo "$n" > "${counterFile}"; if [ "$n" -lt 2 ]; then echo "gateway-transient: try again" >&2; exit 1; fi; echo ok`,
      );
      const ref = path.relative(REPO_ROOT, script);
      const step = shellStep("runtime.gateway-retry", "runtime", ref, {
        retry: { attempts: 2, on: ["gateway-transient"] },
      });
      const orchestrator = new PhaseOrchestrator("runtime");

      const result = await orchestrator.run(ctx, makePhase([step]));

      expect(result.status).toBe("passed");
      expect(result.assertions[0].attempts).toBe(2);
      expect(result.assertions[0].classifier).toBe("gateway-transient");
    } finally {
      fs.rmSync(ctx.contextDir, { recursive: true, force: true });
    }
  });

  it("shell_step_fails_with_clear_message_when_script_missing", async () => {
    const ctx = freshCtx();
    try {
      const step = shellStep("runtime.missing", "runtime", "test/e2e-scenario/does-not-exist.sh");
      const orchestrator = new PhaseOrchestrator("runtime");

      const result = await orchestrator.run(ctx, makePhase([step]));

      expect(result.status).toBe("failed");
      expect(result.assertions[0].message).toMatch(/script not found/);
    } finally {
      fs.rmSync(ctx.contextDir, { recursive: true, force: true });
    }
  });

  it("probe_step_without_registered_probe_skips_visibly_never_passes_falsely", async () => {
    const ctx = freshCtx();
    try {
      const step = probeStep("runtime.probe-pending", "runtime");
      const orchestrator = new PhaseOrchestrator("runtime");

      const result = await orchestrator.run(ctx, makePhase([step]));

      expect(result.assertions[0].status).toBe("skipped");
      expect(result.assertions[0].message).toMatch(/probe not registered/);
    } finally {
      fs.rmSync(ctx.contextDir, { recursive: true, force: true });
    }
  });

  it("pending_step_skips_visibly_with_pending_marker", async () => {
    const ctx = freshCtx();
    try {
      const step = pendingStep("runtime.pending", "runtime");
      const orchestrator = new PhaseOrchestrator("runtime");

      const result = await orchestrator.run(ctx, makePhase([step]));

      expect(result.assertions[0].status).toBe("skipped");
      expect(result.assertions[0].message).toMatch(/^pending:/);
    } finally {
      fs.rmSync(ctx.contextDir, { recursive: true, force: true });
    }
  });
});

describe("phase orchestrators - actions execute before assertions", () => {
  it("phase_action_runs_before_assertions_and_records_evidence", async () => {
    const ctx = freshCtx();
    try {
      const actionScript = writeTempScript(ctx.contextDir, "setup.sh", "echo phase-action-evidence");
      const action = shellAction("environment.setup-ok", "environment", path.relative(REPO_ROOT, actionScript));
      const stepScript = writeTempScript(ctx.contextDir, "after.sh", "echo after-action");
      const step = shellStep("environment.assert-ok", "environment", path.relative(REPO_ROOT, stepScript));
      const orchestrator = new PhaseOrchestrator("environment");

      const result = await orchestrator.run(ctx, makePhaseWithActions("environment", [action], [step]));

      expect(result.status).toBe("passed");
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0]).toEqual(
        expect.objectContaining({ id: "environment.setup-ok", status: "passed" }),
      );
      expect(result.actions[0].evidence).toBeTruthy();
      const actionLog = fs.readFileSync(result.actions[0].evidence!, "utf8");
      expect(actionLog).toContain("phase-action-evidence");
      expect(result.assertions).toHaveLength(1);
      expect(result.assertions[0].status).toBe("passed");
    } finally {
      fs.rmSync(ctx.contextDir, { recursive: true, force: true });
    }
  });

  it("phase_action_failure_short_circuits_assertions", async () => {
    const ctx = freshCtx();
    try {
      const failScript = writeTempScript(ctx.contextDir, "fail.sh", 'echo "setup boom" >&2; exit 5');
      const action = shellAction("environment.setup-fail", "environment", path.relative(REPO_ROOT, failScript));
      const stepScript = writeTempScript(ctx.contextDir, "after.sh", "echo should-not-run");
      const step = shellStep("environment.never-runs", "environment", path.relative(REPO_ROOT, stepScript));
      const orchestrator = new PhaseOrchestrator("environment");

      const result = await orchestrator.run(ctx, makePhaseWithActions("environment", [action], [step]));

      expect(result.status).toBe("failed");
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0].status).toBe("failed");
      expect(result.actions[0].message).toMatch(/exit 5/);
      // Assertions must NOT have run, so they must NOT show a misleading
      // pass for an environment that was never set up.
      expect(result.assertions).toEqual([]);
    } finally {
      fs.rmSync(ctx.contextDir, { recursive: true, force: true });
    }
  });

  it("phase_action_times_out_via_orchestrator_policy", async () => {
    const ctx = freshCtx();
    try {
      const slow = writeTempScript(ctx.contextDir, "slow.sh", "sleep 30");
      const action = shellAction("environment.setup-slow", "environment", path.relative(REPO_ROOT, slow), {
        timeoutSeconds: 1,
      });
      const orchestrator = new PhaseOrchestrator("environment");

      const started = Date.now();
      const result = await orchestrator.run(ctx, makePhaseWithActions("environment", [action], []));

      expect(result.status).toBe("failed");
      expect(result.actions[0].status).toBe("failed");
      expect(result.actions[0].message).toMatch(/exceeded 1s/);
      // The orchestrator must enforce the timeout, not depend on the
      // script self-killing. Allow some headroom but fail if we waited
      // anywhere near the script's 30s sleep.
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      fs.rmSync(ctx.contextDir, { recursive: true, force: true });
    }
  });

  it("phase_action_publishes_alias_path_on_success", async () => {
    const ctx = freshCtx();
    try {
      const actionScript = writeTempScript(ctx.contextDir, "alias.sh", "echo aliased-output");
      const action: PhaseAction = {
        id: "onboarding.profile.alias-demo",
        phase: "onboarding",
        kind: "shell",
        scriptRef: path.relative(REPO_ROOT, actionScript),
        aliasPath: "onboard.log",
      };
      const orchestrator = new PhaseOrchestrator("onboarding");

      const result = await orchestrator.run(ctx, makePhaseWithActions("onboarding", [action], []));

      expect(result.actions[0].status).toBe("passed");
      const aliasContents = fs.readFileSync(path.join(ctx.contextDir, "onboard.log"), "utf8");
      expect(aliasContents).toContain("aliased-output");
    } finally {
      fs.rmSync(ctx.contextDir, { recursive: true, force: true });
    }
  });

  it("phase_action_evidence_log_is_flushed_before_resolve", async () => {
    const ctx = freshCtx();
    try {
      const actionScript = writeTempScript(ctx.contextDir, "flush.sh", "echo flushed-phase-action-output");
      const action = shellAction("environment.flush", "environment", path.relative(REPO_ROOT, actionScript));
      const orchestrator = new PhaseOrchestrator("environment");

      const result = await orchestrator.run(ctx, makePhaseWithActions("environment", [action], []));

      // Synchronous read must already see the output - the orchestrator
      // must wait for the WriteStream's 'finish' before resolving.
      const log = fs.readFileSync(result.actions[0].evidence!, "utf8");
      expect(log).toContain("flushed-phase-action-output");
    } finally {
      fs.rmSync(ctx.contextDir, { recursive: true, force: true });
    }
  });
});

describe("plan compiler emits phase actions for canonical scenarios", () => {
  it("compiler_emits_install_and_onboard_actions_for_canonical_scenarios", async () => {
    const { compileRunPlans } = await import("../scenarios/compiler.ts");
    const ids = [
      "ubuntu-repo-cloud-openclaw",
      "ubuntu-repo-cloud-hermes",
      "gpu-repo-local-ollama-openclaw",
      "macos-repo-cloud-openclaw",
      "wsl-repo-cloud-openclaw",
      "brev-launchable-cloud-openclaw",
      "ubuntu-no-docker-preflight-negative",
    ];
    const plans = compileRunPlans(ids);
    expect(plans).toHaveLength(ids.length);
    for (const plan of plans) {
      const env = plan.phases.find((p) => p.name === "environment")!;
      const onb = plan.phases.find((p) => p.name === "onboarding")!;
      expect(env.actions.some((a) => a.id.startsWith("environment.install."))).toBe(true);
      expect(onb.actions.some((a) => a.id.startsWith("onboarding.profile."))).toBe(true);
      // context.env emission is framework infrastructure (ScenarioRunner),
      // not a shell action. The compiler must NOT emit a shell context
      // action - if it did we'd be coupling back to the old resolver's
      // plan.json shape.
      expect(env.actions.map((a) => a.id)).not.toContain("environment.context.emit");
      // Onboarding action must publish a stable alias path so legacy
      // shell assertions referencing ${E2E_CONTEXT_DIR}/onboard.log
      // keep working without coupling them to action ids.
      const onboardingAction = onb.actions.find((a) => a.id.startsWith("onboarding.profile."));
      expect(onboardingAction?.aliasPath).toBe("onboard.log");
      // Every install/onboard action must be a typed shell-fn referencing
      // the canonical dispatcher script - no free-form strings.
      for (const action of [...env.actions, ...onb.actions]) {
        if (action.id.startsWith("environment.install.") || action.id.startsWith("onboarding.profile.")) {
          expect(action.kind).toBe("shell-fn");
          expect(action.scriptRef).toMatch(/dispatch\.sh$/);
          expect(action.fn).toMatch(/^e2e_(install|onboard)$/);
          expect(action.arg).toBeTruthy();
        }
      }
    }
  });

  it("compiler_routes_docker_missing_runtime_to_no_docker_onboarding_profile", async () => {
    const { compileRunPlans } = await import("../scenarios/compiler.ts");
    // Negative scenario declares runtime=docker-missing in scenarios.yaml.
    // The compiler must substitute the onboarding profile id from the
    // base 'cloud-openclaw' to 'cloud-openclaw-no-docker' so the
    // dispatcher routes to the worker that installs the docker shim and
    // captures negative-preflight.log. Without this routing, the
    // 'onboarding.preflight.expected-failed' assertion has nothing to grep.
    const [plan] = compileRunPlans(["ubuntu-no-docker-preflight-negative"]);
    const onb = plan.phases.find((p) => p.name === "onboarding")!;
    const action = onb.actions.find((a) => a.id.startsWith("onboarding.profile."));
    expect(action?.id).toBe("onboarding.profile.cloud-openclaw-no-docker");
    expect(action?.arg).toBe("cloud-openclaw-no-docker");
    expect(action?.evidencePath).toBe(
      ".e2e/actions/onboarding.profile.cloud-openclaw-no-docker.log",
    );
    // Secret env must still include NVIDIA_API_KEY so behavior matches
    // a real user invocation (CLI loads creds even if preflight aborts).
    expect(action?.secretEnv).toContain("NVIDIA_API_KEY");
    // Positive scenarios must NOT pick up the -no-docker suffix.
    const [posPlan] = compileRunPlans(["ubuntu-repo-cloud-openclaw"]);
    const posAction = posPlan.phases
      .find((p) => p.name === "onboarding")!
      .actions.find((a) => a.id.startsWith("onboarding.profile."));
    expect(posAction?.arg).toBe("cloud-openclaw");
  });

  it("compiler_emits_lifecycle_phase_action_when_scenario_declares_lifecycle_profile", async () => {
    const { compileRunPlans } = await import("../scenarios/compiler.ts");
    // Rebuild scenario declares environment.lifecycle =
    // 'rebuild-current-version'. The compiler must emit a single
    // lifecycle phase action that dispatches to the canonical
    // lifecycle dispatcher; without this, runtime-phase rebuild
    // assertions run against a sandbox that was never rebuilt.
    const [plan] = compileRunPlans(["ubuntu-rebuild-openclaw"]);
    const lifecycle = plan.phases.find((p) => p.name === "lifecycle")!;
    expect(lifecycle).toBeTruthy();
    expect(lifecycle.actions).toHaveLength(1);
    const action = lifecycle.actions[0];
    expect(action.id).toBe("lifecycle.profile.rebuild-current-version");
    expect(action.arg).toBe("rebuild-current-version");
    expect(action.scriptRef).toMatch(/lifecycle\/dispatch\.sh$/);
    expect(action.fn).toBe("e2e_lifecycle");
    expect(action.evidencePath).toBe(
      ".e2e/actions/lifecycle.profile.rebuild-current-version.log",
    );
    // Secret env: nemoclaw rebuild re-reads NVIDIA_API_KEY when the
    // post-rebuild sandbox is brought back up.
    expect(action.secretEnv).toContain("NVIDIA_API_KEY");
  });

  it("compiler_emits_no_lifecycle_actions_when_scenario_does_not_declare_lifecycle", async () => {
    const { compileRunPlans } = await import("../scenarios/compiler.ts");
    // Default scenarios omit environment.lifecycle. The lifecycle
    // phase still appears in the plan (deterministic phase order)
    // but emits zero actions and runs no assertions.
    const [plan] = compileRunPlans(["ubuntu-repo-cloud-openclaw"]);
    const lifecycle = plan.phases.find((p) => p.name === "lifecycle")!;
    expect(lifecycle).toBeTruthy();
    expect(lifecycle.actions).toHaveLength(0);
    expect(lifecycle.assertionGroups).toHaveLength(0);
  });

  it("compiler_drops_rebuild_and_upgrade_supplemental_suites_from_cloud_openclaw", async () => {
    const { compileRunPlans } = await import("../scenarios/compiler.ts");
    // The 'rebuild' and 'upgrade' suites used to be supplementally
    // attached to ubuntu-repo-cloud-openclaw, which produced
    // fake-failures (no rebuild ran -> nothing could be preserved).
    // Coverage now lives on ubuntu-rebuild-openclaw, which actually
    // runs the lifecycle phase. The cloud-openclaw scenario must NOT
    // include those suites' assertion groups.
    const [plan] = compileRunPlans(["ubuntu-repo-cloud-openclaw"]);
    const runtime = plan.phases.find((p) => p.name === "runtime")!;
    const groupIds = runtime.assertionGroups.map((g) => g.id);
    expect(groupIds).not.toContain("suite.rebuild");
    expect(groupIds).not.toContain("suite.upgrade");
  });

  it("compiler_includes_rebuild_and_upgrade_groups_on_ubuntu_rebuild_openclaw", async () => {
    const { compileRunPlans } = await import("../scenarios/compiler.ts");
    const [plan] = compileRunPlans(["ubuntu-rebuild-openclaw"]);
    const runtime = plan.phases.find((p) => p.name === "runtime")!;
    const groupIds = runtime.assertionGroups.map((g) => g.id);
    expect(groupIds).toContain("suite.rebuild");
    expect(groupIds).toContain("suite.upgrade");
  });
});

describe("ScenarioRunner seeds context.env and short-circuits across phases", () => {
  it("seedContextEnv_writes_normalized_keys_at_top_level_context_env_path", async () => {
    const { compileRunPlans } = await import("../scenarios/compiler.ts");
    const { seedContextEnv } = await import("../scenarios/orchestrators/context.ts");
    const ctx = freshCtx();
    try {
      const [plan] = compileRunPlans(["ubuntu-repo-cloud-openclaw"]);
      const result = seedContextEnv(ctx, plan);

      // Path matches the shell helper's e2e_context_init: top-level,
      // not under .e2e/. Runtime steps source ${E2E_CONTEXT_DIR}/context.env.
      expect(result.path).toBe(path.join(ctx.contextDir, "context.env"));
      const body = fs.readFileSync(result.path, "utf8");
      // Required keys downstream shell assertions look up.
      expect(body).toMatch(/^E2E_SCENARIO=ubuntu-repo-cloud-openclaw$/m);
      expect(body).toMatch(/^E2E_PLATFORM_OS=ubuntu$/m);
      expect(body).toMatch(/^E2E_AGENT=openclaw$/m);
      expect(body).toMatch(/^E2E_PROVIDER=nvidia$/m);
      expect(body).toMatch(/^E2E_GATEWAY_URL=http:\/\/127\.0\.0\.1:18789$/m);
      expect(body).toMatch(/^E2E_SANDBOX_NAME=e2e-ubuntu-repo-cloud-openclaw$/m);
    } finally {
      fs.rmSync(ctx.contextDir, { recursive: true, force: true });
    }
  });

  it("hermes_scenario_seeds_hermes_gateway_url", async () => {
    const { compileRunPlans } = await import("../scenarios/compiler.ts");
    const { seedContextEnv } = await import("../scenarios/orchestrators/context.ts");
    const ctx = freshCtx();
    try {
      const [plan] = compileRunPlans(["ubuntu-repo-cloud-hermes"]);
      const result = seedContextEnv(ctx, plan);
      const body = fs.readFileSync(result.path, "utf8");
      expect(body).toMatch(/^E2E_AGENT=hermes$/m);
      expect(body).toMatch(/^E2E_GATEWAY_URL=http:\/\/127\.0\.0\.1:8642$/m);
    } finally {
      fs.rmSync(ctx.contextDir, { recursive: true, force: true });
    }
  });

  it("runner_skips_downstream_phases_when_prior_phase_action_fails", async () => {
    const { ScenarioRunner } = await import("../scenarios/orchestrators/runner.ts");
    const { compileRunPlans } = await import("../scenarios/compiler.ts");
    const ctx = freshCtx();
    try {
      const [plan] = compileRunPlans(["ubuntu-repo-cloud-openclaw"]);
      // Inject a failing environment phase to simulate an install action
      // failure. Onboarding and runtime must report skipped, not run
      // their own actions or assertions.
      const failingEnv = {
        run: async () => ({
          phase: "environment" as const,
          status: "failed" as const,
          actions: [
            {
              id: "environment.install.repo-current",
              status: "failed" as const,
              durationMs: 5,
              message: "simulated install failure",
            },
          ],
          assertions: [],
        }),
      };
      let onboardingCalled = false;
      let runtimeCalled = false;
      const onboarding = {
        run: async () => {
          onboardingCalled = true;
          return { phase: "onboarding" as const, status: "passed" as const, actions: [], assertions: [] };
        },
      };
      const runtime = {
        run: async () => {
          runtimeCalled = true;
          return { phase: "runtime" as const, status: "passed" as const, actions: [], assertions: [] };
        },
      };
      let stateValidationCalled = false;
      const stateValidation = {
        run: async () => {
          stateValidationCalled = true;
          return {
            phase: "state-validation" as const,
            status: "passed" as const,
            actions: [],
            assertions: [],
          };
        },
      };
      const runner = new ScenarioRunner({
        environment: failingEnv,
        onboarding,
        stateValidation,
        runtime,
      });

      const results = await runner.run(ctx, plan);

      // Downstream orchestrators must NOT have been invoked. An
      // environment failure means install never ran; there is nothing
      // for state-validation to probe.
      expect(onboardingCalled).toBe(false);
      expect(stateValidationCalled).toBe(false);
      expect(runtimeCalled).toBe(false);
      // Each phase still has a result, and the downstream ones are
      // skipped with a message that names the blocking action.
      expect(results.map((r) => r.phase)).toEqual([
        "environment",
        "onboarding",
        "state-validation",
        "lifecycle",
        "runtime",
      ]);
      expect(results[1].status).toBe("skipped");
      expect(results[2].status).toBe("skipped");
      expect(results[3].status).toBe("skipped");
      expect(results[4].status).toBe("skipped");
      expect(results[1].assertions[0].message).toMatch(/blocked by prior failure/);
      expect(results[1].assertions[0].message).toMatch(/environment.install.repo-current/);
    } finally {
      fs.rmSync(ctx.contextDir, { recursive: true, force: true });
    }
  });

  it("runner_does_not_short_circuit_on_assertion_failure_only", async () => {
    // Assertion failures (as opposed to action failures) must not block
    // downstream phases - reviewers need to see all failure layers.
    const { ScenarioRunner } = await import("../scenarios/orchestrators/runner.ts");
    const { compileRunPlans } = await import("../scenarios/compiler.ts");
    const ctx = freshCtx();
    try {
      const [plan] = compileRunPlans(["ubuntu-repo-cloud-openclaw"]);
      const env = {
        run: async () => ({
          phase: "environment" as const,
          status: "failed" as const,
          actions: [],
          assertions: [
            { id: "environment.something", status: "failed" as const, attempts: 1, durationMs: 1 },
          ],
        }),
      };
      let onboardingCalled = false;
      const onboarding = {
        run: async () => {
          onboardingCalled = true;
          return { phase: "onboarding" as const, status: "passed" as const, actions: [], assertions: [] };
        },
      };
      const runner = new ScenarioRunner({
        environment: env,
        onboarding,
        runtime: {
          run: async () => ({ phase: "runtime" as const, status: "passed" as const, actions: [], assertions: [] }),
        },
      });

      await runner.run(ctx, plan);
      expect(onboardingCalled).toBe(true);
    } finally {
      fs.rmSync(ctx.contextDir, { recursive: true, force: true });
    }
  });
});

describe("required probe and pending steps fail closed", () => {
  it("test_required_probe_step_that_is_unregistered_fails_the_phase", async () => {
    const ctx = freshCtx();
    try {
      const step: AssertionStep = {
        id: "runtime.security.required-probe",
        phase: "runtime",
        implementation: { kind: "probe", ref: "unregisteredSecurityProbe" },
        evidencePath: ".e2e/assertions/runtime.security.required-probe.json",
        required: true,
      };
      const orchestrator = new PhaseOrchestrator("runtime");

      const result = await orchestrator.run(ctx, makePhase([step]));

      expect(result.status).toBe("failed");
      expect(result.assertions[0].status).toBe("failed");
      expect(result.assertions[0].message).toMatch(/required probe not registered/);
      expect(result.assertions[0].message).toContain("unregisteredSecurityProbe");
    } finally {
      fs.rmSync(ctx.contextDir, { recursive: true, force: true });
    }
  });

  it("test_non_required_probe_step_continues_to_skip_visibly", async () => {
    const ctx = freshCtx();
    try {
      const step: AssertionStep = {
        id: "runtime.diagnostics.non-required-probe",
        phase: "runtime",
        // Use an intentionally-unregistered ref so this test exercises
        // the "missing probe" code path. `diagnosticsProbe` is now a
        // real built-in registered at orchestrator import time, so
        // referring to it here would actually invoke nemoclaw and the
        // assertion would fail (or pass) on real CLI behavior —
        // unrelated to what this test verifies.
        implementation: { kind: "probe", ref: "unregisteredFakeProbe" },
        evidencePath: ".e2e/assertions/runtime.diagnostics.non-required-probe.json",
        // required intentionally omitted (defaults to false)
      };
      const orchestrator = new PhaseOrchestrator("runtime");

      const result = await orchestrator.run(ctx, makePhase([step]));

      expect(result.assertions[0].status).toBe("skipped");
      expect(result.assertions[0].message).toMatch(/probe not registered/);
      // Non-required skipped step does not fail the phase.
      expect(result.status).not.toBe("failed");
    } finally {
      fs.rmSync(ctx.contextDir, { recursive: true, force: true });
    }
  });

  it("test_required_pending_step_fails_closed", async () => {
    const ctx = freshCtx();
    try {
      const step: AssertionStep = {
        id: "runtime.expected-failure.no-side-effects",
        phase: "runtime",
        implementation: { kind: "pending", ref: "expectedFailureNoSideEffectsProbe" },
        evidencePath: ".e2e/assertions/runtime.expected-failure.no-side-effects.json",
        required: true,
      };
      const orchestrator = new PhaseOrchestrator("runtime");

      const result = await orchestrator.run(ctx, makePhase([step]));

      expect(result.status).toBe("failed");
      expect(result.assertions[0].status).toBe("failed");
      expect(result.assertions[0].message).toMatch(/required pending step not implemented/);
    } finally {
      fs.rmSync(ctx.contextDir, { recursive: true, force: true });
    }
  });

  it("test_security_suite_groups_in_registry_mark_their_steps_as_required", async () => {
    const { assertionGroupForSuite } = await import("../scenarios/assertions/registry.ts");
    for (const suiteId of ["security-shields", "security-policy", "security-injection"]) {
      const group = assertionGroupForSuite(suiteId);
      expect(group, `missing assertion group for suite ${suiteId}`).toBeDefined();
      for (const step of group?.steps ?? []) {
        expect(
          step.required,
          `${suiteId} step ${step.id} must be required so it fails closed`,
        ).toBe(true);
      }
    }
  });

  it("test_expected_failure_no_side_effects_step_is_not_in_active_registry", async () => {
    const { assertionRegistry } = await import("../scenarios/assertions/registry.ts");
    const group = assertionRegistry.groups.find(
      (g) => g.id === "runtime.expected-failure.no-side-effects",
    );
    expect(group).toBeUndefined();
  });
});

describe("framework-owned secret hygiene at the spawn boundary", () => {
  it("test_should_not_persist_secret_shaped_child_output_into_evidence", async () => {
    const ctx = freshCtx();
    try {
      // Child writes secret-shaped tokens (NVIDIA, GitHub, OpenAI,
      // Slack, Bearer-prefixed) on both stdout and stderr, then exits
      // non-zero so stderrTail also flows into result.message. None of
      // those literal tokens may persist anywhere in the evidence.
      const body = [
        'echo "step prints nvapi-1234567890abcdef0123456789"',
        'echo "and ghp_abcdefghijklmnopqrstuvwxyz0123456789"',
        'echo "and sk-abcdefghijklmnopqrstuvwxyz0123456789"',
        'echo "and xoxb-9876543210-fake-bot-token-abc"',
        'echo "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature" 1>&2',
        'exit 7',
      ].join("\n");
      const script = writeTempScript(ctx.contextDir, "leak.sh", body);
      const ref = path.relative(REPO_ROOT, script);
      const step = shellStep("runtime.leak", "runtime", ref);
      const orchestrator = new PhaseOrchestrator("runtime");

      const result = await orchestrator.run(ctx, makePhase([step]));
      const assertion = result.assertions[0];
      const logBody = fs.readFileSync(path.join(ctx.contextDir, ".e2e", "logs", `${step.id}.log`), "utf8");
      const phaseResultJson = fs.readFileSync(
        path.join(ctx.contextDir, ".e2e", "runtime.result.json"),
        "utf8",
      );
      const surfaces = [logBody, assertion.message ?? "", phaseResultJson];

      // Every secret-shaped token canonicalized in
      // src/lib/security/secret-patterns.ts must be redacted on the
      // way to disk, regardless of which surface is read.
      const forbiddenPatterns = [
        /nvapi-[A-Za-z0-9_-]{10,}/,
        /ghp_[A-Za-z0-9_-]{10,}/,
        /sk-[A-Za-z0-9_-]{20,}/,
        /(?:xox[bpas]|xapp)-[A-Za-z0-9-]{10,}/,
        /Bearer\s+[A-Za-z0-9_.+\/=-]{10,}/i,
      ];
      for (const surface of surfaces) {
        for (const pat of forbiddenPatterns) {
          expect(surface, `evidence surface must not contain ${pat}`).not.toMatch(pat);
        }
        expect(surface).toMatch(/<REDACTED>/);
      }
    } finally {
      fs.rmSync(ctx.contextDir, { recursive: true, force: true });
    }
  });

  it("test_should_drop_non_allowlisted_parent_env_unless_declared_in_secretEnv", async () => {
    const ctx = freshCtx();
    const sentinelKey = "SECRET_LEAK_PROBE_TOKEN";
    const previous = process.env[sentinelKey];
    process.env[sentinelKey] = "sentinel-value-that-must-not-leak";
    try {
      const script = writeTempScript(
        ctx.contextDir,
        "env-leak.sh",
        `printenv | sort\n`,
      );
      const ref = path.relative(REPO_ROOT, script);
      // Step does NOT declare SECRET_LEAK_PROBE_TOKEN in secretEnv,
      // so the framework must drop it before spawn.
      const step = shellStep("runtime.env-drop", "runtime", ref);
      const orchestrator = new PhaseOrchestrator("runtime");

      const result = await orchestrator.run(ctx, makePhase([step]));
      const logBody = fs.readFileSync(path.join(ctx.contextDir, ".e2e", "logs", `${step.id}.log`), "utf8");

      expect(result.assertions[0].status).toBe("passed");
      expect(logBody, "non-allowlisted parent env must not reach the child").not.toContain(sentinelKey);
      expect(logBody).not.toContain("sentinel-value-that-must-not-leak");
      // Framework allowlist + overlay still arrive: PATH and E2E_PHASE.
      expect(logBody).toMatch(/^PATH=/m);
      expect(logBody).toMatch(/^E2E_PHASE=runtime$/m);
    } finally {
      if (previous === undefined) delete process.env[sentinelKey];
      else process.env[sentinelKey] = previous;
      fs.rmSync(ctx.contextDir, { recursive: true, force: true });
    }
  });

  it("test_should_pass_declared_secretEnv_through_to_child", async () => {
    const ctx = freshCtx();
    const declaredKey = "NEMOCLAW_TEST_API_KEY"; // matches SECRET_ENV_KEY_SHAPE
    const previous = process.env[declaredKey];
    process.env[declaredKey] = "declared-secret-value-passes-through";
    try {
      const script = writeTempScript(
        ctx.contextDir,
        "declared.sh",
        `printenv ${declaredKey} || echo MISSING\n`,
      );
      const ref = path.relative(REPO_ROOT, script);
      const step: AssertionStep = {
        ...shellStep("runtime.env-declared", "runtime", ref),
        secretEnv: [declaredKey],
      };
      const orchestrator = new PhaseOrchestrator("runtime");

      const result = await orchestrator.run(ctx, makePhase([step]));
      const logBody = fs.readFileSync(path.join(ctx.contextDir, ".e2e", "logs", `${step.id}.log`), "utf8");

      expect(result.assertions[0].status).toBe("passed");
      // Declared secret reaches the child verbatim.
      expect(logBody).toContain("declared-secret-value-passes-through");
      // It is NOT redacted in printenv output because nothing about
      // the literal value matches a token-shape pattern. (Real
      // secrets that match secret-patterns.ts WILL be redacted as a
      // second line of defense; this synthetic value is intentionally
      // shape-free to isolate the env-passthrough behavior.)
    } finally {
      if (previous === undefined) delete process.env[declaredKey];
      else process.env[declaredKey] = previous;
      fs.rmSync(ctx.contextDir, { recursive: true, force: true });
    }
  });

  it("test_should_reject_non_secret_shaped_keys_in_secretEnv_at_runtime", async () => {
    const { buildChildEnv } = await import("../scenarios/orchestrators/redaction.ts");
    expect(() =>
      buildChildEnv(process.env, { secretEnv: ["FOO_VAR"], frameworkOverlay: {} }),
    ).toThrow(/secret-key shape/);
  });

  it("test_should_declare_NVIDIA_API_KEY_only_for_cloud_onboarding_actions", async () => {
    const { compileRunPlans } = await import("../scenarios/compiler.ts");
    const plans = compileRunPlans([
      "ubuntu-repo-cloud-openclaw",
      "gpu-repo-local-ollama-openclaw",
    ]);
    const cloudOnboard = plans[0].phases
      .find((p) => p.name === "onboarding")
      ?.actions.find((a) => a.id.startsWith("onboarding.profile."));
    const localOnboard = plans[1].phases
      .find((p) => p.name === "onboarding")
      ?.actions.find((a) => a.id.startsWith("onboarding.profile."));
    expect(cloudOnboard?.secretEnv).toEqual(["NVIDIA_API_KEY"]);
    expect(localOnboard?.secretEnv).toEqual([]);
  });
});

describe("clients are pass/fail/policy free", () => {
  it("test_should_keep_clients_free_of_pass_fail_and_retry_semantics", () => {
    const observation = new HostCliClient().observeVersion();

    // The client returns a raw act/observe shape only: the command it would
    // run. It must NOT decide pass/fail, attach retry policy, surface a
    // classifier, or expose AssertionResult/PhaseResult-shaped fields.
    expect(observation).toEqual(expect.objectContaining({ command: ["nemoclaw", "--version"] }));
    // Raw act/observe fields are allowed (exitCode/stdout/stderr/timing).
    // Pass/fail and reliability-policy fields are not.
    const forbiddenKeys = [
      "status",
      "attempts",
      "classifier",
      "evidence",
      "retry",
      "timeout",
      "timeoutSeconds",
      "phase",
      "assertions",
      "passed",
      "failed",
    ];
    for (const key of forbiddenKeys) {
      expect(observation).not.toHaveProperty(key);
    }
  });
});
