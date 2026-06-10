// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AssertionResult,
  AssertionStep,
  PhaseAction,
  PhaseActionResult,
  PhaseName,
  PhaseResult,
  RunContext,
  RunPlanPhase,
  TransientClassifier,
} from "../types.ts";
import { superviseChild } from "../../framework/shell/supervisor.ts";
import { validateShellToken } from "../../framework/shell/trusted-command.ts";
import { lookupProbe } from "../probes/registry.ts";
import type { ProbeContext } from "../probes/types.ts";
import { buildChildEnv, redactString } from "./redaction.ts";

// Auto-register the built-in probes the moment the orchestrator is
// imported. This is a deliberate side-effect import: registry state is
// module-scoped and we want every entry point that runs assertions
// (run.ts, ScenarioRunner, framework tests) to see the same wired set
// without each one repeating the registration.
import { registerBuiltinProbes } from "../probes/builtin.ts";
registerBuiltinProbes();

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const DEFAULT_STEP_TIMEOUT_SECONDS = 300;

/**
 * Collect the actual secret values an action / step declared via
 * `secretEnv` so redactString can scrub them verbatim from evidence.
 * Canonical regex shapes catch most token forms, but per-test secret
 * literals may not match any shape and would otherwise leak into the
 * evidence log and stderr tail.
 */
function collectExplicitSecretValues(
  env: NodeJS.ProcessEnv,
  secretEnv: readonly string[] | undefined,
): string[] {
  if (!secretEnv || secretEnv.length === 0) return [];
  const values: string[] = [];
  for (const key of secretEnv) {
    const value = env[key];
    if (typeof value === "string" && value.length > 0) {
      values.push(value);
    }
  }
  return values;
}

interface StepAttemptOutcome {
  status: "passed" | "failed" | "skipped";
  classifier?: TransientClassifier;
  message?: string;
  evidence?: string;
}

// Heuristic transient classifier for shell step refs that don't print
// their own classifier hint. Phase orchestrators own classification;
// clients/scripts do not.
function classifierForRef(ref: string): TransientClassifier {
  if (/provider|inference|chat-completion|cloudflared|tunnel/i.test(ref)) {
    // Use case-insensitive matching here too; the outer guard is /i, so
    // mixed-case refs (Tunnel, Cloudflared) must still classify as
    // external-tunnel rather than fall through to provider-transient.
    return /tunnel|cloudflared/i.test(ref) ? "external-tunnel" : "provider-transient";
  }
  if (/gateway/i.test(ref)) {
    return "gateway-transient";
  }
  if (/event-capture|tui|chat-events/i.test(ref)) {
    return "empty-event-capture";
  }
  return "runner-infra";
}

/**
 * Build the typed ProbeContext handed to a probe runner. Mirrors the
 * subset of state that shell steps already get via
 * ${E2E_CONTEXT_DIR}/context.env, but parsed up front so probe code
 * doesn't reach into the file system itself.
 */
function buildProbeContext(ctx: RunContext, step: AssertionStep): ProbeContext {
  const contextEnvPath = path.join(ctx.contextDir, "context.env");
  const contextEnv: Record<string, string> = {};
  if (fs.existsSync(contextEnvPath)) {
    const raw = fs.readFileSync(contextEnvPath, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq);
      let value = trimmed.slice(eq + 1);
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      contextEnv[key] = value;
    }
  }
  const evidenceRel = step.evidencePath ?? `.e2e/assertions/${step.id}.json`;
  const evidencePath = path.isAbsolute(evidenceRel)
    ? evidenceRel
    : path.join(ctx.contextDir, evidenceRel);
  return {
    contextDir: ctx.contextDir,
    evidencePath,
    contextEnv,
    sandboxName: contextEnv.E2E_SANDBOX_NAME ?? null,
    gatewayUrl: contextEnv.E2E_GATEWAY_URL ?? null,
    repoRoot: REPO_ROOT,
  };
}

export class PhaseOrchestrator {
  constructor(private readonly phaseName: PhaseName) {}

