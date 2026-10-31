// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { loadState } from "./blueprint/state.js";
import type { SuppliedSearchSources } from "./denied-search-state.js";
import type { NemoClawConfig, OpenClawConfig, OpenClawPluginApi } from "./index.js";
import { configuredSearchEnabled } from "./search-config.js";
import * as importedSandboxName from "./shared/sandbox-name.cjs";

const sourceOrGeneratedSandboxName = importedSandboxName as typeof importedSandboxName & {
  default?: typeof importedSandboxName;
};
const { isValidName } = sourceOrGeneratedSandboxName.default ?? sourceOrGeneratedSandboxName;

interface RuntimeSummary {
  sandboxName: string;
  sandboxPhase: string | null;
  networkLines: string[];
  filesystemLines: string[];
}

const STATIC_NETWORK_LINES = [
  "Outbound network access is deny-by-default, but allowed endpoints work. Try the request before declaring a host unreachable.",
  "OpenShell policy denials can raise operator approval requests. Report the actual error when a request fails.",
];

const STATIC_FILESYSTEM_LINES = [
  "filesystem and process access are scoped to the sandbox, not the host; do not assume access to host paths outside it",
  "within the sandbox you can create, edit, and run files (for example in /tmp or /sandbox) using your file and shell tools; try the operation and report if it fails rather than assuming it is unavailable",
];

/**
 * Resolves the active sandbox name by preferring the persisted state value
 * over the plugin configuration default.
 */
function getSandboxName(pluginConfig: NemoClawConfig): string {
  return loadState().sandboxName ?? pluginConfig.sandboxName;
}

/**
 * Returns static sandbox context without invoking OpenShell subprocesses.
 *
 * The gateway-loaded plugin must pass OpenClaw's install-time safety scanner,
 * so this intentionally avoids shelling out for live policy details. A future
 * implementation can replace this with Gateway API reads if OpenClaw exposes
 * policy state to plugins without subprocess execution.
 */
export function getRuntimeSummary(pluginConfig: NemoClawConfig): RuntimeSummary {
  let sandboxName = pluginConfig.sandboxName;
  try {
    sandboxName = getSandboxName(pluginConfig);
  } catch {
    // Keep the configured default if persisted state cannot be read.
  }

  return {
    sandboxName,
    sandboxPhase: null,
    networkLines: STATIC_NETWORK_LINES,
    filesystemLines: STATIC_FILESYSTEM_LINES,
  };
}

function searchContext(config: OpenClawConfig): string[] {
  const enabled = configuredSearchEnabled(config);
  let availability = "Web search availability is not confirmed by OpenClaw configuration.";
  if (enabled === false) {
    availability =
      "Web search is disabled in OpenClaw configuration. For web-search requests, tell the user that web search is unavailable immediately. Do not use tool discovery to find the disabled search provider or retry searches. Do not inspect sandbox-local files, memory, or shell output to reconstruct web-search results.";
  } else if (enabled === true) {
    availability =
      "Web search is enabled in OpenClaw configuration. Configuration does not guarantee tool availability or request success.";
  }

  return [
    availability,
    "If no search tool is available, tell the user that web search is unavailable; do not claim to have searched.",
    "Only claim successful web research when a tool retrieved supporting content this turn.",
    "Label sandbox-local files, memory, and prior knowledge as local or unverified sources.",
    "Do not present a press release or announcement as installation documentation.",
    "A failed search or web_fetch is not evidence that a page does not exist.",
    "Report fetch errors separately from search availability.",
    "You may use successfully retrieved web_fetch content even when search is disabled. Cite the retrieved source and describe what it supports.",
  ];
}

