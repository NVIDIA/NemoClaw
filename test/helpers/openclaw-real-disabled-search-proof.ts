// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildConfig } from "../../scripts/generate-openclaw-config.mts";
import { baseOpenClawGenerationEnv } from "./openclaw-env-fixture";
import { SEARCH_DENIAL_IDENTITY_LIMIT } from "../../nemoclaw/src/denied-search-state.js";
import register, { type OpenClawPluginApi } from "../../nemoclaw/src/index.js";

type ToolResult = { details?: { status?: string }; content: { text: string }[] };
type ToolContext = { runId?: string; sessionKey?: string };
type Hook = Parameters<OpenClawPluginApi["on"]>[1];
type Registry = {
  plugins: unknown[];
  hooks: unknown[];
  trustedToolPolicies: unknown[];
  typedHooks: { pluginId: string; hookName: string; handler: Hook }[];
};

/** Exercise the pinned caller and hook runner, without inference or real tool effects. */
export async function runRealOpenClawDisabledSearchProof(options: { dist: string }): Promise<void> {
  const dist = options.dist;
  const runtime = JSON.parse(fs.readFileSync(path.join(dist, "../package.json"), "utf8"));
  const plugin = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, "../../nemoclaw/package.json"), "utf8"),
  );
  assert.deepEqual(
    plugin.openclaw.compat,
    {
      pluginApi: `>=${runtime.version}`,
      minGatewayVersion: runtime.version,
    },
    "the real-runtime proof must exercise the advertised compatibility minimum",
  );
  const root = fs.mkdtempSync(path.join(path.dirname(dist), ".disabled-search-proof-"));
  const previousState = process.env.OPENCLAW_STATE_DIR;
  const previousConfig = process.env.OPENCLAW_CONFIG_PATH;
  process.env.OPENCLAW_STATE_DIR = root;
  process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
  try {
    async function load(prefix: string, name: string): Promise<unknown> {
      const file = fs
        .readdirSync(dist)
        .find((file) => file.startsWith(prefix) && file.endsWith(".js"));
      assert(file, "pinned runtime module exists: " + prefix);
      const exports = (await import(
        /* @vite-ignore */ pathToFileURL(path.join(dist, file)).href
      )) as Record<string, unknown>;
      const value = Object.values(exports).find(
        (value) => typeof value === "function" && value.name === name,
      );
      assert.equal(typeof value, "function", "pinned export exists: " + name);
      return value;
    }
    const conversationAccessAllowed = (await load(
      "hook-policy-decisions-",
      "resolveConversationAccessAllowed",
    )) as (origin: string, policy: unknown) => boolean;
    const generated = buildConfig({ ...baseOpenClawGenerationEnv(), HOME: root }) as {
      plugins: { entries: { nemoclaw: { hooks?: object } } };
    };
    assert.equal(
      conversationAccessAllowed("config", generated.plugins.entries.nemoclaw.hooks),
      true,
      "the pinned loader must admit the generated NemoClaw prompt, admission and completion hooks",
    );
    const initialize = (await load("hook-runner-global-", "initializeGlobalHookRunner")) as (
      registry: Registry,
    ) => void;
    const runner = (await load("hook-runner-global-", "getGlobalHookRunner")) as () => {
      runBeforeAgentRun(
        event: { prompt: string; messages: unknown[] },
        ctx: ToolContext,
      ): Promise<{ decision?: { outcome: string } } | undefined>;
      runBeforePromptBuild(
        event: { prompt: string; messages: unknown[] },
        ctx: ToolContext,
      ): Promise<{ toolsAllow?: string[] }>;
      runGatewayStop(event: object, ctx: object): Promise<void>;
      runAgentEnd(
        event: { success: boolean; messages: unknown[] },
        ctx: ToolContext,
      ): Promise<void>;
    };
    const reset = (await load("hook-runner-global-", "resetGlobalHookRunner")) as () => void;
    type Tool = {
      name: string;
      description: string;
      parameters: object;
      execute: (id: string, params: object) => Promise<ToolResult>;
    };
    const wrap = (await load(
      "agent-tools.before-tool-call-",
      "wrapToolWithBeforeToolCallHook",
    )) as (
      tool: Tool,
      ctx: ToolContext & { config: OpenClawPluginApi["config"] },
      options: { emitDiagnostics: boolean },
    ) => Tool;
    const applyToolAllowlist = (await load(
      "attempt-tool-construction-plan-",
      "applyEmbeddedAttemptToolsAllow",
    )) as (tools: { name: string }[], toolsAllow?: string[]) => { name: string }[];
    const promptToolPolicy = (await load(
      "tool-surface-plan-",
      "createAgentHarnessPromptToolPolicy",
    )) as (params: { tools: { name: string }[] }) => {
      apply(input: { toolsAllow?: string[] }): {
        tools: { name: string }[];
        callableToolNames: string[];
      };
    };
    const registry: Registry = { plugins: [], hooks: [], typedHooks: [], trustedToolPolicies: [] };
    const config = { tools: { web: { search: { enabled: false } } } };
    const logger = { info() {}, warn() {}, error() {}, debug() {} };
    register({
      id: "nemoclaw",
      name: "NemoClaw",
      config,
      logger,
      registerCommand() {},
      registerProvider() {},
      registerService() {},
      resolvePath: (value) => value,
      on(hookName, handler) {
        registry.typedHooks.push({ pluginId: "nemoclaw", hookName, handler });
      },
    });
    initialize(registry);
    try {
      const availableTools = ["tool_search", "tool_call", "read", "exec", "web_fetch"].map(
        (name) => ({ name }),
      );
      const searchPrompt =
        "Use Tavily to search for the official NVIDIA NemoClaw installation documentation. Return the page title and URL.";
      for (const prompt of [
        searchPrompt,
        "Find the official NemoClaw installation documentation online.",
        "Research online for the official NemoClaw installation documentation",
        "Browse the internet for the official NemoClaw installation documentation.",
        "Could you browse online for the NemoClaw installation documentation?",
      ]) {
        const searchTurn = await runner().runBeforePromptBuild(
          { prompt, messages: [] },
          { runId: "search-prompt" },
        );
        assert.deepEqual(
          searchTurn.toolsAllow,
          [],
          "source plugin narrows the real prompt hook result",
        );
        const submitted = promptToolPolicy({ tools: availableTools }).apply(searchTurn);
        assert.deepEqual(submitted.tools, [], "real prompt policy submits no tools");
        assert.deepEqual(submitted.callableToolNames, [], "discovery controls are not callable");
        assert.deepEqual(
          applyToolAllowlist(availableTools, searchTurn.toolsAllow),
          [],
          "real runtime submits no discovery or substitute tools",
        );
      }
      const localTurn = await runner().runBeforePromptBuild(
        { prompt: "Read /sandbox/README.md.", messages: [] },
        { runId: "local-prompt" },
      );
      assert.deepEqual(
        applyToolAllowlist(availableTools, localTurn.toolsAllow),
        availableTools,
        "the next local turn keeps its tools",
      );
      config.tools.web.search.enabled = true;
      const enabledTurn = await runner().runBeforePromptBuild(
        { prompt: searchPrompt, messages: [] },
        { runId: "enabled-prompt" },
      );
      assert.deepEqual(
        applyToolAllowlist(availableTools, enabledTurn.toolsAllow),
        availableTools,
        "configuration recovery keeps search tools",
      );
      config.tools.web.search.enabled = false;
      let sideEffects = 0;
      async function call(name: string, ctx: ToolContext, id: string): Promise<ToolResult> {
        const tool = wrap(
          {
            name,
            description: "controlled denial witness",
            parameters: {},
            async execute() {
              sideEffects++;
              return { content: [{ text: "executed" }] };
            },
          },
          { ...ctx, config },
          { emitDiagnostics: false },
        );
        return tool.execute(id, name === "read" ? { file_path: "/sandbox/README.md" } : {});
      }
      function blocked(result: ToolResult): void {
        assert.equal(result.details?.status, "blocked");
        assert.match(result.content[0]!.text, /Web search is unavailable in this sandbox/u);
      }
      async function admit(ctx: ToolContext): Promise<void> {
        const result = await runner().runBeforeAgentRun(
          { prompt: "Read README.md.", messages: [] },
          ctx,
        );
        assert.notEqual(
          result?.decision?.outcome,
          "block",
          "real admission gate accepts owned turn",
        );
      }
      await admit({ runId: "denied-run" });
      blocked(await call("web_search", { runId: "denied-run" }, "search-1"));
      blocked(await call("read", { runId: "denied-run" }, "read-1"));
      assert.equal(sideEffects, 0, "real caller stops search and substitute execution");
      await admit({ runId: "other-run" });
      await call("read", { runId: "other-run" }, "read-2");
      assert.equal(sideEffects, 1, "ordinary identified work executes");
      await admit({ sessionKey: "compatible-session" });
      blocked(await call("web_search", { sessionKey: "compatible-session" }, "search-2"));
      blocked(await call("read", { sessionKey: "compatible-session" }, "read-3"));
      blocked(await call("web_search", {}, "search-3"));
      await runner().runAgentEnd({ success: true, messages: [] }, { runId: "other-run" });
      await runner().runAgentEnd({ success: true, messages: [] }, {});
      blocked(await call("read", {}, "read-4"));
      assert.equal(
        sideEffects,
        1,
        "lifecycle events never allow unidentified substitute execution",
      );
      config.tools.web.search.enabled = true;
      await call("web_search", {}, "search-4");
      assert.equal(sideEffects, 2, "enabled search still executes");
      await runner().runGatewayStop({}, {});
      config.tools.web.search.enabled = false;
      for (let index = 0; index < SEARCH_DENIAL_IDENTITY_LIMIT; index++) {
        await admit({ runId: `capacity-${index}`, sessionKey: `capacity-session-${index}` });
      }
      blocked(await call("web_search", { runId: "capacity-0" }, "capacity-search"));
      const excess = await runner().runBeforeAgentRun(
        { prompt: "Read README.md.", messages: [] },
        { runId: "excess" },
      );
      assert.equal(
        excess?.decision?.outcome,
        "block",
        "real gate refuses excess turn before inference",
      );
      blocked(await call("read", { runId: "excess" }, "excess-read"));
      await call("read", { runId: "capacity-1" }, "ordinary-at-capacity");
      assert.equal(sideEffects, 3, "admitted ordinary work remains available at capacity");
      for (let index = 0; index < SEARCH_DENIAL_IDENTITY_LIMIT; index++) {
        await runner().runAgentEnd(
          { success: true, messages: [] },
          { sessionKey: `capacity-session-${index}` },
        );
      }
      await admit({ runId: "recovered" });
      await call("read", { runId: "recovered" }, "recovered-read");
      assert.equal(
        sideEffects,
        4,
        "completion restores capacity without waiting for retention expiry",
      );
    } finally {
      try {
        await runner().runGatewayStop({}, {});
      } finally {
        reset();
      }
    }
  } finally {
    if (previousState === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousState;
    if (previousConfig === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
    else process.env.OPENCLAW_CONFIG_PATH = previousConfig;
    fs.rmSync(root, { recursive: true, force: true });
  }
}
