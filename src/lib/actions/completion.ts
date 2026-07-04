// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shell completion script generation for `nemoclaw completion`. Script
 * templates and shell detection live here so the command class stays a
 * thin argv adapter, and the generators can be unit tested without
 * invoking oclif. The stdout write is behind an injectable dep.
 *
 * Command names, sandbox subcommands, and per-command flags are each
 * defined once and rendered into all three shells, so the shells cannot
 * drift from one another.
 */

export type CompletionShell = "bash" | "zsh" | "fish";

const GLOBAL_COMMANDS = [
  "onboard",
  "list",
  "status",
  "completion",
  "credentials",
  "credentials:add",
  "credentials:list",
  "credentials:reset",
  "inference:get",
  "inference:set",
  "agents:list",
  "backup-all",
  "upgrade-sandboxes",
  "setup-spark",
  "debug",
  "gc",
  "update",
  "version",
  "help",
];

/**
 * Shell snippet that lists registered sandbox names by parsing
 * `nemoclaw list --json` with node (always installed for a Node CLI).
 * The human-readable table emitted by plain `nemoclaw list` is not a
 * stable interface, so completion must not scrape it.
 */
const LIST_SANDBOXES_SNIPPET =
  "nemoclaw list --json 2>/dev/null | node -e '" +
  'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{' +
  "try{(JSON.parse(d).sandboxes||[]).forEach(s=>s&&s.name&&console.log(s.name))}catch(e){}})' 2>/dev/null";

const SANDBOX_SUBCOMMANDS = [
  "status",
  "logs",
  "exec",
  "agent",
  "connect",
  "destroy",
  "rebuild",
  "recover",
  "download",
  "doctor",
  "dashboard-url",
  "gateway-token",
  "inference:get",
  "inference:set",
  "policy-add",
  "policy-remove",
  "policy-list",
  "policy-explain",
  "channels:add",
  "channels:remove",
  "channels:list",
  "channels:start",
  "channels:stop",
  "channels:status",
  "hosts-add",
  "hosts-remove",
  "hosts-list",
  "snapshot:create",
  "snapshot:list",
  "snapshot:restore",
  "shields:up",
  "shields:down",
  "shields:status",
  "skill:install",
  "skill:remove",
  "mcp",
  "share:mount",
  "share:unmount",
  "share:status",
  "config:get",
  "config:set",
  "config:rotate-token",
  "sessions:reset",
  "tunnel:start",
  "tunnel:stop",
  "tunnel:status",
];

interface FlagSpec {
  /** Long form including dashes, e.g. "--sandbox". */
  long: string;
  /** Optional short form including dash, e.g. "-y". */
  short?: string;
  /** Human description, shown by zsh and fish. */
  description?: string;
  /** Placeholder label when the flag takes a value, e.g. "name". */
  value?: string;
  /** Set to complete the value as a filesystem path (zsh only). */
  file?: boolean;
}

/**
 * Per-command flag table — the single source of truth rendered into the
 * bash `case` entries, zsh `_arguments` calls, and fish `complete` lines.
 */
const COMMAND_FLAG_TABLE: Array<{ commands: string[]; flags: FlagSpec[] }> = [
  {
    commands: ["credentials:add", "credentials"],
    flags: [
      { long: "--type", description: "Credential type", value: "type" },
      { long: "--credential", description: "Env var name", value: "name" },
      { long: "--config", description: "Key=value config", value: "kv" },
      { long: "--from-existing" },
    ],
  },
  {
    commands: ["credentials:reset"],
    flags: [{ long: "--yes", short: "-y", description: "Skip confirmation" }],
  },
  {
    commands: ["status", "list", "inference:get", "inference:set"],
    flags: [{ long: "--json", description: "JSON output" }],
  },
  {
    commands: ["onboard"],
    flags: [
      { long: "--sandbox", description: "Sandbox name", value: "name" },
      { long: "--agent", description: "Agent runtime", value: "agent" },
      { long: "--non-interactive", description: "Skip interactive prompts" },
      { long: "--yes", short: "-y", description: "Skip confirmation" },
    ],
  },
  {
    commands: ["debug"],
    flags: [
      { long: "--quick", description: "Quick diagnostics only" },
      { long: "--output", short: "-o", description: "Output file", value: "file", file: true },
      { long: "--sandbox", description: "Sandbox name", value: "name" },
    ],
  },
  {
    commands: ["gc"],
    flags: [
      { long: "--yes", short: "-y", description: "Skip confirmation" },
      { long: "--force", description: "Skip confirmation" },
      { long: "--dry-run", description: "Preview without applying" },
    ],
  },
];

