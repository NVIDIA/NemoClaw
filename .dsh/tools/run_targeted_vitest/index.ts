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
  const args = ["vitest", "run", ...projects.flatMap((x) => ["--project", x]), ...input.files];
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
  const command = "npx " + args.map(quote).join(" ");
  const isolatedCommand = `set -eu
umask 077
repo_root=$(/bin/pwd -P)
isolation_root=$(/usr/bin/mktemp -d /tmp/nemoclaw-validation.XXXXXX)
isolation_root=$(cd "$isolation_root" && /bin/pwd -P)
trap '/bin/rm -R -f -- "$isolation_root"' EXIT
/bin/mkdir -p "$isolation_root/home" "$isolation_root/tmp"

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
  (subpath (param "ISOLATION_ROOT")))
(allow file-write*
  (subpath (param "REPO_ROOT"))
  (subpath (param "ISOLATION_ROOT"))
  (literal "/dev/null"))
(deny file-write* (subpath (string-append (param "REPO_ROOT") "/.git")))
(allow network*)
PROFILE
  set +e
  /usr/bin/sandbox-exec -D REPO_ROOT="$repo_root" -D ISOLATION_ROOT="$isolation_root" \
    -f "$sandbox_profile" /usr/bin/env -i \
    HOME="$isolation_root/home" XDG_CONFIG_HOME="$isolation_root/home" TMPDIR="$isolation_root/tmp" \
    PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin \
    CI=true NO_COLOR=1 TERM=dumb \
    NPM_CONFIG_USERCONFIG=/dev/null \
    GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
    /bin/sh -c ${quote(command)}
  validation_status=$?
  set -e
  exit "$validation_status"
fi

if command -v bwrap >/dev/null 2>&1; then
  set -- "$(command -v bwrap)" --die-with-parent --new-session --unshare-all --share-net
  set -- "$@" --proc /proc --dev /dev --tmpfs /tmp --dir /home
  set -- "$@" --bind "$isolation_root/home" /home/validator --bind "$repo_root" /workspace
  if [ -e "$repo_root/.git" ]; then set -- "$@" --ro-bind "$repo_root/.git" /workspace/.git; fi
  for system_path in /usr /bin /sbin /lib /lib64 /opt /etc; do
    if [ -e "$system_path" ]; then set -- "$@" --ro-bind "$system_path" "$system_path"; fi
  done
  set +e
  "$@" --chdir /workspace /usr/bin/env -i \
    HOME=/home/validator XDG_CONFIG_HOME=/home/validator TMPDIR=/tmp \
    PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin \
    CI=true NO_COLOR=1 TERM=dumb \
    NPM_CONFIG_USERCONFIG=/dev/null \
    GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
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