function buildRuntimeContextText(summary: RuntimeSummary, config: OpenClawConfig): string {
  const displaySandboxName = isValidName(summary.sandboxName) ? summary.sandboxName : "<name>";
  const lines = [
    "<nemoclaw-runtime>",
    `You are running inside OpenShell sandbox "${displaySandboxName}" via NemoClaw.`,
    "Treat this as a sandboxed environment, not unrestricted host access.",
    summary.sandboxPhase ? `Current sandbox phase: ${summary.sandboxPhase}.` : null,
    "Network policy:",
    ...summary.networkLines.map((line) => `- ${line}`),
    "Filesystem policy:",
    ...summary.filesystemLines.map((line) => `- ${line}`),
    "Web research:",
    ...searchContext(config).map((line) => `- ${line}`),
    "Behavior:",
    "- Do not assert that a URL or host is blocked or unreachable unless you have actually attempted it this turn; report the actual result rather than speculating.",
    "- If a tool reports `CONNECT tunnel failed, response 403`, state that the proxy refused the request.",
    "- OpenShell policy may be the cause. The error alone does not confirm a policy denial.",
    `- Ask the operator to check \`nemoclaw ${displaySandboxName} logs --tail 50\` on the host before suggesting a policy change.`,
    "- Only suggest a policy change if a logged denial's destination and time match the failed request. The merged logs can contain unrelated denials.",
    "- If the last 50 log lines have no matching denial, ask the operator to inspect more logs; do not infer that policy allowed or blocked this request.",
    "- Do not call a proxy 403 a generic connectivity failure. Treat proxy 407, DNS, timeout, and TLS failures separately.",
    "- Do not claim unrestricted host or internet access either. When unsure, attempt the action and rely on the real result instead of speculating about the environment.",
    "</nemoclaw-runtime>",
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n");
}

type ResearchScope = "missing" | "external" | "supplied" | "ordinary";

interface ResearchRequestScope extends SuppliedSearchSources {
  scope: ResearchScope;
}

// Local resources use one noun-phrase grammar. Quoting, call notation, details,
// locations and result instructions change syntax, not the resource's scope.
type LocalTarget = "source" | "work";
interface LocalTargetBudget {
  remaining: number;
}
const LOCAL_TARGET_WORK_LIMIT = 128;
const SEARCH_PROMPT_LENGTH_LIMIT = 4096;
const LOCAL_TARGET_BUDGET_EXHAUSTED = new Error("Local target parsing budget exhausted");
const TARGET_PREFIX =
  /^(?:(?:for|through|out|which|what|why|how|many|of|all|any|some|each|every|both|the|this|that|these|those|our|my|your|a|an|top|current|latest|recent|last|active|today['’]s|largest|biggest|smallest|oldest|newest|duplicate|empty|hidden|temporary|recently|modified|unused|dead|unreachable|missing|unresolved|undefined|deprecated|broken|failing|failed|existing|TODO|FIXME|HACK|XXX|and|or|\d+)\s+)+/iu;
const IDENTIFIER =
  /^(?:(?:(?:this|that|the|our|my|your)\s+)?(?:function|method|class|symbol|variable|module)(?:\s+)?|)[\w$]*(?:(?:::|[.:])[\w$]+)*$/iu;
const LOCAL_SOURCE =
  /^(?:(?:local\s+)?(?:files?|logs?|memory|repository|repo|workspace|codebase|project|director(?:y|ies)|folders?|code|conversation|shell\s+history)|sandbox|(?:current\s+(?:working\s+)?|working\s+)directory|local\s+(?:docs|documentation)|(?:(?:unit|integration|regression)\s+)?tests?|imports?|exports?|variables?|parameters?|arguments?|functions?|methods?|class(?:es)?|modules?|dependencies|references?|comments?|markers?|bugs?|defects?|typos?|(?:lint|type|syntax|compilation|compiler|build|test)\s+(?:errors?|warnings?|failures?|output|results?))(?:\s+(?:files?|docs|directory|sources?|logs?|code|layout))*$/iu;
const LOCAL_PATH =
  /^(?:\.{0,2}\/\S+|(?:[\w.-]+\/)+[\w.-]*|(?:Dockerfile|Containerfile|(?:GNU)?Makefile|LICENSE|NOTICE|README)(?:\.[\w-]+)*|\.[\w-]+|[\w.-]+\.[\w-]+)$/u;
// A host names a web source, never a local file. Omit TLDs that are common file extensions.
const HOSTNAME =
  /^(?:[a-z\d-]+\.)+(?:com|org|net|edu|gov|mil|io|ai|co|dev|app|cloud|info|news|us|uk|eu|de|fr|jp|cn|ca|au|nl)(?::\d+)?(?:\/\S*)?$/iu;
function localPath(value: string): boolean {
  return LOCAL_PATH.test(value) && !HOSTNAME.test(value);
}
const LOCAL_TOOL =
  /^(?:web_fetch|read|edit|write|apply_patch|exec|process|memory_get|memory_search|(?:(?:available|local|filesystem|shell|memory)\s+)+tools?)(?:\s+tool)?$/iu;
const LOCAL_STATE =
  /^(?:git(?:\s+(?:branch(?:es)?(?:\s+names?)?|commits?(?:\s+(?:hash(?:es)?|ids?))?|status|log|diff))?|branch(?:es)?(?:\s+names?)?|commits?(?:\s+(?:hash(?:es)?|ids?))?|(?:(?:node(?:\.js)?|python3?|npm|pnpm|yarn|bun|git|openclaw|nemoclaw|hermes)\s+)?(?:versions?|errors?|status)|(?:installed|local|running)\s+[\w.+-]+\s+versions?|code\s+changes|diffs?|(?:build|test|lint|type|syntax|compilation|compiler)\s+(?:errors?|warnings?|failures?|output|results?|status)|environment|config(?:uration)?|hostname|user(?:name)?|time|date|clock|uptime|shell|shell\s+history|(?:high|low|excessive)?\s*(?:disk|storage|memory|cpu)\s+(?:usage|space|pressure)|(?:file\s*system|file|directory)\s+permissions)$/iu;
const LOCAL_SOURCE_LOCATION = /\b(?:in|inside|from|within|under|through)\s+(.+?)(?=\s+for\s+|$)/giu;
const QUOTED_TARGET = /(?<!\w)([`"'])((?:(?!\1)[^\n])+)\1/gu;

function normalizeQuotedTargets(raw: string, budget: LocalTargetBudget): string {
  return raw.replace(QUOTED_TARGET, (quoted, _quote: string, value: string, offset: number) => {
    const spacedPath =
      /^(?=.*\s)(?:\.{0,2}\/[\w./ -]+|(?:[\w.-]+(?: [\w.-]+)*\/)+[\w.-]*(?: [\w.-]+)*|[\w.-]+(?: [\w.-]+)*\.[\w-]+)$/u.test(
        value,
      );
    // A spaced filename needs a source relationship, content query or rooted path.
    let sourceContext = false;
    if (spacedPath) {
      const reference = raw.slice(0, offset) + "__local_path__" + raw.slice(offset + quoted.length);
      const prefix = raw.slice(0, offset).replace(TARGET_PREFIX, "").trim();
      sourceContext =
        (offset === 0 && /^\s+(?:for|to)\s+/iu.test(raw.slice(quoted.length))) ||
        Array.from(reference.matchAll(LOCAL_SOURCE_LOCATION)).some(
          (match) => match[1] === "__local_path__",
        ) ||
        (prefix.length > 0 && localTarget(reference, budget) === "source");
    }
    const rooted = /^(?:\.{0,2}\/)/u.test(value);
    if (/[*?[\]{}]/u.test(value)) {
      return /^(?=.*[*?[\]{}])[\w./\\:*?[\]{},!@()+#| -]+$/u.test(value) &&
        (!/\s/u.test(value) || /^[*?[\]{}]/u.test(value) || rooted || sourceContext)
        ? "__local_glob__"
        : "<quoted topic>";
    }
    if (localPath(value) || (spacedPath && (rooted || sourceContext))) return "__local_path__";
    const target = localTarget(value, budget);
    if (target === "source") return "__local_path__";
    const unquoted = raw.slice(0, offset) + value + raw.slice(offset + quoted.length);
    return IDENTIFIER.test(value) || target === "work" || localTarget(unquoted, budget)
      ? quoted
      : "<quoted topic>";
  });
}

function localTarget(raw: string, budget: LocalTargetBudget): LocalTarget | undefined {
  // Every recursive branch and request shares this budget, bounding stack depth
  // and total visits. Exhaustion invalidates grants for the complete turn.
  if (budget.remaining === 0) throw LOCAL_TARGET_BUDGET_EXHAUSTED;
  budget.remaining--;

  const normalized = normalizeQuotedTargets(raw, budget)
    .trim()
    .replace(/[.!?]+$/u, "")
    .replace(/(?<=[\w$`"'])\([^()\n]*\)/gu, "")
    .replace(/[`"]/gu, "")
    .replace(/(?<!\w)'|'(?!\w)/gu, "");
  // Try the complete target first: a symbol can itself be named "please".
  const candidates = [normalized];
  const words = normalized.split(/\s+/u);
  let end = words.length;
  while (end > 1 && !/^(?:of|to|for|named|called|covers?|calls?)$/iu.test(words[end - 2]!)) {
    const last = words[end - 1]!.replace(/,$/u, "");
    if (
      /^(?:recursively|case-insensitively|carefully|thoroughly|first|please|thanks)$/iu.test(last)
    )
      end--;
    else if (
      (last === "you" && words[end - 2] === "thank") ||
      ((last === "me" || last === "us") && words[end - 2] === "for") ||
      (last === "insensitively" && words[end - 2] === "case")
    )
      end -= 2;
    else break;
    if (words[end - 1] === "and") end--;
  }
  if (end < words.length) candidates.push(words.slice(0, end).join(" ").replace(/,$/u, ""));
  for (const candidate of candidates) {
    const target = candidate.replace(TARGET_PREFIX, "");
    if (target === "__local_path__" || LOCAL_SOURCE.test(target) || localPath(target))
      return "source";
    if (target === "__local_glob__") return "work";
    if (LOCAL_TOOL.test(target) || LOCAL_STATE.test(target)) return "work";
    // Parse recursive structure before diagnostic fallbacks so the work limit
    // can terminate a nested request before those fallbacks repeat.
    if (
      /^(?:root\s+)?cause\s+of\s+/iu.test(target) &&
      localTarget(target.replace(/^(?:root\s+)?cause\s+of\s+/iu, ""), budget)
    )
      return "work";
    // A resource list is local only when every operand is local. Reuse the
    // same grammar for each operand, including its query or relationship.
    const operands = target.split(/\s*,\s*(?:(?:and|or)\s+)?|\s+(?:and|or)\s+/iu);
    if (operands.length > 1) {
      const targets = operands.map((operand) => localTarget(operand, budget));
      if (targets.every((value) => value !== undefined))
        return targets.every((value) => value === "source") ? "source" : "work";
    }
    // A relationship names a resource, rather than an arbitrary research topic.
    const relation =
      /^(?:contents?|text|changes?|edits?|updates?|diffs?|versions?|revisions?|history)\s+(?:(?:made|applied)\s+)?(?:of|to|in|for)\s+(.+)$/iu.exec(
        target,
      );
    if (relation && localTarget(relation[1]!, budget) === "source") return "source";
    // A code relationship stays local when it also names a local place to look.
    const codeQuery = target.replace(
      /\s+(?:in|inside|within|under|across|throughout)\s+(?:the\s+)?(?!(?:web|internet)\b)([\w./-]+)(?:\s+(?:director(?:y|ies)|folders?|modules?|packages?))?$/iu,
      (location, place: string) => (HOSTNAME.test(place) ? location : ""),
    );
    const codeTarget =
      /^(?:(?:callers?|call\s+sites?|references?|definitions?|declarations?|implementations?|imports?|exports?|usages?|test\s+coverage)\s+(?:of|to|for)\s+(.+)|(?:files?|director(?:y|ies)|folders?|functions?|methods?|class(?:es)?|modules?|symbols?|variables?|constants?|types?|interfaces?|structs?|enums?|traits?|propert(?:y|ies)|namespaces?|parameters?|arguments?|(?:(?:unit|integration|regression)\s+)?tests?(?:\s+cases?)?)\s+(?:(?:that|which)\s+)?(?:calls?|invokes?|uses?|references?|imports?|exports?|implements?|named|called|covers?|covering|exercises?|exercising|calling|testing|importing|for)\s+(.+)|where\s+(.+)\s+(?:is|are)\s+(?:called|invoked|defined|declared|implemented|imported|exported|used|referenced|tested)|(.+)['’]s\s+(?:callers?|call\s+sites?))$/iu.exec(
        codeQuery,
      );
    if (codeTarget?.slice(1).some((value) => value && IDENTIFIER.test(value))) return "source";
    // Code described by its behavior is local code, whatever the behavior is.
    if (
      /^(?:functions?|methods?|class(?:es)?|modules?|components?|handlers?|hooks?|helpers?|middleware|(?:(?:unit|integration|regression)\s+)?tests?(?:\s+cases?)?|code)\s+(?:that|which)\s+\w+\s+\S/iu.test(
        target,
      )
    )
      return "source";
    // A query uses the same source grammar; a code relationship must still name valid code.
    const query = /^(.*?)(?:\s+(?:for|to)\s+.+|\s+and\s+(?:fetch|retrieve)\s*)$/iu.exec(target);
    const queryTarget = query?.[1]?.replace(/\s+(?:recursively|carefully|thoroughly)$/iu, "");
    if (queryTarget && !codeTarget?.[1] && localTarget(queryTarget, budget) === "source")
      return "source";
    // File discovery has an open vocabulary of formats and glob operands.
    if (
      /^(?:(?!(?:for|about|in|on|from|of|to|using|with|via|by)\b)[\w.+#*-]+\s+)*(?:files?|director(?:y|ies)|folders?)(?:\s+(?:with|that|which|named|called|matching|containing|ending|ends|larger|smaller|older|newer|of type|of format|of extension)\b.*)?$/iu.test(
        target,
      ) ||
      /^(?=[^\s]*[*?[\]{}])[\w./\\:*?[\]{},!@()+#|-]+(?:\s+files?)?$/u.test(target)
    )
      return "work";
    // Runtime state and diagnostic predicates do not supply retrieval grants.
    if (
      /^(?:(?:current|parent|child|running|active|stalled|zombie|background)\s+)?(?:process(?:es)?(?:\s+(?:ids?|identifiers?))?|pids?)(?:\s+(?:(?:is|are|was|were|has|have)\s+)?(?:running|owns?|uses?|using|listens?|listening|consumes?|consuming|holds?|holding|by|with|that|which|of)\b.*)?$/iu.test(
        target,
      )
    )
      return "work";
    const predicate =
      /^(.*?)\s+(?:(?:is|are|was|were|has|have|had|keeps?|kept)\s+)?(?:fail(?:s|ed|ing)?|hang(?:s|ing)?|hung|crash(?:es|ed|ing)?|tim(?:es?|ed|ing)\s+out|(?:exit(?:s|ed)?|return(?:s|ed)?)\s+(?:with\s+)?(?:code\s+)?[1-9]\d*|errors?|failures?)(?:\s+(?:recently|with\s+(?:error(?:\s+code)?\s+)?[\w-]+|(?:in|on)\s+(?:this|the|our|my|your|local)\s+(?:sandbox|workspace|machine|container|repository|repo|project)))?$/iu.exec(
        target,
      );
    if (predicate && LOCAL_SOURCE.test(predicate[1]!.replace(TARGET_PREFIX, ""))) return "source";
    if (
      predicate &&
      /^(?:npm|npx|pnpm|yarn|bun|pip3?|uv|cargo|go|make|cmake|git|node|python3?|docker|nemoclaw)(?:\s+[^\s;]+)*$/iu.test(
        predicate[1]!,
      )
    )
      return "work";
    const location = /^(.*?)\s+(?:in|inside|on|under|within)\s+(.+)$/iu.exec(target);
    if (
      location &&
      /^(?:(?:the|this|our|my|your|local|current|working)\s+)*(?:disk|file\s*system|directory|folder|machine|sandbox|workspace|repo|repository|computer|host)$/iu.test(
        location[2]!,
      ) &&
      localTarget(location[1]!, budget)
    )
      return "work";
    if (localPath(target.replace(/^(?:the\s+)?file\s+/iu, ""))) return "source";
    const stateLocation =
      /^(.*?)\s+(?:in|for|of|from|on)\s+(?:(?:the|this|our|my|your|local|current|working)\s+)*(?:node(?:\.js)?|python3?|npm|pnpm|yarn|bun|git|openclaw|nemoclaw|hermes|(?:[\w.-]+\s+)*(?:app|server|project|repository|repo|workspace|sandbox|environment|shell|terminal|machine|directory|runtime))$/iu.exec(
        target,
      );
    if (stateLocation && LOCAL_STATE.test(stateLocation[1]!)) return "work";
    if (
      LOCAL_STATE.test(
        target
          .replace(/\s+(?:is|are)\s+(?:high|low)$/iu, "")
          .replace(/\s+(?:is|are)\s+(?:current|latest|active)$/iu, ""),
      )
    )
      return "work";
  }
  return undefined;
}

const URL_OPERAND = String.raw`https:\/\/supplied-url\.invalid\/\d+\/[.,;!?)\]}]*`;
const OPERAND_JOIN = String.raw`(?:\s*,\s*(?:(?:and|or)\s+)?|\s+(?:and|or)\s+)`;
const URL_THEN_OPERAND = new RegExp(`${URL_OPERAND}${OPERAND_JOIN}(?!https:)`, "iu");
const OPERAND_THEN_URL = new RegExp(`${OPERAND_JOIN}${URL_OPERAND}`, "iu");

/** Removes URL operands coordinated with another target; undefined when every target is a URL. */
function withoutUrlOperands(request: string): string | undefined {
  let residual = request;
  for (let previous = ""; previous !== residual;) {
    previous = residual;
    residual = residual.replace(URL_THEN_OPERAND, "");
    if (residual === previous) residual = residual.replace(OPERAND_THEN_URL, "");
  }
  return residual !== request && !residual.includes("supplied-url.invalid") ? residual : undefined;
}

function classifySearchRequests(prompt: string, budget: LocalTargetBudget): ResearchRequestScope {
  // Generic questions need local tools without naming a source. Require external
  // research intent, and keep separate requests from exempting one another.
  // Normalize URLs before splitting so their path words cannot become requests.
  const urls: string[] = [];
  const requests = prompt
    // Coordination modifiers do not change whether operands share a target
    // or introduce a separate request. Normalize them before either decision.
    .replace(
      /(^|[.!?;\n,]\s*|\b(?:and|or|but|then|instead)\s+)(?:(?:also|then|additionally|separately|alternatively)(?:\s*,\s*|\s+))+/giu,
      "$1",
    )
    .replace(/\bhttps?:\/\/\S+/giu, (raw) => {
      const url = raw.replace(/[.,;!?)\]}]+$/u, "");
      const index = urls.push(url) - 1;
      return `https://supplied-url.invalid/${index}/${raw.slice(url.length)}`;
    })
    .replace(/:\s*\n\s*(?=https?:\/\/)/giu, ": ")
    // Coordinated verbs share the following target: "find and fix the bug".
    // Keep the research verb so an external target still requires web search.
    .replace(
      /\b(search|research|investigate|look\s+(?:up|for)|find|locate|gather|seek|discover|explore|browse|consult|query|read|summarize)\s+(?:(?:and|or|then)\s+(?:search|research|investigate|look\s+(?:up|for)|find|locate|gather|seek|discover|explore|browse|consult|query|provide|show|point|give|tell|list|report|return|print|output|present|identify|describe|explain|summarize|fetch|retrieve|read|get|inspect|fix|repair|replace|edit|update|debug|test|modify|refactor|rename|remove|delete|format|lint|verify|check|run|add|invoke|call|use)\s+)+/giu,
      "$1 ",
    )
    // A repair clause must not become part of a navigation target. Classify
    // coordinated requests separately so external research still dominates.
    // A comma before a bare list item does not start another request.
    .split(
      /(?<=[.!?])\s+|[\n;]+|(?:,(?!\s*[\w-]+\s*(?:,|$))\s*|(?:,\s*)?\b(?:and|or|then|but|instead)\b)(?!\s*(?:fetch|retrieve)\s+https?:\/\/)(?=\s*(?:(?:also|additionally|separately|alternatively|please|could|can|would|you|I|we|do|not|don't|never)\s+)*(?:use|run|ask|google|bing|duckduckgo|web[_ -]?search|search|research|investigate|look|find|locate|gather|browse|seek|consult|query|discover|explore|provide|show|point|give|tell|list|report|return|print|output|present|identify|describe|explain|summarize|fetch|retrieve|read|get|inspect|fix|repair|replace|edit|update|debug|test|modify|refactor|rename|remove|delete|format|lint|verify|check|add|need|want|where|which|what|who|when|how)\b)/iu,
    );
  const classifyRequest = (request: string): ResearchRequestScope => {
    // A supplied URL exempts only itself: judge a coordinated non-URL target on its own.
    const residual = withoutUrlOperands(request);
    if (residual !== undefined && classifyRequest(residual).scope === "external")
      return { scope: "external", local: false, urls: [] };
    const requestUrls = Array.from(
      request.matchAll(/https:\/\/supplied-url\.invalid\/(\d+)\//gu),
      (match) => urls[Number(match[1])]!,
    );
    // A supplied URL is a retrieval target; its path words are not user intent.
    // Remove conversational and tool-invocation wrappers, not a leading task
    // instruction. A later keyword can name code ("fix the search button").
    const source = request
      .replace(/\bhttps?:\/\/\S+/giu, "")
      .trimStart()
      .replace(
        /^(?:(?:also|additionally|separately|alternatively|please|(?:can|could|would|will)\s+(?:you|we|I)|help\s+(?:me|us)(?:\s+to)?|(?:(?:I|we)\s+)?(?:need|want|would\s+like)\s+(?:you\s+)?to|(?:I|we)['’]d\s+like(?:\s+(?:you\s+)?to)?|(?:I|we)|(?:use|invoke|call)\s+(?:the\s+)?(?:web_fetch|tool_(?:search|describe|call))(?:\s+tool)?\s+(?:only\s+)?to)\s+)+/iu,
        "",
      )
      .replace(/^(?:don't|do not)\s+know\s+/iu, "");
    const action =
      /\b(?:(?:do|run|perform|conduct)\s+(?:(?:a|an|some)\s+)?(?:search|research|investigation)|(?:use|run|ask)\s+(?:(?:a|the)\s+)?(?:tavily|brave|google|bing|duckduckgo|web[_ -]?search)|google|bing|duckduckgo|web[_ -]?search|search|research|investigate|look(?:\s+(?:up|for|on))?|find|locate|gather|browse|seek|consult|query|discover|explore|provide|show|point|give|summarize|fetch|retrieve|read|get|need|want|tell|list|report|return|print|output|present|identify|describe|explain|where|which|what|who|when|how)\b/iu.exec(
        source,
      );
    const prefix = source.slice(0, action?.index ?? 0);
    if (/\b(?:(?:do\s+not|don't|never)\s+(?:use\s+(?:web_fetch[,\s]*)?)?|not\s*)$/iu.test(prefix)) {
      return { scope: "ordinary", local: false, urls: [] };
    }

    // A requested external result does not require a particular action verb.
    const directFetch = /^(?:browse|summarize|fetch|retrieve|read|get)\b/iu.test(source);
    const searchAction =
      /\b(?:googl(?:e|ing)|bing|duckduckgo|web[_ -]?search|search|research|investigate|look\s+(?:up|for)|find|locate|gather|seek)\b/iu.test(
        source,
      );

    const providerRequest =
      /^(?:(?:use|run|ask)\s+(?:(?:a|the)\s+)?(?:tavily|brave|google|bing|duckduckgo|web[_ -]?search)|google|bing|duckduckgo|web[_ -]?search)\b|\b(?:using|with|via)\s+(?:tavily|brave|google|bing|duckduckgo)\b/iu.test(
        source,
      );
    const externalSource =
      providerRequest ||
      /\b(?:(?:on|from)\s+(?:the\s+)?(?:web|internet|online)|(?:search|research|browse|look)\s+(?:(?:the|on\s+the)\s+)?(?:web|internet|online))\b/iu.test(
        source,
      ) ||
      /\bonline(?=\s*(?:[.!?]|$)|\s+(?:for|about|using|with|via|today|now|please)\b)/iu.test(
        source,
      );
    // A local source must be the action's target or an explicit source location.
    // Words in the requested research topic do not grant access to substitutes.
    const subject = source
      .slice(action?.index === 0 ? action[0].length : 0)
      .trimStart()
      .replace(/^(?:to\s+)?(?:me|us)\s+/iu, "")
      .replace(/^(?:['’]s|is|are|was|were)\s+/iu, "")
      .replace(
        /^(?:do|can|should|would)\s+(?:I|we)\s+(?:fix|repair|debug|diagnose|inspect|resolve|check|read|view|show)\s+/iu,
        "",
      )
      .replace(/\b(?:URL|URI)\s+in\s+(?:args|params)\.[\w.]+/giu, "");
    const target = localTarget(subject, budget);
    const localSource =
      target === "source" ||
      Array.from(
        normalizeQuotedTargets(subject, budget)
          .replace(QUOTED_TARGET, " ")
          .matchAll(LOCAL_SOURCE_LOCATION),
      ).some((match) => localTarget(match[1]!, budget) === "source");
    const localWork = target !== undefined;
    const suppliedUrl =
      /\b(?:search|research|investigate|look\s+(?:up|for)|find|locate|gather|seek|discover|explore|browse|consult|query)\s+(?:(?:in|within|at|on|through)\s+)?https?:\/\/\S+|\b(?:browse|summarize|fetch|retrieve|read|get)\s+(?:exactly\s+)?(?:this\s+)?(?:public\s+)?(?:HTTPS?\s+)?(?:URL:?\s*)?https?:\/\/\S+|\b(?:using|with|via)\s+(?:the\s+)?(?:web_fetch|browser)(?:\s+tool)?\s+(?:at|for)\s+https?:\/\/\S+|\b(?:in|within|at|from)\s+(?:this\s+URL:?\s*)?https?:\/\/\S+/iu.test(
        request,
      );
    const informationRequest =
      action?.index === 0 || /^(?:the\s+)?(?:official|latest|recent|alternative)\b/iu.test(source);
    const externalResearch =
      (!localWork &&
        /^(?:(?:do|run|perform|conduct)\s+(?:(?:a|an|some)\s+)?(?:search|research|investigation)|search|research|investigate|look\s+(?:up|for)|find|locate|gather|seek|discover|explore|browse|consult|query)\b/iu.test(
          source,
        )) ||
      // Current-information requests need the same admission decision whether
      // phrased as questions or instructions. Local and supplied sources keep
      // their existing exceptions below.
      (!localWork &&
        /^(?:what|where|which|who|when|how|provide|show|give|tell|list|report|return|print|output|present|identify|describe|explain|summarize|fetch|retrieve|read|get|need|want)\b/iu.test(
          source,
        ) &&
        /\b(?:current|latest|recent|today(?:['’]s)?|now|live|up[ -]to[ -]date)\b/iu.test(source)) ||
      (!localWork &&
        informationRequest &&
        /\b(?:official|latest|recent|alternative)\b/iu.test(source) &&
        /\b(?:documentation|docs|installation\s+(?:instructions|procedure|guides?)|release\s+notes|announcements|news|sources)\b/iu.test(
          source,
        ));
    const supplied = localSource || suppliedUrl;
    const needsSearch =
      providerRequest ||
      (externalSource && !(directFetch && !searchAction && suppliedUrl)) ||
      (!supplied && externalResearch);
    if (needsSearch) return { scope: "external", local: false, urls: [] };
    return {
      scope: supplied ? "supplied" : "ordinary",
      local: localSource,
      urls: suppliedUrl ? requestUrls : [],
    };
  };
  const scopes = requests.map(classifyRequest);
  if (scopes.some(({ scope }) => scope === "external")) {
    return { scope: "external", local: false, urls: [] };
  }
  return {
    scope: scopes.some(({ scope }) => scope === "supplied") ? "supplied" : "ordinary",
    local: scopes.some(({ local }) => local),
    urls: scopes.flatMap(({ urls: targets }) => targets),
  };
}

export function classifySearchTurn(prompt: unknown): ResearchRequestScope {
  if (typeof prompt !== "string") {
    return { scope: "missing", local: false, urls: [] };
  }
  // Bound input before any regex or normalization; visits alone do not bound backtracking.
  if (prompt.length > SEARCH_PROMPT_LENGTH_LIMIT) {
    return { scope: "external", local: false, urls: [] };
  }
  if (prompt.trim().length === 0) {
    return { scope: "missing", local: false, urls: [] };
  }
  try {
    return classifySearchRequests(prompt, { remaining: LOCAL_TARGET_WORK_LIMIT });
  } catch (error) {
    // Stop every fallback immediately on exhaustion; retain diagnostics for other failures.
    if (error !== LOCAL_TARGET_BUDGET_EXHAUSTED) throw error;
    return { scope: "external", local: false, urls: [] };
  }
}

export function researchScope(prompt: unknown): ResearchScope {
  return classifySearchTurn(prompt).scope;
}

/** Retain retrieval targets only when the complete request supplies its sources. */
export function suppliedSearchSources(prompt: unknown): SuppliedSearchSources | undefined {
  const { scope, local, urls } = classifySearchTurn(prompt);
  return scope === "supplied" ? { local, urls } : undefined;
}

/** Prepends runtime context and withholds tools for disabled-search research. */
export function registerRuntimeContext(api: OpenClawPluginApi, pluginConfig: NemoClawConfig): void {
  api.on("before_prompt_build", (...args) => {
    const event = args[0];
    const prompt =
      event && typeof event === "object" && !Array.isArray(event) ? event.prompt : undefined;
    // A tool-call denial happens after the model has already attempted discovery.
    // Keep local work and direct URL retrieval available without using them as
    // substitutes for research whose source the user has not supplied.
    const { scope } = classifySearchTurn(prompt);
    const searchDisabled = configuredSearchEnabled(api.config) === false;
    const unavailableSearch = searchDisabled && (scope === "external" || scope === "missing");
    return {
      prependSystemContext: buildRuntimeContextText(getRuntimeSummary(pluginConfig), api.config),
      ...(unavailableSearch ? { toolsAllow: [] } : {}),
    };
  });
}
