// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const { parseGatewayInference } = require("../../bin/lib/inference-config");
const { resolveOpenshell } = require("../../bin/lib/resolve-openshell");
const { shellQuote, validateName } = require("../../bin/lib/runner");

class TurnOrchestrationError extends Error {
  constructor(message, result, cause) {
    super(message);
    this.name = "TurnOrchestrationError";
    this.result = result;
    this.cause = cause;
  }
}

function loadPlan(planPath) {
  if (!planPath) {
    throw new Error("Plan path is required.");
  }
  return JSON.parse(fs.readFileSync(planPath, "utf8"));
}

function deriveRouteModel(turn) {
  if (typeof turn?.routeModel === "string" && turn.routeModel.trim()) {
    return turn.routeModel.trim();
  }
  if (typeof turn?.model !== "string" || !turn.model.trim()) {
    throw new Error(`Turn '${turn?.agent || "unknown"}' is missing a model.`);
  }
  const model = turn.model.trim();
  if (model.startsWith("inference/")) {
    return model.slice("inference/".length);
  }
  if (!model.includes("/")) {
    return model;
  }
  throw new Error(
    `Turn '${turn.agent}' uses model '${model}' which cannot be mapped to an inference route automatically. Set routeModel explicitly.`
  );
}

function validatePlan(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw new Error("Turn orchestration plan must be a JSON object.");
  }
  validateName(plan.sandbox, "sandbox");
  if (typeof plan.task !== "string" || !plan.task.trim()) {
    throw new Error("Plan task is required.");
  }
  if (!Array.isArray(plan.turns) || plan.turns.length === 0) {
    throw new Error("Plan must include at least one turn.");
  }

  const turns = plan.turns.map((turn, index) => {
    if (!turn || typeof turn !== "object" || Array.isArray(turn)) {
      throw new Error(`Turn ${index + 1} must be an object.`);
    }
    validateName(turn.agent, `turn ${index + 1} agent`);
    if (
      (typeof turn.instructions !== "string" || !turn.instructions.trim()) &&
      (typeof turn.message !== "string" || !turn.message.trim())
    ) {
      throw new Error(
        `Turn '${turn.agent}' must provide either instructions or a full message.`
      );
    }

    return {
      ...turn,
      agent: turn.agent.trim(),
      model: String(turn.model || "").trim(),
      routeModel: deriveRouteModel(turn),
    };
  });

  return {
    ...plan,
    sandbox: plan.sandbox.trim(),
    provider: typeof plan.provider === "string" && plan.provider.trim()
      ? plan.provider.trim()
      : null,
    task: plan.task.trim(),
    sharedInstructions:
      typeof plan.sharedInstructions === "string" && plan.sharedInstructions.trim()
        ? plan.sharedInstructions.trim()
        : null,
    keepRoute: Boolean(plan.keepRoute),
    maxTranscriptChars:
      Number.isInteger(plan.maxTranscriptChars) && plan.maxTranscriptChars > 0
        ? plan.maxTranscriptChars
        : 12000,
    turns,
  };
}

function renderTranscript(history, maxChars) {
  if (!Array.isArray(history) || history.length === 0) {
    return "None yet.";
  }

  const blocks = [];
  for (const entry of history) {
    blocks.push([
      `Turn ${entry.index}: ${entry.agent}`,
      `Model: ${entry.model}`,
      `Prompt:\n${entry.prompt}`,
      `Response:\n${entry.responseText || "(no response)"}`,
    ].join("\n"));
  }

  const joined = blocks.join("\n\n");
  if (!maxChars || joined.length <= maxChars) {
    return joined;
  }

  return `... transcript truncated to the most recent ${maxChars} characters ...\n${joined.slice(-maxChars)}`;
}

function replacePlaceholders(message, context) {
  return message
    .replaceAll("{{TASK}}", context.task)
    .replaceAll("{{TRANSCRIPT}}", context.transcript)
    .replaceAll("{{LAST_RESPONSE}}", context.lastResponse);
}

function renderTurnMessage(plan, turn, history) {
  const transcript = renderTranscript(history, plan.maxTranscriptChars);
  const lastResponse = history.length > 0
    ? history[history.length - 1].responseText || "(no response)"
    : "None yet.";
  const context = {
    lastResponse,
    task: plan.task,
    transcript,
  };

  if (typeof turn.message === "string" && turn.message.trim()) {
    return replacePlaceholders(turn.message.trim(), context);
  }

  return [
    plan.sharedInstructions ? `Shared operating rules:\n${plan.sharedInstructions}` : null,
    `Overall task:\n${plan.task}`,
    `Prior turn transcript:\n${transcript}`,
    `Current assignment for ${turn.agent}:\n${turn.instructions.trim()}`,
    "Return plain text only.",
  ].filter(Boolean).join("\n\n");
}