const COMPLETION_SHELLS = ["bash", "zsh", "fish"];

function bashFlagWords(flags: FlagSpec[]): string {
  const words = flags.flatMap((f) => (f.short ? [f.long, f.short] : [f.long]));
  return [...words, "--help"].join(" ");
}

function bashFlagCases(): string {
  const entries = COMMAND_FLAG_TABLE.map(({ commands, flags }) => {
    const pattern = commands.join("|");
    return `    ${pattern})
      COMPREPLY=( $(compgen -W "${bashFlagWords(flags)}" -- "\${cur}") )
      ;;`;
  });
  entries.push(`    completion)
      COMPREPLY=( $(compgen -W "${COMPLETION_SHELLS.join(" ")}" -- "\${cur}") )
      ;;`);
  return entries.join("\n");
}

function zshFlagArgs(flags: FlagSpec[]): string {
  const args = flags.flatMap((f) => {
    const desc = f.description ? `[${f.description}]` : "";
    const value = f.file ? ":file:_files" : f.value ? `:${f.value}` : "";
    const long = `'${f.long}${desc}${value}'`;
    return f.short ? [long, `'${f.short}${desc}${value}'`] : [long];
  });
  return [...args, "'--help'"].join(" ");
}

function zshFlagCases(): string {
  const entries = COMMAND_FLAG_TABLE.map(({ commands, flags }) => {
    const pattern = commands.join("|");
    return `    ${pattern})
      _arguments ${zshFlagArgs(flags)}
      ;;`;
  });
  entries.push(`    completion)
      local -a shells; shells=(${COMPLETION_SHELLS.map((s) => `'${s}'`).join(" ")})
      _describe 'shell' shells
      ;;`);
  return entries.join("\n");
}

function fishFlagLines(): string {
  const lines = COMMAND_FLAG_TABLE.flatMap(({ commands, flags }) => {
    const condition = `__fish_seen_subcommand_from ${commands.join(" ")}`;
    return flags.map((f) => {
      const parts = [`complete -c nemoclaw -n '${condition}'`, `-l ${f.long.slice(2)}`];
      if (f.short) parts.push(`-s ${f.short.slice(1)}`);
      if (f.description) parts.push(`-d '${f.description}'`);
      if (f.value) parts.push("-r");
      return parts.join(" ");
    });
  });
  lines.push(
    `complete -c nemoclaw -n '__fish_seen_subcommand_from completion' -a '${COMPLETION_SHELLS.join(" ")}'`,
  );
  return lines.join("\n");
}

function bashScript(): string {
  const globals = GLOBAL_COMMANDS.join(" ");
  const subcommands = SANDBOX_SUBCOMMANDS.join(" ");
  return `# nemoclaw bash completion
# Source this file or add to ~/.bash_completion.d/
# Usage: source <(nemoclaw completion bash)

_nemoclaw() {
  local cur prev words cword
  _init_completion 2>/dev/null || {
    COMPREPLY=()
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
    words=("\${COMP_WORDS[@]}")
    cword=\${COMP_CWORD}
  }

  local global_cmds="${globals}"
  local sandbox_cmds="${subcommands}"

  # Fetch sandbox names (cached for the lifetime of this completion call)
  local sandboxes
  sandboxes=$(${LIST_SANDBOXES_SNIPPET}) || sandboxes=""

  if [[ \${cword} -eq 1 ]]; then
    # Complete global commands and registered sandbox names
    COMPREPLY=( $(compgen -W "\${global_cmds} \${sandboxes}" -- "\${cur}") )
    return 0
  fi

  local first="\${words[1]}"

  # If the first token is a known sandbox name, complete sandbox subcommands
  if echo "\${sandboxes}" | grep -qx "\${first}"; then
    COMPREPLY=( $(compgen -W "\${sandbox_cmds}" -- "\${cur}") )
    return 0
  fi

  # Flag completion for global commands (generated from the shared flag table)
  case "\${first}" in
${bashFlagCases()}
    *)
      COMPREPLY=( $(compgen -W "--help" -- "\${cur}") )
      ;;
  esac
  return 0
}

complete -F _nemoclaw nemoclaw
`;
}

