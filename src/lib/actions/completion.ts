// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { globalRouteTokenVariants, sandboxRouteTokens } from "../cli/public-route-metadata";
import { listSandboxes } from "../state/registry";

export type CompletionShell = "bash" | "zsh" | "fish";

type CompletionArgMetadata = {
  options?: readonly string[];
};

type CompletionFlagMetadata = {
  allowNo?: boolean;
  char?: string;
  hidden?: boolean;
};

export type CompletionCommandMetadata = {
  args?: Record<string, CompletionArgMetadata>;
  flags?: Record<string, CompletionFlagMetadata>;
  hidden?: boolean;
  id: string;
};

type CompletionNode = {
  argOptions: Set<string>;
  children: Map<string, CompletionNode>;
  flags: Set<string>;
};

export type CompletionCase = {
  argOptions: string[];
  candidates: string[];
  flags: string[];
  key: string;
};

export type CompletionModel = {
  global: CompletionCase[];
  sandbox: CompletionCase[];
};

function createNode(): CompletionNode {
  return { argOptions: new Set(), children: new Map(), flags: new Set() };
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function addCommandMetadata(node: CompletionNode, command: CompletionCommandMetadata): void {
  for (const [name, flag] of Object.entries(command.flags ?? {})) {
    if (flag.hidden) continue;
    node.flags.add(`--${name}`);
    if (flag.char) node.flags.add(`-${flag.char}`);
    if (flag.allowNo) node.flags.add(`--no-${name}`);
  }

  for (const arg of Object.values(command.args ?? {})) {
    for (const option of arg.options ?? []) node.argOptions.add(option);
  }
}

function addRoute(
  root: CompletionNode,
  route: readonly string[],
  command: CompletionCommandMetadata,
): void {
  const tokens = route.filter(Boolean);
  if (tokens.length === 0) return;

  if (tokens.length === 1 && tokens[0]?.startsWith("-")) {
    root.flags.add(tokens[0]);
    return;
  }

  let node = root;
  for (const token of tokens) {
    let child = node.children.get(token);
    if (!child) {
      child = createNode();
      node.children.set(token, child);
    }
    node = child;
  }
  addCommandMetadata(node, command);
}

function flattenTree(root: CompletionNode, mode: "global" | "sandbox"): CompletionCase[] {
  const cases: CompletionCase[] = [];

  function visit(node: CompletionNode, path: string[]): void {
    cases.push({
      argOptions: sorted(node.argOptions),
      candidates: sorted(node.children.keys()),
      flags: sorted(node.flags),
      key: `${mode}:${path.join(" ")}`,
    });
    for (const token of sorted(node.children.keys())) {
      const child = node.children.get(token);
      if (child) visit(child, [...path, token]);
    }
  }

  visit(root, []);
  return cases;
}

/** Build the public completion trees directly from oclif's discovered command metadata. */
export function buildCompletionModel(
  commands: readonly CompletionCommandMetadata[],
): CompletionModel {
  const globalRoot = createNode();
  const sandboxRoot = createNode();

  for (const command of commands) {
    // Root help/version adapters are hidden from native oclif topics but remain
    // intentional public routes. Other hidden/internal commands stay private.
    if (command.hidden && !command.id.startsWith("root:")) continue;
    for (const route of globalRouteTokenVariants(command.id)) {
      addRoute(globalRoot, route, command);
    }
    const sandboxRoute = sandboxRouteTokens(command.id);
    if (sandboxRoute) addRoute(sandboxRoot, sandboxRoute, command);
  }

  return {
    global: flattenTree(globalRoot, "global"),
    sandbox: flattenTree(sandboxRoot, "sandbox"),
  };
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function shellIdentifier(binName: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(binName)) {
    throw new Error(`Unsupported completion binary name: ${binName}`);
  }
  return binName.replaceAll(/[^a-zA-Z0-9_]/g, "_");
}

function escapeDoubleQuotedCase(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$");
}

function bashCases(model: CompletionModel): string {
  return [...model.global, ...model.sandbox]
    .map((entry) => {
      const regular = [...entry.candidates, ...entry.argOptions].join(" ");
      return `    "${escapeDoubleQuotedCase(entry.key)}")
      if [[ "$cur" == -* ]]; then
        candidates="${entry.flags.join(" ")}"
      else
        candidates="${regular}"
      fi
      ;;`;
    })
    .join("\n");
}

function bashScript(model: CompletionModel, binName: string): string {
  const id = shellIdentifier(binName);
  const bin = shellSingleQuote(binName);
  const cache = `__${id}_sandbox_cache`;
  const loaded = `${cache}_loaded`;

  return `# ${binName} bash completion
# Source this file or add it to your bash completion directory.

_${id}_load_sandboxes() {
  if [[ $${loaded} != 1 ]]; then
    ${cache}="$(${bin} completion --list-sandbox-names 2>/dev/null)"
    ${loaded}=1
  fi
}

_${id}() {
  local cur mode prefix first sandbox candidates
  local -a words
  local cword start i
  COMPREPLY=()
  words=("\${COMP_WORDS[@]}")
  cword=\${COMP_CWORD}
  cur="\${COMP_WORDS[COMP_CWORD]}"
  mode=global
  start=1
  _${id}_load_sandboxes

  if (( cword > 1 )); then
    first="\${words[1]}"
    while IFS= read -r sandbox; do
      if [[ -n "$sandbox" && "$sandbox" == "$first" ]]; then
        mode=sandbox
        start=2
        break
      fi
    done <<< "$${cache}"
  fi

  prefix=""
  for ((i = start; i < cword; i++)); do
    prefix+="\${prefix:+ }\${words[i]}"
  done

  candidates=""
  case "$mode:$prefix" in
${bashCases(model)}
  esac

  if (( cword == 1 )) && [[ "$cur" != -* ]]; then
    candidates="$candidates $${cache}"
  fi
  COMPREPLY=( $(compgen -W "$candidates" -- "$cur") )
}

complete -F _${id} ${bin}
`;
}

function zshWords(values: readonly string[]): string {
  return values.map(shellSingleQuote).join(" ");
}

function zshCases(model: CompletionModel): string {
  return [...model.global, ...model.sandbox]
    .map((entry) => {
      const regular = [...entry.candidates, ...entry.argOptions];
      return `    ${shellSingleQuote(entry.key)})
      if [[ "$cur" == -* ]]; then
        candidates=(${zshWords(entry.flags)})
      else
        candidates=(${zshWords(regular)})
      fi
      ;;`;
    })
    .join("\n");
}

function zshScript(model: CompletionModel, binName: string): string {
  const id = shellIdentifier(binName);
  const bin = shellSingleQuote(binName);
  const cache = `__${id}_sandbox_cache`;
  const loaded = `${cache}_loaded`;

  return `#compdef ${binName}
# ${binName} zsh completion

typeset -g ${loaded}=0
typeset -ga ${cache}

_${id}_load_sandboxes() {
  if (( ! ${loaded} )); then
    ${cache}=("\${(@f)\"$(${bin} completion --list-sandbox-names 2>/dev/null)\"}")
    ${loaded}=1
  fi
}

_${id}() {
  local cur mode prefix first
  local -a candidates
  integer start i
  cur="\${words[CURRENT]}"
  mode=global
  start=2
  _${id}_load_sandboxes

  if (( CURRENT > 2 )); then
    first="\${words[2]}"
    if (( \${${cache}[(Ie)$first]} )); then
      mode=sandbox
      start=3
    fi
  fi

  prefix=""
  for ((i = start; i < CURRENT; i++)); do
    prefix+="\${prefix:+ }\${words[i]}"
  done

  candidates=()
  case "$mode:$prefix" in
${zshCases(model)}
  esac

  if (( CURRENT == 2 )) && [[ "$cur" != -* ]]; then
    candidates+=("\${${cache}[@]}")
  fi
  (( \${#candidates[@]} )) && _describe 'completion' candidates
}

compdef _${id} ${bin}
`;
}

function fishCaseBody(entry: CompletionCase): string {
  const regular = [...entry.candidates, ...entry.argOptions];
  const flags = entry.flags.length > 0 ? `printf '%s\\n' ${zshWords(entry.flags)}` : "true";
  const values = regular.length > 0 ? `printf '%s\\n' ${zshWords(regular)}` : "true";
  return `    case ${shellSingleQuote(entry.key)}
      if string match -q -- '-*' "$cur"
        ${flags}
      else
        ${values}
      end`;
}

function fishScript(model: CompletionModel, binName: string): string {
  const id = shellIdentifier(binName);
  const bin = shellSingleQuote(binName);
  const cache = `__${id}_sandbox_cache`;
  const loaded = `${cache}_loaded`;
  const cases = [...model.global, ...model.sandbox].map(fishCaseBody).join("\n");

  return `# ${binName} fish completion

function __${id}_sandboxes
  if not set -q ${loaded}
    set -g ${cache} (command ${bin} completion --list-sandbox-names 2>/dev/null)
    set -g ${loaded} 1
  end
  printf '%s\\n' $${cache}
end

function __${id}_complete
  set -l tokens (commandline -opc)
  set -l cur (commandline -ct)
  set -e tokens[1]
  set -l mode global
  set -l start 1

  if test (count $tokens) -gt 0
    if contains -- $tokens[1] (__${id}_sandboxes)
      set mode sandbox
      set start 2
    end
  end

  set -l prefix (string join ' ' $tokens[$start..-1])
  switch "$mode:$prefix"
${cases}
  end

  if test "$mode" = global; and test (count $tokens) -eq 0; and not string match -q -- '-*' "$cur"
    __${id}_sandboxes
  end
end

complete -c ${bin} -f -a '(__${id}_complete)'
`;
}

/** Resolve the target shell from an explicit argument or the SHELL environment. */
export function detectShell(shellEnv: string | undefined): CompletionShell {
  const shell = shellEnv ?? "";
  if (shell.includes("zsh")) return "zsh";
  if (shell.includes("fish")) return "fish";
  return "bash";
}

/** Generate a shell script from oclif's currently discovered command metadata. */
export function generateCompletionScript(
  shell: CompletionShell,
  commands: readonly CompletionCommandMetadata[],
  binName: string,
): string {
  const model = buildCompletionModel(commands);
  if (shell === "zsh") return zshScript(model, binName);
  if (shell === "fish") return fishScript(model, binName);
  return bashScript(model, binName);
}

export interface CompletionActionDeps {
  listRegisteredSandboxes?: typeof listSandboxes;
  shellEnv?: string;
  write?: (output: string) => void;
}

/** Emit the generated script for the requested (or detected) shell. */
export function runCompletionAction(
  shell: string | undefined,
  commands: readonly CompletionCommandMetadata[],
  binName: string,
  deps: CompletionActionDeps = {},
): void {
  const write = deps.write ?? ((output: string) => process.stdout.write(output));
  const resolved =
    shell === "bash" || shell === "zsh" || shell === "fish"
      ? shell
      : detectShell(deps.shellEnv ?? process.env.SHELL);
  write(generateCompletionScript(resolved, commands, binName));
}

/** Emit only local registry names for the lightweight dynamic completion path. */
export function runCompletionSandboxNamesAction(deps: CompletionActionDeps = {}): void {
  const write = deps.write ?? ((output: string) => process.stdout.write(output));
  const readRegistry = deps.listRegisteredSandboxes ?? listSandboxes;
  const names = readRegistry()
    .sandboxes.map((sandbox) => sandbox.name)
    .sort();
  write(names.length > 0 ? `${names.join("\n")}\n` : "");
}