  async run(ctx: RunContext, phase: RunPlanPhase): Promise<PhaseResult> {
    const actions: PhaseActionResult[] = [];
    let actionFailed = false;
    for (const action of phase.actions) {
      const actionResult = await this.runAction(ctx, action);
      actions.push(actionResult);
      if (actionResult.status === "failed") {
        actionFailed = true;
        // Spec failure-layer rule: setup failure must not let assertions
        // run and accidentally pass. Stop the phase here.
        break;
      }
    }
    const assertions: AssertionResult[] = [];
    if (!actionFailed) {
      for (const group of phase.assertionGroups) {
        for (const step of group.steps) {
          assertions.push(await this.runStep(ctx, step));
        }
      }
    }
    const assertionsFailed = assertions.some((assertion) => assertion.status === "failed");
    const allSkipped =
      !actionFailed &&
      assertions.length > 0 &&
      assertions.every((assertion) => assertion.status === "skipped");
    let status: PhaseResult["status"];
    if (actionFailed || assertionsFailed) {
      status = "failed";
    } else if (allSkipped || (actions.length === 0 && assertions.length === 0)) {
      status = "skipped";
    } else {
      status = "passed";
    }
    const result: PhaseResult = { phase: this.phaseName, status, actions, assertions };
    this.writePhaseResult(ctx, result);
    return result;
  }

  private async runAction(ctx: RunContext, action: PhaseAction): Promise<PhaseActionResult> {
    const startedAt = Date.now();
    const scriptPath = path.isAbsolute(action.scriptRef)
      ? action.scriptRef
      : path.resolve(REPO_ROOT, action.scriptRef);
    if (!fs.existsSync(scriptPath)) {
      return {
        id: action.id,
        status: "failed",
        durationMs: Date.now() - startedAt,
        message: `phase action ${action.id} script not found: ${scriptPath}`,
      };
    }
    const timeoutSeconds = action.timeoutSeconds ?? DEFAULT_STEP_TIMEOUT_SECONDS;
    const logDir = path.join(ctx.contextDir, ".e2e", "actions");
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, `${action.id}.log`);

    // Compose the bash invocation. shell-fn sources the dispatcher and
    // calls the named function with its single positional arg; shell
    // executes the script directly. We always go through bash -lc so
    // sourced shell helpers see a normal interactive-style env.
    const dispatchAction = path.join(
      REPO_ROOT,
      "test/e2e-scenario/nemoclaw_scenarios/dispatch-action.sh",
    );
    const useDispatchLauncher = action.kind === "shell-fn" && fs.existsSync(dispatchAction);
    const bashArgs: string[] = useDispatchLauncher
      ? [dispatchAction, action.fn ?? "", action.arg ?? "", scriptPath]
      : [scriptPath, ...(action.arg ? [action.arg] : [])];

    // Framework-owned secret hygiene at the spawn boundary. The child
    // gets a minimal allowlisted env plus only the secrets this action
    // explicitly declared via PhaseAction.secretEnv. See
    // orchestrators/redaction.ts for the full contract.
    const env = buildChildEnv(process.env, {
      secretEnv: action.secretEnv,
      frameworkOverlay: {
        E2E_CONTEXT_DIR: ctx.contextDir,
        E2E_PHASE: action.phase,
        E2E_ACTION_ID: action.id,
      },
    });