function zshScript(): string {
  const globals = GLOBAL_COMMANDS.map((c) => `'${c}'`).join("\n    ");
  const subcommands = SANDBOX_SUBCOMMANDS.map((c) => `'${c}'`).join("\n    ");
  return `#compdef nemoclaw
# nemoclaw zsh completion
# Usage: source <(nemoclaw completion zsh)
# Or add to a file in \$fpath, e.g. /usr/local/share/zsh/site-functions/_nemoclaw

_nemoclaw() {
  local -a global_cmds sandbox_cmds sandboxes
  global_cmds=(
    ${globals}
  )
  sandbox_cmds=(
    ${subcommands}
  )
  sandboxes=( \${(f)"\$(${LIST_SANDBOXES_SNIPPET})"} )

  if (( CURRENT == 2 )); then
    _alternative \\
      'global:global command:compadd -a global_cmds' \\
      'sandbox:sandbox name:compadd -a sandboxes'
    return
  fi

  local first=\${words[2]}

  # If second token is a sandbox name, complete its subcommands
  if (( \${sandboxes[(I)\${first}]} )); then
    _describe 'sandbox subcommand' sandbox_cmds
    return
  fi

  # Flag completion for known global commands (generated from the shared flag table)
  case \${first} in
${zshFlagCases()}
    *)
      _arguments '--help'
      ;;
  esac
}

_nemoclaw "\$@"
`;
}

function fishScript(): string {
  const globals = GLOBAL_COMMANDS.map(
    (c) => `complete -c nemoclaw -n '__fish_use_subcommand' -a '${c}'`,
  ).join("\n");
  const subcommands = SANDBOX_SUBCOMMANDS.join(" ");
  return `# nemoclaw fish completion
# Usage: nemoclaw completion fish > ~/.config/fish/completions/nemoclaw.fish

${globals}

# Sandbox subcommands (when first arg is a sandbox name)
set -l sandbox_subcommands ${subcommands}

# Dynamic sandbox names
function __nemoclaw_sandboxes
  ${LIST_SANDBOXES_SNIPPET}
end

complete -c nemoclaw -n '__fish_use_subcommand' -a '(__nemoclaw_sandboxes)' -d 'Sandbox'
complete -c nemoclaw -n '__fish_seen_subcommand_from (__nemoclaw_sandboxes)' -a "$sandbox_subcommands"

# Global flags
complete -c nemoclaw -l help -s h -d 'Show help'

# Per-command flags (generated from the shared flag table)
${fishFlagLines()}
`;
}

const SCRIPT_GENERATORS: Record<CompletionShell, () => string> = {
  bash: bashScript,
  zsh: zshScript,
  fish: fishScript,
};

/**
 * Resolve the target shell from an explicit argument or the SHELL
 * environment variable, defaulting to bash.
 */
export function detectShell(shellEnv: string | undefined): CompletionShell {
  const shell = shellEnv ?? "";
  if (shell.includes("zsh")) return "zsh";
  if (shell.includes("fish")) return "fish";
  return "bash";
}

/** Generate the completion script for the given shell. */
export function generateCompletionScript(shell: CompletionShell): string {
  return SCRIPT_GENERATORS[shell]();
}

export interface CompletionActionDeps {
  write?: (script: string) => void;
  shellEnv?: string;
}

/**
 * Emit the completion script for the requested (or detected) shell.
 */
export function runCompletionAction(
  shell: string | undefined,
  deps: CompletionActionDeps = {},
): void {
  const write = deps.write ?? ((script: string) => process.stdout.write(script));
  const resolved =
    shell === "bash" || shell === "zsh" || shell === "fish"
      ? shell
      : detectShell(deps.shellEnv ?? process.env.SHELL);
  write(generateCompletionScript(resolved));
}