function parseJsonFromOutput(output) {
  const text = String(output || "").trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    // Fall back to scanning for the final JSON object after noisy logs.
  }

  const closingIndex = text.lastIndexOf("}");
  if (closingIndex === -1) return null;

  for (let index = text.indexOf("{"); index !== -1 && index < closingIndex; index = text.indexOf("{", index + 1)) {
    try {
      return JSON.parse(text.slice(index, closingIndex + 1));
    } catch {
      continue;
    }
  }

  return null;
}

function extractAgentText(parsed, fallbackOutput) {
  const payloads = parsed?.payloads;
  if (Array.isArray(payloads)) {
    const parts = payloads.flatMap((payload) => {
      if (typeof payload === "string") return [payload];
      if (!payload || typeof payload !== "object") return [];
      if (typeof payload.text === "string") return [payload.text];
      if (Array.isArray(payload.content)) {
        return payload.content
          .filter((item) => item && typeof item.text === "string")
          .map((item) => item.text);
      }
      if (typeof payload.message === "string") return [payload.message];
      return [];
    });
    if (parts.length > 0) {
      return parts.join("\n\n").trim();
    }
  }

  return String(fallbackOutput || "").trim();
}

function buildOpenClawAgentCommand({ agent, message, sessionId, timeoutSeconds }) {
  const args = ["openclaw", "agent", "--agent", shellQuote(agent)];
  args.push(
    "--local",
    "--timeout",
    String(Number(timeoutSeconds)),
    "--session-id",
    shellQuote(sessionId),
    "--json",
    "-m",
    shellQuote(message)
  );
  return args.join(" ");
}

function acquireLock(lockPath) {
  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2);

  try {
    fs.writeFileSync(lockPath, payload, { encoding: "utf8", flag: "wx" });
    return { path: lockPath };
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
  }

  let existing;
  try {
    existing = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {
    existing = {};
  }

  if (existing.pid) {
    try {
      process.kill(existing.pid, 0);
      throw new Error(
        `Another turn orchestrator is already active for this sandbox (pid ${existing.pid}). Remove '${lockPath}' only if that process is gone.`
      );
    } catch (error) {
      if (error.code !== "ESRCH") {
        throw error;
      }
    }
  }

  fs.rmSync(lockPath, { force: true });
  fs.writeFileSync(lockPath, payload, { encoding: "utf8", flag: "wx" });
  return { path: lockPath, replacedStaleLock: true };
}

function releaseLock(lock) {
  if (!lock?.path) return;
  fs.rmSync(lock.path, { force: true });
}