    let safeArgs: string[];
    try {
      safeArgs = bashArgs.map((arg, idx) => validateShellToken(arg, `runAction bashArgs[${idx}]`));
    } catch (err) {
      return {
        id: action.id,
        status: "failed",
        durationMs: Date.now() - startedAt,
        message: `phase action ${action.id} rejected at the trusted-command boundary: ${redactString(err instanceof Error ? err.message : String(err))}`,
      };
    }
    // Explicit secret values declared via action.secretEnv must be
    // scrubbed verbatim from evidence, not only when they happen to
    // match a canonical regex shape. Gather the actual values the
    // child sees so redactString redacts them as well.
    const explicitSecretValues = collectExplicitSecretValues(env, action.secretEnv);
    const redactAction = (text: string): string => redactString(text, explicitSecretValues);
    const child = spawn("bash", safeArgs, { env, cwd: REPO_ROOT, detached: true });
    const logStream = fs.createWriteStream(logPath);
    let stderrTail = "";
    const finishLog = (): Promise<void> =>
      new Promise((res) => {
        if ((logStream as unknown as { closed?: boolean }).closed) {
          res();
          return;
        }
        logStream.once("finish", () => res());
        logStream.once("error", () => res());
        logStream.end();
      });
    // Every byte from the child passes through redactAction before
    // hitting the evidence log or the stderr tail; raw output never
    // touches disk or PhaseActionResult.message. Explicit secretEnv
    // values are sanitised alongside the canonical regex shapes.
    const supervised = await superviseChild(child, {
      timeoutMs: timeoutSeconds * 1_000,
      onStdout: (chunk) => {
        logStream.write(redactAction(chunk));
      },
      onStderr: (chunk) => {
        const redacted = redactAction(chunk);
        logStream.write(redacted);
        stderrTail = (stderrTail + redacted).slice(-4096);
      },
    });
    await finishLog();

