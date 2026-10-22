import { realpathSync } from "node:fs";
import path from "node:path";

/**
 * Run guarded focused validation for a NemoClaw repair.
 */
export default async function run_nemoclaw_focused_repair_validation(input: {
  workdir: string;
  files?: string[];
  testFiles?: string[];
  projects?: string[];
  baseRef?: string;
  formatWrite?: boolean;
  typecheckCli?: boolean;
  typecheckPlugin?: boolean;
  repoChecks?: boolean;
  diffCheck?: boolean;
  nulCheck?: boolean;
  docs?: boolean;
  timeoutMs?: Integer;
  dryRun?: boolean;
}): Promise<{
  ok: boolean;
  dryRun: boolean;
  baseRef: string;
  files: string[];
  tests: string[];
  projects: string[];
  inferred: {
    baseRef: string;
    files: string[];
    branchFiles: string[];
    workingTreeFiles: string[];
    untrackedFiles: string[];
    projects: string[];
    targetedFiles: string[];
    commands: string[];
    notes: string[];
  };
  planned: { name: string; command: string; mutates?: boolean }[];
  steps: {
    name: string;
    command: string;
    code: Integer;
    stdoutTail: string;
    stderrTail: string;
    truncated: boolean;
  }[];
  failed: {
    name: string;
    command: string;
    code: Integer;
    stdoutTail: string;
    stderrTail: string;
    truncated: boolean;
  }[];
  nul: null | {
    ok: boolean;
    checked: Integer;
    files: string[];
    findings: { file: string; count: Integer }[];
    changed: {
      baseRef: string;
      files: string[];
      branchFiles: string[];
      workingTreeFiles: string[];
      untrackedFiles: string[];
    };
  };
}> {
  const baseRef = input.baseRef ?? "origin/main",
    dryRun = input.dryRun ?? true,
    timeoutMs = Math.max(30000, Math.min(300000, input.timeoutMs ?? 180000));
  const inferred = await tools.infer_validation_for_changed_files({
    workdir: input.workdir,
    baseRef,
  });
  const files = input.files ?? inferred.files,
    tests = input.testFiles ?? inferred.targetedFiles,
    projects = input.projects ?? inferred.projects,
    safe = (file) =>
      /^[A-Za-z0-9_.@][A-Za-z0-9_./@-]*$/.test(file) &&
      file.split("/").every((part) => part !== "" && part !== "." && part !== "..");
  if (!files.every(safe) || !tests.every(safe))
    throw new Error("File paths must be normalized repository-relative paths");
  const allowed = new Set([
    "cli",
    "integration",
    "installer-integration",
    "package-contract",
    "plugin",
    "e2e-support",
  ]);
  if (!projects.every((x) => allowed.has(x))) throw new Error("Unsupported Vitest project");
  const nodeExecutable = realpathSync(process.execPath),
    nodeBinDir = path.dirname(nodeExecutable),
    nodePrefix = path.dirname(nodeBinDir),
    nodePrefixParent = path.dirname(nodePrefix),
    q = (v) => "'" + String(v).replaceAll("'", "'\"'\"'") + "'",
    isolate = (command) =>
      `set -eu
umask 077
repo_root=$(/bin/pwd -P)
node_bin_dir=${q(nodeBinDir)}
node_prefix=${q(nodePrefix)}
node_prefix_parent=${q(nodePrefixParent)}
isolation_root=$(/usr/bin/mktemp -d /tmp/ncv.XXXXXX)
isolation_root=$(cd "$isolation_root" && /bin/pwd -P)
trap '/bin/rm -R -f -- "$isolation_root"' EXIT
/bin/mkdir -p "$isolation_root/home" "$isolation_root/tmp"
git_dir=$(/usr/bin/git -C "$repo_root" rev-parse --absolute-git-dir)
git_common_dir=$(/usr/bin/git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir)
git_dir=$(cd "$git_dir" && /bin/pwd -P)
git_common_dir=$(cd "$git_common_dir" && /bin/pwd -P)
git_worktree_name=
if [ -f "$repo_root/.git" ]; then
  git_worktree_name=\${git_dir##*/}
  case "$git_worktree_name" in
    ''|*[!A-Za-z0-9._-]*) printf '%s\n' 'Unsupported Git worktree metadata path.' >&2; exit 126 ;;
  esac
  if [ "$git_dir" != "$git_common_dir/worktrees/$git_worktree_name" ]; then
    printf '%s\n' 'Git worktree metadata must belong to its common Git directory.' >&2
    exit 126
  fi
fi

git_shadow="$isolation_root/git"
/bin/mkdir -p "$git_shadow/objects/info" "$git_shadow/refs"
cat >"$git_shadow/config" <<'GIT_CONFIG'
[core]
	repositoryformatversion = 0
	bare = false
	logallrefupdates = false
GIT_CONFIG
printf '%s\n' "$git_common_dir/objects" >"$git_shadow/objects/info/alternates"
if [ -f "$git_dir/index" ]; then /bin/cp "$git_dir/index" "$git_shadow/index"; fi
if [ -f "$git_common_dir/shallow" ]; then /bin/cp "$git_common_dir/shallow" "$git_shadow/shallow"; fi
git_head_ref=$(/usr/bin/git -C "$repo_root" symbolic-ref -q HEAD || :)
if [ -n "$git_head_ref" ]; then
  printf 'ref: %s\n' "$git_head_ref" >"$git_shadow/HEAD"
else
  /usr/bin/git -C "$repo_root" rev-parse --verify HEAD >"$git_shadow/HEAD"
fi
/usr/bin/git -C "$repo_root" for-each-ref --format='%(objectname) %(refname)' |
while IFS=' ' read -r git_ref_oid git_ref_name; do
  /usr/bin/env -i PATH=/usr/bin:/bin GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
    /usr/bin/git --git-dir="$git_shadow" update-ref "$git_ref_name" "$git_ref_oid"
done

if [ -x /usr/bin/sandbox-exec ]; then
  sandbox_profile="$isolation_root/profile.sb"
  cat >"$sandbox_profile" <<'PROFILE'
(version 1)
(deny default)
(allow process*)
(allow signal (target same-sandbox))
(allow sysctl-read)
(allow mach-lookup
  (global-name "com.apple.trustd")
  (global-name "com.apple.trustd.agent"))
(allow file-read-metadata)
(allow file-read-data (literal "/"))
(allow file-read*
  (subpath "/System")
  (subpath "/usr")
  (subpath "/bin")
  (subpath "/sbin")
  (subpath "/opt/homebrew")
  (subpath "/usr/local")
  (subpath "/Library")
  (subpath "/private/etc")
  (subpath "/private/var/db")
  (subpath "/dev")
  (subpath (param "REPO_ROOT"))
  (subpath (param "ISOLATION_ROOT"))
  (subpath (param "GIT_OBJECTS"))
  (subpath (param "NODE_PREFIX")))
(allow file-write*
  (subpath (param "REPO_ROOT"))
  (subpath (param "ISOLATION_ROOT"))
  (literal "/dev/null"))
(deny file-write* (subpath (string-append (param "REPO_ROOT") "/.git")))
(deny file-write* (subpath (param "GIT_DIR")))
(deny file-write* (subpath (param "GIT_COMMON_DIR")))
(deny file-read*
  (literal (param "GIT_CONFIG_PATH"))
  (literal (param "GIT_WORKTREE_CONFIG_PATH")))
(allow network-outbound (remote ip))
(allow network-inbound (local ip))
(allow network-bind (local ip))
(allow network* (subpath (param "ISOLATION_ROOT")))
PROFILE
  set +e
  /usr/bin/sandbox-exec -D REPO_ROOT="$repo_root" -D ISOLATION_ROOT="$isolation_root" \
    -D GIT_DIR="$git_dir" -D GIT_COMMON_DIR="$git_common_dir" \
    -D GIT_OBJECTS="$git_common_dir/objects" \
    -D GIT_CONFIG_PATH="$git_common_dir/config" \
    -D GIT_WORKTREE_CONFIG_PATH="$git_dir/config.worktree" \
    -D NODE_PREFIX="$node_prefix" \
    -f "$sandbox_profile" /usr/bin/env -i \
    HOME="$isolation_root/home" XDG_CONFIG_HOME="$isolation_root/home" TMPDIR="$isolation_root/tmp" \
    PATH="$node_bin_dir:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    CI=true NO_COLOR=1 TERM=dumb \
    NPM_CONFIG_USERCONFIG=/dev/null \
    GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_OPTIONAL_LOCKS=0 \
    GIT_DIR="$git_shadow" GIT_WORK_TREE="$repo_root" \
    /bin/sh -c ${q(command)}
  validation_status=$?
  set -e
  exit "$validation_status"
fi

if command -v bwrap >/dev/null 2>&1; then
  set -- "$(command -v bwrap)" --die-with-parent --new-session --unshare-all --share-net
  set -- "$@" --proc /proc --dev /dev --tmpfs /tmp --dir /home
  set -- "$@" --bind "$isolation_root/home" /home/validator --bind "$repo_root" /workspace
  set -- "$@" --dir /git --ro-bind "$git_shadow" /git
  set -- "$@" --ro-bind "$git_common_dir/objects" /git/objects
  if [ -n "$git_worktree_name" ]; then
    git_pointer="$isolation_root/git-pointer"
    printf 'gitdir: /git\n' >"$git_pointer"
    set -- "$@" --ro-bind "$git_pointer" /workspace/.git
  else
    empty_git="$isolation_root/empty-git"
    /bin/mkdir "$empty_git"
    set -- "$@" --ro-bind "$empty_git" /workspace/.git
  fi
  for system_path in /usr /bin /sbin /lib /lib64 /opt /etc; do
    if [ -e "$system_path" ]; then set -- "$@" --ro-bind "$system_path" "$system_path"; fi
  done
  case "$node_prefix" in
    /usr|/usr/*|/bin|/bin/*|/sbin|/sbin/*|/lib|/lib/*|/lib64|/lib64/*|/opt|/opt/*|/etc|/etc/*) ;;
    *) set -- "$@" --dir "$node_prefix_parent" --ro-bind "$node_prefix" "$node_prefix" ;;
  esac
  set +e
  "$@" --chdir /workspace /usr/bin/env -i \
    HOME=/home/validator XDG_CONFIG_HOME=/home/validator TMPDIR=/tmp \
    PATH="$node_bin_dir:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    CI=true NO_COLOR=1 TERM=dumb \
    NPM_CONFIG_USERCONFIG=/dev/null \
    GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_OPTIONAL_LOCKS=0 \
    GIT_DIR=/git GIT_WORK_TREE=/workspace \
    /bin/sh -c ${q(command)}
  validation_status=$?
  set -e
  exit "$validation_status"
fi

printf '%s\n' 'Credential-isolated validation requires sandbox-exec or bubblewrap.' >&2
exit 126`,
    commands = [],
    oxc = files.filter((f) => /\.(cjs|cts|js|jsx|mjs|mts|ts|tsx)$/.test(f));
  if (oxc.length) {
    const mode = (input.formatWrite ?? true) ? "--write" : "--check";
    commands.push({
      name: "Oxfmt",
      command:
        "for oxc_file in " +
        oxc.map(q).join(" ") +
        '; do oxc_path=$oxc_file; while [ "$oxc_path" != . ]; do ' +
        'if [ -L "$oxc_path" ]; then printf "%s\\n" "Source paths must not contain symbolic links" >&2; exit 2; fi; ' +
        'oxc_path=$(dirname -- "$oxc_path"); done; done; npx --no-install oxfmt ' +
        mode +
        " --no-error-on-unmatched-pattern -- " +
        oxc.map(q).join(" "),
      mutates: mode === "--write",
    });
    const typeAware = (file) => /^(src\/lib\/adapters\/|nemoclaw\/src\/)/.test(file);
    const ordinary = oxc.filter((file) => !typeAware(file));
    const typed = oxc.filter(typeAware);
    if (ordinary.length)
      commands.push({
        name: "Oxlint",
        command:
          "npx --no-install oxlint --no-error-on-unmatched-pattern -- " + ordinary.map(q).join(" "),
      });
    if (typed.length)
      commands.push({
        name: "Oxlint type-aware",
        command:
          "npx --no-install oxlint --type-aware --no-error-on-unmatched-pattern -- " +
          typed.map(q).join(" "),
      });
  }
  if (
    input.typecheckCli === true ||
    (input.typecheckCli !== false &&
      files.some((f) => f.startsWith("src/") && /\.[cm]?tsx?$/.test(f)))
  )
    commands.push({ name: "CLI typecheck", command: "npm run typecheck:cli" });
  if (
    input.typecheckPlugin === true ||
    (input.typecheckPlugin !== false &&
      files.some((f) => f.startsWith("nemoclaw/") && /\.[cm]?tsx?$/.test(f)))
  )
    commands.push({ name: "Plugin typecheck", command: "npm --prefix nemoclaw run typecheck" });
  if (input.repoChecks !== false)
    commands.push({ name: "Repository checks", command: "npm run checks:repository" });
  if (tests.length)
    commands.push({
      name: "Focused Vitest",
      command: ["npx", "vitest", "run", ...projects.flatMap((p) => ["--project", p]), ...tests]
        .map(q)
        .join(" "),
    });
  if (
    input.docs === true ||
    (input.docs !== false && files.some((f) => f.startsWith("docs/") || f.startsWith("fern/")))
  )
    commands.push({ name: "Docs validation", command: "npm run docs", mutates: true });
  if (input.diffCheck !== false)
    commands.push(
      {
        name: "Branch diff whitespace check",
        command: "git diff --check " + q(baseRef + "...HEAD") + " --",
      },
      { name: "Working-tree whitespace check", command: "git diff --check HEAD --" },
    );
  if (dryRun)
    return {
      ok: true,
      dryRun,
      baseRef,
      files,
      tests,
      projects,
      inferred,
      planned: commands,
      steps: [],
      failed: [],
      nul: null,
    };
  const steps = [];
  for (const item of commands) {
    const r = await tools.bash({
      command: isolate(item.command),
      workdir: input.workdir,
      description: "Run credential-isolated focused repair validation",
      timeoutMs,
    });
    if (r.kind !== "foreground") throw new Error("Unexpected background result");
    const [stdoutTail, stderrTail] = await Promise.all([
      tools.project_diagnostic_text({
        lines: r.stdout.text.split(/\r?\n/),
        clipMode: "tail",
        maxLines: 80,
        maxCharacters: 4000000,
        maxLineCharacters: 4000000,
        sourceTruncated: r.stdout.truncated,
      }),
      tools.project_diagnostic_text({
        lines: r.stderr.text.split(/\r?\n/),
        clipMode: "tail",
        maxLines: 80,
        maxCharacters: 4000000,
        maxLineCharacters: 4000000,
        sourceTruncated: r.stderr.truncated,
      }),
    ]);
    steps.push({
      name: item.name,
      command: item.command,
      code: r.exitCode ?? -1,
      stdoutTail: stdoutTail.text,
      stderrTail: stderrTail.text,
      truncated: r.stdout.truncated || r.stderr.truncated,
    });
  }
  let nul = null;
  if (input.nulCheck !== false)
    nul = await tools.check_changed_files_for_nul_bytes({ workdir: input.workdir, baseRef });
  if (nul)
    steps.push({
      name: "NUL byte check",
      command: "check_changed_files_for_nul_bytes",
      code: nul.ok ? 0 : 1,
      stdoutTail: JSON.stringify(nul),
      stderrTail: "",
      truncated: false,
    });
  const failed = steps.filter((s) => s.code !== 0);
  return {
    ok: failed.length === 0,
    dryRun,
    baseRef,
    files,
    tests,
    projects,
    inferred,
    planned: commands,
    steps,
    failed,
    nul,
  };
}