function createHostRuntime(options = {}) {
  const openshellPath = options.openshellPath || resolveOpenshell();
  const runSpawnSync = options.spawnSyncImpl || spawnSync;
  const skipRouteVerification = Boolean(options.skipRouteVerification);
  const sshBinary = options.sshBinary || "ssh";

  if (!openshellPath) {
    throw new Error("openshell not found on PATH or in common locations.");
  }

  const run = (command, args, opts = {}) => {
    const result = runSpawnSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...opts,
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0 && !opts.ignoreError) {
      const stderr = String(result.stderr || "").trim();
      throw new Error(`${command} ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
    }
    return result;
  };

  const getCurrentRoute = () => {
    const result = run(openshellPath, ["inference", "get"], { ignoreError: true });
    return parseGatewayInference(result.stdout || "");
  };

  const setRoute = (provider, model) => {
    const args = ["inference", "set"];
    if (skipRouteVerification) {
      args.push("--no-verify");
    }
    args.push("--provider", provider, "--model", model);
    run(openshellPath, args);
  };

  const runAgentTurn = ({ agent, message, sandbox, sessionId, timeoutSeconds }) => {
    validateName(sandbox, "sandbox");
    validateName(agent, "agent");

    const sshConfig = run(openshellPath, ["sandbox", "ssh-config", sandbox]).stdout;
    const configPath = path.join(
      os.tmpdir(),
      `nemoclaw-turn-${sandbox}-${process.pid}-${Date.now()}.sshconf`
    );
    fs.writeFileSync(configPath, sshConfig, "utf8");

    try {
      const remoteScript = [
        "set -e",
        "export OPENCLAW_CONFIG_PATH=/tmp/nemoclaw/openclaw.json",
        buildOpenClawAgentCommand({ agent, message, sessionId, timeoutSeconds }),
      ].join("\n");
      const result = run(
        sshBinary,
        ["-T", "-F", configPath, `openshell-${sandbox}`, `bash -lc ${shellQuote(remoteScript)}`],
        { ignoreError: true }
      );
      const parsed = parseJsonFromOutput(result.stdout);
      const responseText = extractAgentText(parsed, result.stdout);

      if (result.status !== 0) {
        const error = /** @type {Error & {stdout?: unknown, stderr?: unknown, parsed?: unknown}} */ (
          new Error(
          `Agent '${agent}' failed with exit ${result.status}${result.stderr ? `: ${String(result.stderr).trim()}` : ""}`
          )
        );
        error.stdout = result.stdout;
        error.stderr = result.stderr;
        error.parsed = parsed;
        throw error;
      }

      return {
        parsed,
        responseText,
        stderr: result.stderr,
        stdout: result.stdout,
      };
    } finally {
      fs.rmSync(configPath, { force: true });
    }
  };

  return {
    getCurrentRoute,
    runAgentTurn,
    setRoute,
  };
}

function defaultSessionId(prefix, turn, index) {
  return `${prefix}-${index + 1}-${turn.agent}-${Date.now()}`;
}

async function executeTurns(plan, result, runtime, createSessionId, timeoutSeconds, log, originalRoute) {
  for (const [index, turn] of plan.turns.entries()) {
    const provider = turn.provider || plan.provider || originalRoute?.provider || "ollama-local";
    const prompt = renderTurnMessage(plan, turn, result.turns);
    const sessionId = createSessionId(turn, index);
    const startedAt = new Date().toISOString();

    log(`Switching route to ${provider}/${turn.routeModel} for ${turn.agent}`);
    await Promise.resolve(runtime.setRoute(provider, turn.routeModel));

    log(`Running turn ${index + 1}/${plan.turns.length} with agent ${turn.agent}`);
    const response = await Promise.resolve(runtime.runAgentTurn({
      agent: turn.agent,
      message: prompt,
      sandbox: plan.sandbox,
      sessionId,
      timeoutSeconds,
    }));

    result.turns.push({
      agent: turn.agent,
      finishedAt: new Date().toISOString(),
      index: index + 1,
      model: turn.model,
      prompt,
      provider,
      response: response.parsed,
      responseText: response.responseText,
      routeModel: turn.routeModel,
      sessionId,
      startedAt,
    });
  }
}

async function restoreOriginalRoute(plan, result, runtime, originalRoute, log) {
  if (plan.keepRoute || !originalRoute?.provider || !originalRoute?.model) {
    return null;
  }

  try {
    log(`Restoring route to ${originalRoute.provider}/${originalRoute.model}`);
    await Promise.resolve(runtime.setRoute(originalRoute.provider, originalRoute.model));
    result.restoredRoute = originalRoute;
    return null;
  } catch (error) {
    result.restoreError = {
      message: error.message,
      name: error.name,
    };
    return error;
  }
}

async function orchestrateTurns(planInput, options = {}) {
  const plan = validatePlan(planInput);
  const runtime = options.runtime || createHostRuntime(options);
  const log = typeof options.log === "function" ? options.log : () => {};
  const timeoutSeconds = Number(options.timeoutSeconds || 180);
  const sessionPrefix = options.sessionPrefix || "turn";
  const createSessionId =
    typeof options.createSessionId === "function"
      ? options.createSessionId
      : (turn, index) => defaultSessionId(sessionPrefix, turn, index);
  const lockPath = options.lockPath || path.join(os.tmpdir(), `nemoclaw-turn-orchestrator-${plan.sandbox}.lock`);

  const result = {
    finishedAt: null,
    lockPath,
    originalRoute: null,
    restoredRoute: null,
    sandbox: plan.sandbox,
    startedAt: new Date().toISOString(),
    task: plan.task,
    turns: [],
  };

  let lock = null;
  let originalRoute = null;
  let orchestrationError = null;

  try {
    lock = acquireLock(lockPath);
    log(`Acquired lock ${lockPath}`);
    originalRoute = await Promise.resolve(runtime.getCurrentRoute());
    result.originalRoute = originalRoute;

    await executeTurns(
      plan,
      result,
      runtime,
      createSessionId,
      timeoutSeconds,
      log,
      originalRoute
    );
  } catch (error) {
    orchestrationError = error;
    result.error = {
      message: error.message,
      name: error.name,
    };
  }

  const restoreError = await restoreOriginalRoute(plan, result, runtime, originalRoute, log);

  releaseLock(lock);
  result.finishedAt = new Date().toISOString();

  if (orchestrationError || restoreError) {
    const message = restoreError
      ? `Turn orchestration did not complete cleanly: ${restoreError.message}`
      : `Turn orchestration failed: ${orchestrationError.message}`;
    throw new TurnOrchestrationError(message, result, restoreError || orchestrationError);
  }

  return result;
}

function writeTurnReport(outputPath, result) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n", "utf8");
}

module.exports = {
  TurnOrchestrationError,
  acquireLock,
  buildOpenClawAgentCommand,
  createHostRuntime,
  deriveRouteModel,
  extractAgentText,
  loadPlan,
  orchestrateTurns,
  releaseLock,
  renderTurnMessage,
  renderTranscript,
  validatePlan,
  writeTurnReport,
};
