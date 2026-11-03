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
        event: { prompt?: unknown; messages: unknown[] },
        ctx: ToolContext,
      ): Promise<{ decision?: { outcome: string } } | undefined>;
      runBeforePromptBuild(
        event: { prompt?: unknown; messages: unknown[] },
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
      const availableTools = [
        "tool_search",
        "tool_call",
        "read",
        "exec",
        "memory_search",
        "web_fetch",
      ].map((name) => ({ name }));
      // Prompt vocabulary belongs to runtime-context.test.ts. Keep each real-hook outcome here.
      const searchPrompt =
        "Use Tavily to search for the official NVIDIA NemoClaw installation documentation. Return the page title and URL.";
      const localPrompt = "Search the project for TODO comments.";
      const fetchPrompt = "Fetch https://docs.nvidia.com/nemoclaw/ with web_fetch.";
      const externalPrompts = [
        searchPrompt,
        "Read README.md, then provide today's weather in Paris.",
      ];
      for (const prompt of externalPrompts) {
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
      for (const prompt of [localPrompt, "What time is it?", fetchPrompt]) {
        const localTurn = await runner().runBeforePromptBuild(
          { prompt, messages: [] },
          { runId: "local-prompt" },
        );
        assert.deepEqual(
          promptToolPolicy({ tools: availableTools }).apply(localTurn).tools,
          availableTools,
          "ordinary and supplied requests keep tools in the real prompt policy",
        );
        assert.deepEqual(
          applyToolAllowlist(availableTools, localTurn.toolsAllow),
          availableTools,
          "ordinary and supplied turns keep their tools",
        );
      }
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
      async function call(
        name: string,
        ctx: ToolContext,
        id: string,
        params?: object,
      ): Promise<ToolResult> {
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
        return tool.execute(
          id,
          params ?? (name === "read" ? { file_path: "/sandbox/README.md" } : {}),
        );
      }
      function blocked(result: ToolResult): void {
        assert.equal(result.details?.status, "blocked");
        assert.match(result.content[0]!.text, /Web search is unavailable in this sandbox/u);
      }
      async function admit(ctx: ToolContext, prompt = "What time is it?"): Promise<void> {
        const result = await runner().runBeforeAgentRun({ prompt, messages: [] }, ctx);
        assert.notEqual(
          result?.decision?.outcome,
          "block",
          "real admission gate accepts owned turn",
        );
      }
      const missingPromptContext = { runId: "missing-prompt-evidence" };
      const missingPromptEvent = { messages: [] };
      const missingPromptResult = await runner().runBeforeAgentRun(
        missingPromptEvent,
        missingPromptContext,
      );
      assert.equal(
        missingPromptResult?.decision?.outcome,
        "block",
        "missing prompt evidence blocks admission",
      );
      const missingPromptPolicy = await runner().runBeforePromptBuild(
        missingPromptEvent,
        missingPromptContext,
      );
      assert.deepEqual(missingPromptPolicy.toolsAllow, [], "missing prompt evidence removes tools");
      blocked(await call("read", missingPromptContext, "missing-prompt-read"));
      assert.equal(sideEffects, 0, "a rejected turn cannot execute a local read");
      await runner().runAgentEnd({ success: false, messages: [] }, missingPromptContext);
      for (const prompt of externalPrompts) {
        const context = { runId: "external-first-tool" };
        await admit(context, prompt);
        // Deliberately bypass prompt filtering to exercise the execution guard.
        blocked(await call("read", context, "first-read", { file_path: "README.md" }));
        blocked(await call("memory_search", context, "first-memory", { query: "installation" }));
        blocked(await call("exec", context, "first-exec", { command: "cat README.md" }));
        blocked(
          await call("web_fetch", context, "first-fetch", { url: "https://example.org/install" }),
        );
        blocked(
          await call("tool_call", context, "first-wrapped-read", {
            id: "openclaw:core:read",
            args: { file_path: "README.md" },
          }),
        );
        assert.equal(sideEffects, 0, "admission blocks substitute execution before any search");
        await runner().runAgentEnd({ success: false, messages: [] }, context);
      }
      await admit({ runId: "denied-run" });
      blocked(await call("web_search", { runId: "denied-run" }, "search-1"));
      blocked(await call("read", { runId: "denied-run" }, "read-1"));
      await admit({ runId: "provider-probe" });
      blocked(
        await call("web_fetch", { runId: "provider-probe" }, "provider-probe-1", {
          url: "https://api.tavily.com./search",
        }),
      );
      blocked(await call("read", { runId: "provider-probe" }, "provider-read-1"));
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
        await runner().runBeforePromptBuild(
          { prompt: "Read README.md.", messages: [] },
          { runId: `abandoned-${index}` },
        );
      }
      blocked(await call("web_search", { runId: "abandoned-0" }, "unadmitted-search"));
      for (let index = 0; index < SEARCH_DENIAL_IDENTITY_LIMIT; index++) {
        const context = { runId: `capacity-${index}`, sessionKey: `capacity-session-${index}` };
        await admit(context);
        blocked(await call("web_search", context, `capacity-search-${index}`));
      }
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
      blocked(await call("read", { runId: "capacity-1" }, "denied-at-capacity"));
      assert.equal(
        sideEffects,
        2,
        "retained search denials block substitute execution at capacity",
      );
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
        3,
        "completion restores capacity without waiting for retention expiry",
      );
      for (const [prompt, tool, params] of [
        [localPrompt, "read", { file_path: "README.md" }],
        [fetchPrompt, "web_fetch", { url: "https://docs.nvidia.com/nemoclaw/" }],
      ] as const) {
        const context = { runId: "supplied-source" };
        await admit(context, prompt);
        await runner().runBeforePromptBuild({ prompt, messages: [] }, context);
        const before: number = sideEffects;
        blocked(await call("web_search", context, "supplied-search"));
        await call(tool, context, "supplied-read", params);
        assert.equal(sideEffects, before + 1, "supplied sources remain usable after denied search");
        const mixedPrompt = `${prompt} Then search the web for alternatives.`;
        await admit(context, mixedPrompt);
        await runner().runBeforePromptBuild({ prompt: mixedPrompt, messages: [] }, context);
        blocked(await call(tool, context, "mixed-read", params));
        assert.equal(sideEffects, before + 1, "mixed external research cannot use substitutes");
        await runner().runAgentEnd({ success: true, messages: [] }, context);
        await admit(context);
        blocked(await call("web_search", context, "reused-search"));
        blocked(await call(tool, context, "reused-read", params));
        await runner().runAgentEnd({ success: true, messages: [] }, context);
      }
      const suppliedUrlContext = { runId: "bounded-supplied-url" };
      await admit(suppliedUrlContext, "Fetch https://docs.nvidia.com/nemoclaw/.");
      const beforeSuppliedUrl: number = sideEffects;
      blocked(await call("web_search", suppliedUrlContext, "bounded-search"));
      blocked(
        await call("web_fetch", suppliedUrlContext, "unrelated-fetch", {
          url: "https://example.org/",
        }),
      );
      blocked(await call("read", suppliedUrlContext, "unrelated-local"));
      blocked(
        await call("memory_get", suppliedUrlContext, "unrelated-memory-excerpt", {
          path: "memory/installation.md",
        }),
      );
      blocked(
        await call("memory_search", suppliedUrlContext, "unrelated-memory", {
          query: "installation documentation",
        }),
      );
      blocked(
        await call("tool_call", suppliedUrlContext, "wrapped-unrelated", {
          id: "openclaw:core:web_fetch",
          args: { url: "https://example.org/" },
        }),
      );
      assert.equal(
        sideEffects,
        beforeSuppliedUrl,
        "unrelated sources never reach the real tool executor",
      );
      await call("web_fetch", suppliedUrlContext, "bounded-fetch", {
        url: "https://DOCS.nvidia.com:443/nemoclaw/#intro",
      });
      await call("tool_call", suppliedUrlContext, "wrapped-bounded-fetch", {
        id: "openclaw:core:web_fetch",
        args: { url: "https://docs.nvidia.com/nemoclaw/" },
      });
      assert.equal(
        sideEffects,
        beforeSuppliedUrl + 2,
        "only supplied retrieval targets reach the real tool executor",
      );
      await runner().runAgentEnd({ success: true, messages: [] }, suppliedUrlContext);
      const mixedContext = { runId: "mixed-supplied-sources" };
      const mixedPrompt = "Read README.md and fetch https://example.com/docs.";
      await admit(mixedContext, mixedPrompt);
      const mixedTurn = await runner().runBeforePromptBuild(
        { prompt: mixedPrompt, messages: [] },
        mixedContext,
      );
      assert.deepEqual(
        applyToolAllowlist(availableTools, mixedTurn.toolsAllow),
        availableTools,
        "mixed supplied sources retain the real prompt tools",
      );
      const beforeMixed: number = sideEffects;
      blocked(await call("web_search", mixedContext, "mixed-source-search"));
      await call("read", mixedContext, "mixed-local-read", { file_path: "README.md" });
      await call("web_fetch", mixedContext, "mixed-url-fetch", { url: "https://example.com/docs" });
      await call("tool_call", mixedContext, "mixed-wrapped-read", {
        id: "openclaw:core:read",
        args: { file_path: "README.md" },
      });
      await call("tool_call", mixedContext, "mixed-wrapped-fetch", {
        id: "openclaw:core:web_fetch",
        args: { url: "https://example.com/docs" },
      });
      assert.equal(
        sideEffects,
        beforeMixed + 4,
        "the real executor receives both supplied source kinds",
      );
      blocked(
        await call("web_fetch", mixedContext, "mixed-unrelated-url", {
          url: "https://example.com/other",
        }),
      );
      assert.equal(
        sideEffects,
        beforeMixed + 4,
        "an unrelated URL never reaches the real executor",
      );
      await runner().runAgentEnd({ success: true, messages: [] }, mixedContext);
      for (const wrapped of [false, true]) {
        const context = { runId: `local-discovery-${wrapped}` };
        await admit(context, localPrompt);
        const policy = await runner().runBeforePromptBuild(
          { prompt: localPrompt, messages: [] },
          context,
        );
        assert.deepEqual(
          promptToolPolicy({ tools: availableTools }).apply(policy).tools,
          availableTools,
          "local inspection requests retain tools through the real prompt policy",
        );
        const before: number = sideEffects;
        for (const [name, params] of [
          ["tool_search", { query: "search local project files" }],
          ["tool_describe", { id: "openclaw:core:exec" }],
          ["exec", { command: "rg TODO src/" }],
          ["tool_search", { query: "search memory" }],
          ["memory_search", { query: "TODO" }],
        ] as const) {
          const result = wrapped
            ? await call("tool_call", context, `local-${name}`, {
                id: `openclaw:core:${name}`,
                args: params,
              })
            : await call(name, context, `local-${name}`, params);
          assert.notEqual(result.details?.status, "blocked");
        }
        assert.equal(
          sideEffects,
          before + 5,
          "local discovery and execution reach the real executor",
        );
        blocked(await call("tool_search", context, "web-discovery", { query: "web search" }));
        blocked(await call("exec", context, "denied-substitute", { command: "rg TODO src/" }));
        assert.equal(sideEffects, before + 5, "web discovery still denies substitute execution");
        await runner().runAgentEnd({ success: true, messages: [] }, context);
      }
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