    const durationMs = Date.now() - startedAt;
    if (supervised.spawnError) {
      return {
        id: action.id,
        status: "failed",
        durationMs,
        evidence: logPath,
        message: redactAction(
          `phase action ${action.id} spawn error: ${supervised.spawnError.message}`,
        ),
      };
    }
    if (supervised.timedOut) {
      return {
        id: action.id,
        status: "failed",
        durationMs,
        evidence: logPath,
        message: `phase action ${action.id} exceeded ${timeoutSeconds}s (signal=${supervised.signal ?? "SIGTERM"})`,
      };
    }
    if (supervised.exitCode === 0) {
      // Publish the action's evidence log under a stable alias for
      // legacy assertions that reference fixed filenames
      // (onboard.log, install.log, ...). Best-effort; alias copy
      // failures do not fail the action.
      if (action.aliasPath) {
        try {
          const aliasFull = path.isAbsolute(action.aliasPath)
            ? action.aliasPath
            : path.join(ctx.contextDir, action.aliasPath);
          fs.mkdirSync(path.dirname(aliasFull), { recursive: true });
          fs.copyFileSync(logPath, aliasFull);
        } catch {
          /* alias is a convenience; never fail action on copy */
        }
      }
      return { id: action.id, status: "passed", durationMs, evidence: logPath };
    }
    return {
      id: action.id,
      status: "failed",
      durationMs,
      evidence: logPath,
      message: `phase action ${action.id} exit ${supervised.exitCode ?? "null"}: ${stderrTail.split("\n").slice(-3).join(" | ").trim()}`,
    };
  }

  private async runStep(ctx: RunContext, step: AssertionStep): Promise<AssertionResult> {
    const startedAt = Date.now();
    const rawAttempts = step.reliability?.retry?.attempts;
    const maxAttempts =
      typeof rawAttempts === "number" && Number.isFinite(rawAttempts)
        ? Math.max(1, Math.floor(rawAttempts))
        : 1;
    let attempts = 0;
    let lastOutcome: StepAttemptOutcome = { status: "failed", message: "step did not run" };
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attempts = attempt;
      lastOutcome = await this.executeStep(ctx, step, attempt);
      if (lastOutcome.status === "passed" || lastOutcome.status === "skipped") {
        return {
          id: step.id,
          status: lastOutcome.status,
          attempts,
          durationMs: Date.now() - startedAt,
          classifier: attempt > 1 ? step.reliability?.retry?.on[0] : lastOutcome.classifier,
          evidence: lastOutcome.evidence ?? step.evidencePath,
          message: lastOutcome.message,
        };
      }
      if (!this.canRetry(step, lastOutcome.classifier, attempt, maxAttempts)) {
        break;
      }
    }
    return {
      id: step.id,
      status: "failed",
      attempts,
      durationMs: Date.now() - startedAt,
      classifier: lastOutcome.classifier,
      evidence: lastOutcome.evidence ?? step.evidencePath,
      message: lastOutcome.message,
    };
  }

  private canRetry(
    step: AssertionStep,
    classifier: TransientClassifier | undefined,
    attempt: number,
    maxAttempts: number,
  ): boolean {
    if (attempt >= maxAttempts || !classifier) {
      return false;
    }
    return step.reliability?.retry?.on.includes(classifier) ?? false;
  }

  private async executeStep(
    ctx: RunContext,
    step: AssertionStep,
    _attempt: number,
  ): Promise<StepAttemptOutcome> {
    const kind = step.implementation?.kind;
    if (kind === "shell") {
      return this.runShellStep(ctx, step);
    }
    if (kind === "probe") {
      const ref = step.implementation?.ref ?? "<no ref>";
      const probe = lookupProbe(ref);
      if (!probe) {
        // Probe is referenced by the typed registry but no
        // implementation has been registered yet. Surface as
        // skipped — unless the step is marked required, in which
        // case fail closed so security-sensitive suites never
        // pass on a missing probe.
        if (step.required) {
          return {
            status: "failed",
            classifier: "runner-infra",
            message: `required probe not registered: ${ref} (step ${step.id})`,
          };
        }
        return { status: "skipped", message: `probe not registered: ${ref}` };
      }
      const probeCtx = buildProbeContext(ctx, step);
      try {
        const outcome = await probe(probeCtx);
        return {
          status: outcome.status,
          classifier: outcome.classifier,
          message: outcome.message,
          evidence: outcome.evidence ?? probeCtx.evidencePath,
        };
      } catch (err) {
        // Probes must not throw — but a thrown error must NEVER
        // cause an unobservable failure. Convert to a failed
        // outcome with a redacted message so the orchestrator's
        // result aggregation still records evidence.
        const message = err instanceof Error ? err.message : String(err);
        return {
          status: "failed",
          message: redactString(`probe ${ref} threw: ${message}`),
          evidence: probeCtx.evidencePath,
        };
      }
    }
    if (kind === "pending") {
      // pending steps surface as skipped with the placeholder ref so
      // gaps are visible in plan output and phase results. Required
      // pending steps (e.g. expected-failure side-effect validators
      // for negative scenarios) fail closed instead — the run cannot
      // honestly pass while the contract is unimplemented.
      const ref = step.implementation?.ref ?? "";
      if (step.required) {
        return {
          status: "failed",
          classifier: "runner-infra",
          message: `required pending step not implemented: ${ref} (step ${step.id})`,
        };
      }
      return { status: "skipped", message: `pending: ${ref}` };
    }
    throw new Error(`Unknown assertion step kind for ${step.id}: ${String(kind)}`);
  }

  private async runShellStep(ctx: RunContext, step: AssertionStep): Promise<StepAttemptOutcome> {
    const ref = step.implementation?.ref;
    if (!ref) {
      return { status: "failed", message: `shell step ${step.id} missing implementation.ref` };
    }
    const scriptPath = path.isAbsolute(ref) ? ref : path.resolve(REPO_ROOT, ref);
    if (!fs.existsSync(scriptPath)) {
      return { status: "failed", message: `shell step ${step.id} script not found: ${scriptPath}` };
    }

    const timeoutSeconds = step.reliability?.timeoutSeconds ?? DEFAULT_STEP_TIMEOUT_SECONDS;
    const logDir = path.join(ctx.contextDir, ".e2e", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, `${step.id}.log`);

    // Framework-owned secret hygiene at the spawn boundary (mirrors
    // runAction). The shell step's child gets only the framework
    // allowlist + scenario context.env keys + step.secretEnv
    // declarations. See orchestrators/redaction.ts.
    const env = buildChildEnv(process.env, {
      secretEnv: step.secretEnv,
      frameworkOverlay: {
        E2E_CONTEXT_DIR: ctx.contextDir,
        E2E_STEP_ID: step.id,
        E2E_PHASE: step.phase,
      },
    });
    // Surface scenario-derived context (E2E_SCENARIO, E2E_SANDBOX_NAME,
    // E2E_GATEWAY_URL, etc.) that the framework wrote at the start of the
    // run and that environment+onboarding phases extended via
    // e2e_context_set. The shell context library writes to
    // ${E2E_CONTEXT_DIR}/context.env, NOT to ${E2E_CONTEXT_DIR}/.e2e/.
    const contextEnvPath = path.join(ctx.contextDir, "context.env");
    if (fs.existsSync(contextEnvPath)) {
      const contextEnv = fs.readFileSync(contextEnvPath, "utf8");
      for (const line of contextEnv.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
          continue;
        }
        const eq = trimmed.indexOf("=");
        if (eq <= 0) {
          continue;
        }
        const key = trimmed.slice(0, eq);
        let value = trimmed.slice(eq + 1);
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        env[key] = value;
      }
    }

    // detached: true puts the child (and any of its children, e.g. a `sleep`
    // spawned by bash) into its own process group. The supervisor sends
    // signals to the negative pid so the whole group dies on timeout.
    // Without this, bash ignores SIGTERM until its current foreground
    // command (e.g. sleep) returns, and timeouts effectively don't work.
    let safeArg: string;
    try {
      safeArg = validateShellToken(scriptPath, "runShellStep scriptPath");
    } catch (err) {
      return {
        status: "failed",
        classifier: "runner-infra",
        message: `shell step ${step.id} rejected at the trusted-command boundary: ${redactString(err instanceof Error ? err.message : String(err))}`,
      };
    }
    // Explicit secret values declared via step.secretEnv must be
    // scrubbed verbatim from evidence, not only when they happen to
    // match a canonical regex shape.
    const explicitSecretValues = collectExplicitSecretValues(env, step.secretEnv);
    const redactStep = (text: string): string => redactString(text, explicitSecretValues);
    const child = spawn("bash", [safeArg], { env, cwd: REPO_ROOT, detached: true });
    const logStream = fs.createWriteStream(logPath);
    let stderrTail = "";
    // Wait for the log writeStream to fully flush before resolving so
    // callers can synchronously read the evidence file. Without this, the
    // child 'close' event fires before the WriteStream finishes draining,
    // and tests/orchestrators see an empty log file.
    const finishLog = (): Promise<void> =>
      new Promise((res) => {
        if ((logStream as unknown as { closed?: boolean }).closed) {
          res();
          return;
        }
        logStream.once("finish", () => res());
        logStream.once("error", () => res());
        logStream.end();
      });
    // Redact at the I/O boundary; raw bytes from the child must not
    // reach the evidence log or the stderr tail that flows into
    // step result.message. Explicit secretEnv values are sanitised
    // alongside the canonical regex shapes.
    const supervised = await superviseChild(child, {
      timeoutMs: timeoutSeconds * 1_000,
      onStdout: (chunk) => {
        logStream.write(redactStep(chunk));
      },
      onStderr: (chunk) => {
        const redacted = redactStep(chunk);
        logStream.write(redacted);
        stderrTail = (stderrTail + redacted).slice(-4096);
      },
    });
    await finishLog();

    if (supervised.spawnError) {
      return {
        status: "failed",
        message: redactStep(`shell step ${step.id} spawn error: ${supervised.spawnError.message}`),
        evidence: logPath,
      };
    }
    if (supervised.timedOut) {
      return {
        status: "failed",
        classifier: "runner-infra",
        message: `shell step ${step.id} exceeded ${timeoutSeconds}s (signal=${supervised.signal ?? "SIGTERM"})`,
        evidence: logPath,
      };
    }
    if (supervised.exitCode === 0) {
      return { status: "passed", evidence: logPath };
    }
    return {
      status: "failed",
      classifier: classifierForRef(ref),
      message: `shell step ${step.id} exit ${supervised.exitCode ?? "null"}: ${stderrTail.split("\n").slice(-3).join(" | ").trim()}`,
      evidence: logPath,
    };
  }

  private writePhaseResult(ctx: RunContext, result: PhaseResult) {
    const outputDir = path.join(ctx.contextDir, ".e2e");
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputDir, `${result.phase}.result.json`),
      `${JSON.stringify(result, null, 2)}\n`,
    );
  }
}
