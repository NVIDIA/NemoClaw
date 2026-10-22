import { realpathSync } from "node:fs";
import path from "node:path";

/**
 * Run focused Vitest files with selected projects, bounded head/tail output, and explicit truncation metadata.
 */
export default async function run_targeted_vitest(input: {
  workdir: string;
  files: string[];
  projects?: (
    | "cli"
    | "integration"
    | "installer-integration"
    | "package-contract"
    | "plugin"
    | "e2e-support"
  )[];
  coverage?: boolean;
  timeoutMs?: Integer /** Maximum lines returned from each output stream; defaults to 120 and is capped at 500. */;
  maxLines?: Integer /** Which end of each output stream to retain when clipping; defaults to tail. */;
  clipMode?: "head" | "tail";
}): Promise<{
  command: string;
  code: Integer;
  stdout: string;
  stderr: string;
  truncated: boolean;
  truncationNotice: string | null;
  truncationReasons: string[];
  clipMode: "head" | "tail";
  maxLines: Integer;
  stdoutTotalLines: Integer;
  stdoutReturnedLines: Integer;
  stderrTotalLines: Integer;
  stderrReturnedLines: Integer;
}> {
  if (!Array.isArray(input.files) || input.files.length === 0 || input.files.length > 100)
    throw new Error("files must contain 1 to 100 test files");
  const allowed = new Set([
    "cli",
    "integration",
    "installer-integration",
    "package-contract",
    "plugin",
    "e2e-support",
  ]);
  if (input.projects && (!Array.isArray(input.projects) || input.projects.length > 6))
    throw new Error("projects must contain at most 6 entries");
  const projects = input.projects?.length ? [...new Set(input.projects)] : ["cli", "integration"];
  const invalid = projects.filter((x) => !allowed.has(x));
  if (invalid.length) throw new Error(`Unsupported Vitest project(s): ${invalid.join(", ")}`);
  const repoRelative = (value, maxLength) =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !value.startsWith("-") &&
    !value.startsWith("/") &&
    !value.split("/").some((part) => part === ".." || part === ".") &&
    /^[A-Za-z0-9_./@-]+$/.test(value);
  if (!input.files.every((x) => repoRelative(x, 4096)))
    throw new Error(
      "Test files must be non-option repository-relative paths of at most 4096 characters",
    );
  if (!projects.every((x) => repoRelative(x, 128)))
    throw new Error(
      "Vitest projects must be non-option repository-relative names of at most 128 characters",
    );
  const quote = (v) => "'" + String(v).replaceAll("'", "'\"'\"'") + "'";
  const args = ["run", ...projects.flatMap((x) => ["--project", x]), ...input.files];
  if (input.coverage)
    args.push(
      "--coverage",
      "--coverage.reporter=json-summary",
      "--coverage.reportsDirectory=coverage/targeted",
      "--coverage.include=bin/**/*.js",
      "--coverage.include=src/**/*.ts",
      "--coverage.exclude=test/**/*.js",
      "--coverage.exclude=test/**/*.ts",
    );
  const timeoutMs = Math.max(30000, Math.min(300000, input.timeoutMs ?? 180000));
  const maxLines = Math.max(1, Math.min(500, input.maxLines ?? 120));
  const clipMode = input.clipMode ?? "tail";
  if (!new Set(["head", "tail"]).has(clipMode)) throw new Error("clipMode must be head or tail");
  const nodeExecutable = realpathSync(process.execPath);
  const nodeBinDir = path.dirname(nodeExecutable);
  const nodePrefix = path.dirname(nodeBinDir);
  const nodePrefixParent = path.dirname(nodePrefix);
  const command =
    `${quote(nodeExecutable)} ${quote("node_modules/vitest/vitest.mjs")} ` +
    args.map(quote).join(" ");
  const isolatedCommand = `set -eu
umask 077
repo_root=$(/bin/pwd -P)
node_executable=${quote(nodeExecutable)}
node_bin_dir=${quote(nodeBinDir)}
node_prefix=${quote(nodePrefix)}
node_prefix_parent=${quote(nodePrefixParent)}
isolation_root=$(/usr/bin/mktemp -d /tmp/ncv.XXXXXX 2>/dev/null) ||
  isolation_root=$(/usr/bin/mktemp -d "\${TMPDIR:-/tmp}/ncv.XXXXXX")
isolation_root=$(cd "$isolation_root" && /bin/pwd -P)
trap '/bin/rm -R -f -- "$isolation_root"' EXIT
/bin/mkdir -p "$isolation_root/bin" "$isolation_root/home" "$isolation_root/tmp"
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
/usr/bin/git -C "$repo_root" for-each-ref --format='update %(refname) %(objectname)' |
  /usr/bin/env -i PATH=/usr/bin:/bin GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
    /usr/bin/git --git-dir="$git_shadow" update-ref --stdin

cat >"$isolation_root/bin/git" <<'GIT_WRAPPER'
#!/bin/sh
set -eu
repo_root=\${NEMOCLAW_REPO_ROOT:?}
git_shadow=\${NEMOCLAW_GIT_SHADOW:?}
if [ "\${GIT_DIR+x}" = x ] || [ "\${GIT_WORK_TREE+x}" = x ]; then
  exec /usr/bin/git "$@"
fi
for git_arg do
  if [ "$git_arg" = init ]; then exec /usr/bin/git "$@"; fi
done
git_cwd=$PWD
git_expect_c=false
for git_arg do
  if [ "$git_expect_c" = true ]; then
    case "$git_arg" in /*) git_cwd=$git_arg ;; *) git_cwd=$git_cwd/$git_arg ;; esac
    git_expect_c=false
    continue
  fi
  case "$git_arg" in
    -C) git_expect_c=true ;;
    -C?*) git_c_value=\${git_arg#-C}; case "$git_c_value" in /*) git_cwd=$git_c_value ;; *) git_cwd=$git_cwd/$git_c_value ;; esac ;;
  esac
done
if git_cwd=$(cd "$git_cwd" 2>/dev/null && /bin/pwd -P); then
  case "$git_cwd/" in
    "$repo_root/"*)
      git_probe=$git_cwd
      while [ "$git_probe" != "$repo_root" ]; do
        if [ -e "$git_probe/.git" ]; then exec /usr/bin/git "$@"; fi
        git_probe=\${git_probe%/*}
      done
      exec /usr/bin/env GIT_DIR="$git_shadow" GIT_WORK_TREE="$repo_root" /usr/bin/git "$@"
      ;;
  esac
fi
exec /usr/bin/git "$@"
GIT_WRAPPER
/bin/chmod 0555 "$isolation_root/bin/git"

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
  (literal (param "NODE_EXECUTABLE")))
(allow file-write*
  (subpath (param "REPO_ROOT"))
  (subpath (param "ISOLATION_ROOT"))
  (literal "/dev/null"))
(deny file-write* (subpath (string-append (param "REPO_ROOT") "/.git")))
(deny file-write* (subpath (param "GIT_DIR")))
(deny file-write* (subpath (param "GIT_COMMON_DIR")))
(deny file-read*
  (subpath (param "GIT_DIR"))
  (subpath (param "GIT_COMMON_DIR")))
(allow file-read* (subpath (param "GIT_OBJECTS")))
(allow network-outbound (remote ip))
(allow network-inbound (local ip))
(allow network-bind (local ip))
(allow network* (subpath (param "ISOLATION_ROOT")))
PROFILE
  set +e
  /usr/bin/sandbox-exec -D REPO_ROOT="$repo_root" -D ISOLATION_ROOT="$isolation_root" \
    -D GIT_DIR="$git_dir" -D GIT_COMMON_DIR="$git_common_dir" \
    -D GIT_OBJECTS="$git_common_dir/objects" \
    -D NODE_EXECUTABLE="$node_executable" \
    -f "$sandbox_profile" /usr/bin/env -i \
    HOME="$isolation_root/home" XDG_CONFIG_HOME="$isolation_root/home" TMPDIR="$isolation_root/tmp" \
    PATH="$isolation_root/bin:$node_bin_dir:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    CI=true NO_COLOR=1 TERM=dumb \
    NEMOCLAW_REPO_ROOT="$repo_root" NEMOCLAW_GIT_SHADOW="$git_shadow" \
    NPM_CONFIG_USERCONFIG=/dev/null \
    GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_OPTIONAL_LOCKS=0 \
    /bin/sh -c ${quote(command)}
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
    set -- "$@" --ro-bind "$git_shadow" /workspace/.git
    set -- "$@" --ro-bind "$git_common_dir/objects" /workspace/.git/objects
  fi
  for system_path in /usr /bin /sbin /lib /lib64 /opt /etc; do
    if [ -e "$system_path" ]; then set -- "$@" --ro-bind "$system_path" "$system_path"; fi
  done
  case "$node_executable" in
    /usr|/usr/*|/bin|/bin/*|/sbin|/sbin/*|/lib|/lib/*|/lib64|/lib64/*|/opt|/opt/*|/etc|/etc/*) ;;
    *) set -- "$@" --dir "$node_prefix_parent" --dir "$node_prefix" --dir "$node_bin_dir" \
      --ro-bind "$node_executable" "$node_executable" ;;
  esac
  set +e
  "$@" --chdir /workspace /usr/bin/env -i \
    HOME=/home/validator XDG_CONFIG_HOME=/home/validator TMPDIR=/tmp \
    PATH="$node_bin_dir:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    CI=true NO_COLOR=1 TERM=dumb \
    NPM_CONFIG_USERCONFIG=/dev/null \
    GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_OPTIONAL_LOCKS=0 \
    /bin/sh -c ${quote(command)}
  validation_status=$?
  set -e
  exit "$validation_status"
fi

printf '%s\n' 'Credential-isolated validation requires sandbox-exec or bubblewrap.' >&2
exit 126`;
  const result = await tools.bash({
    command: isolatedCommand,
    workdir: input.workdir,
    description: "Run selected Vitest files without host credentials",
    timeoutMs,
  });
  if (result.kind !== "foreground") throw new Error("Unexpected background result");
  const [stdout, stderr] = await Promise.all([
    tools.project_diagnostic_text({
      lines: String(result.stdout.text).split(/\r?\n/),
      clipMode,
      maxLines,
      maxCharacters: 4000000,
      maxLineCharacters: 4000000,
      sourceTruncated: result.stdout.truncated,
    }),
    tools.project_diagnostic_text({
      lines: String(result.stderr.text).split(/\r?\n/),
      clipMode,
      maxLines,
      maxCharacters: 4000000,
      maxLineCharacters: 4000000,
      sourceTruncated: result.stderr.truncated,
    }),
  ]);
  const transportTruncated = stdout.sourceTruncated || stderr.sourceTruncated;
  const stdoutClipped = stdout.lineClipped;
  const stderrClipped = stderr.lineClipped;
  const truncated = stdout.truncated || stderr.truncated;
  return {
    command,
    code: result.exitCode ?? -1,
    stdout: stdout.text,
    stderr: stderr.text,
    truncated,
    truncationNotice: truncated
      ? "TRUNCATED OUTPUT: do not assume omitted test output is irrelevant or absent."
      : null,
    truncationReasons: [
      ...(transportTruncated ? ["tool-transport-truncated"] : []),
      ...(stdoutClipped ? ["stdout-exceeded-maxLines"] : []),
      ...(stderrClipped ? ["stderr-exceeded-maxLines"] : []),
    ],
    clipMode,
    maxLines,
    stdoutTotalLines: stdout.selectedLines,
    stdoutReturnedLines: stdout.returnedLines,
    stderrTotalLines: stderr.selectedLines,
    stderrReturnedLines: stderr.returnedLines,
  };
}
