// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";

import { NemoClawCommand } from "../lib/cli/nemoclaw-oclif-command";

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
  sandboxes=$(nemoclaw list 2>/dev/null | awk 'NR>1 {print $1}') || sandboxes=""

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

  # Flag completion for global commands
  case "\${first}" in
    credentials:add|credentials)
      COMPREPLY=( $(compgen -W "--type --credential --config --from-existing --help" -- "\${cur}") )
      ;;
    credentials:reset)
      COMPREPLY=( $(compgen -W "--yes -y --help" -- "\${cur}") )
      ;;
    status)
      COMPREPLY=( $(compgen -W "--json --help" -- "\${cur}") )
      ;;
    inference:get|inference:set)
      COMPREPLY=( $(compgen -W "--json --help" -- "\${cur}") )
      ;;
    onboard)
      COMPREPLY=( $(compgen -W "--sandbox --agent --non-interactive --yes -y --help" -- "\${cur}") )
      ;;
    debug)
      COMPREPLY=( $(compgen -W "--quick --output -o --sandbox --help" -- "\${cur}") )
      ;;
    gc)
      COMPREPLY=( $(compgen -W "--yes -y --force --dry-run --help" -- "\${cur}") )
      ;;
    list)
      COMPREPLY=( $(compgen -W "--json --help" -- "\${cur}") )
      ;;
    completion)
      COMPREPLY=( $(compgen -W "bash zsh fish" -- "\${cur}") )
      ;;
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
  sandboxes=( \${(f)"\$(nemoclaw list 2>/dev/null | awk 'NR>1 {print \$1}')"} )

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

  # Flag completion for known global commands
  case \${first} in
    onboard)
      _arguments '--sandbox[Sandbox name]:name' '--agent[Agent runtime]:agent' '--non-interactive' '--yes' '-y' '--help'
      ;;
    status)
      _arguments '--json[JSON output]' '--help'
      ;;
    inference:get|inference:set)
      _arguments '--json[JSON output]' '--help'
      ;;
    credentials:add|credentials)
      _arguments '--type[Credential type]:type' '--credential[Env var name]:name' '--config[Key=value config]:kv' '--from-existing' '--help'
      ;;
    debug)
      _arguments '--quick' '--output[Output file]:file:_files' '-o[Output file]:file:_files' '--sandbox[Sandbox name]:name' '--help'
      ;;
    gc)
      _arguments '--yes' '-y' '--force' '--dry-run' '--help'
      ;;
    list)
      _arguments '--json[JSON output]' '--help'
      ;;
    completion)
      local -a shells; shells=('bash' 'zsh' 'fish')
      _describe 'shell' shells
      ;;
    *)
      _arguments '--help'
      ;;
  esac
}

_nemoclaw "\$@"
`;
}

function fishScript(): string {
  const globals = GLOBAL_COMMANDS.map((c) => `complete -c nemoclaw -n '__fish_use_subcommand' -a '${c}'`).join(
    "\n",
  );
  return `# nemoclaw fish completion
# Usage: nemoclaw completion fish > ~/.config/fish/completions/nemoclaw.fish

${globals}

# Sandbox subcommands (when first arg is a sandbox name)
# Fish will complete remaining tokens as sandbox subcommands
set -l sandbox_subcommands status logs exec agent connect destroy rebuild \\
  recover download doctor dashboard-url policy-add policy-remove policy-list \\
  channels snapshot shields skill inference

# Dynamic sandbox names
function __nemoclaw_sandboxes
  nemoclaw list 2>/dev/null | awk 'NR>1 {print $1}'
end

complete -c nemoclaw -n '__fish_use_subcommand' -a '(__nemoclaw_sandboxes)' -d 'Sandbox'
complete -c nemoclaw -n '__fish_seen_subcommand_from (__nemoclaw_sandboxes)' -a "$sandbox_subcommands"

# Global flags
complete -c nemoclaw -l help -s h -d 'Show help'
complete -c nemoclaw -l json -d 'JSON output' -n '__fish_seen_subcommand_from status list inference:get inference:set'
`;
}

export default class CompletionCommand extends NemoClawCommand {
  static id = "completion";
  static strict = true;
  static summary = "Generate shell completion script";
  static description =
    "Output a shell completion script for nemoclaw. Source it in your shell profile to enable tab completion for commands, flags, and sandbox names.";
  static usage = ["completion [bash|zsh|fish]"];
  static examples = [
    "# Bash — add to ~/.bashrc or ~/.bash_profile:",
    'source <(<%= config.bin %> completion bash)',
    "",
    "# Zsh — add to ~/.zshrc:",
    'source <(<%= config.bin %> completion zsh)',
    "",
    "# Fish — install permanently:",
    '<%= config.bin %> completion fish > ~/.config/fish/completions/<%= config.bin %>.fish',
  ];

  static args = {
    shell: Args.string({
      description: "Target shell: bash, zsh, or fish",
      options: ["bash", "zsh", "fish"],
      required: false,
      default: "bash",
    }),
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(CompletionCommand);
    const shell = args.shell ?? detectShell();

    switch (shell) {
      case "zsh":
        process.stdout.write(zshScript());
        break;
      case "fish":
        process.stdout.write(fishScript());
        break;
      default:
        process.stdout.write(bashScript());
    }
  }
}

function detectShell(): string {
  const shell = process.env.SHELL ?? "";
  if (shell.includes("zsh")) return "zsh";
  if (shell.includes("fish")) return "fish";
  return "bash";
}
