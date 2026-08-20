/**
 * Read one bounded exact identity and optional working-tree snapshot from a Git checkout.
 * Requires a POSIX runtime with Bash, Git, mktemp, base64, wc, tr, and private temporary-directory support.
 * Rejects repositories with an unborn HEAD because no exact commit identity exists.
 */
export default async function read_git_checkout(input: {
  workdir: string;
  includeRoot?: boolean;
  includeBranch?: boolean;
  includeStatus?: boolean;
}): Promise<{
  root: string | null;
  head: string;
  branch: string | null;
  statusBase64: string | null;
  statusBytes: Integer | null;
  clean: boolean | null;
}> {
  const includeRoot = input.includeRoot ?? true;
  const includeBranch = input.includeBranch ?? true;
  const includeStatus = input.includeStatus ?? true;
  const result = await tools.bash({
    command: [
      "set -euo pipefail",
      "umask 077",
      'tmp=$(mktemp -d "${TMPDIR:-/tmp}/nemoclaw-git-checkout.XXXXXX")',
      "trap 'rm -rf -- \"$tmp\"' EXIT",
      "trap 'exit 1' HUP INT TERM",
      "read_head() { git rev-parse --verify HEAD 2>/dev/null || return 20; }",
      'read_branch() { local value rc; if value=$(git symbolic-ref --quiet --short HEAD 2>/dev/null); then printf \'%s\' "$value"; else rc=$?; [ "$rc" -eq 1 ] || return 21; fi; }',
      "if ! head_before=$(read_head); then exit 20; fi",
      "if ! branch_before=$(read_branch); then exit 21; fi",
      includeRoot
        ? "if ! root=$(git rev-parse --show-toplevel 2>/dev/null); then exit 22; fi"
        : "root=",
      includeStatus
        ? 'if ! git status --porcelain=v1 -z >"$tmp/status" 2>/dev/null; then exit 23; fi'
        : ': >"$tmp/status"',
      "status_bytes=$(wc -c <\"$tmp/status\" | tr -d '[:space:]')",
      'case "$status_bytes" in ""|*[!0-9]*) exit 24 ;; esac',
      '[ "$status_bytes" -le 750000 ] || exit 25',
      includeStatus
        ? "status_base64=$(base64 <\"$tmp/status\" | tr -d '\\r\\n')"
        : "status_base64=",
      "if ! head_after=$(read_head); then exit 20; fi",
      "if ! branch_after=$(read_branch); then exit 21; fi",
      '[ "$head_before" = "$head_after" ] || exit 26',
      '[ "$branch_before" = "$branch_after" ] || exit 26',
      "root_base64=$(printf '%s' \"$root\" | base64 | tr -d '\\r\\n')",
      "branch_before_base64=$(printf '%s' \"$branch_before\" | base64 | tr -d '\\r\\n')",
      "branch_after_base64=$(printf '%s' \"$branch_after\" | base64 | tr -d '\\r\\n')",
      'printf \'%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n\' "$head_before" "$head_after" "$root_base64" "$branch_before_base64" "$branch_after_base64" "$status_bytes" "$status_base64"',
    ].join("; "),
    workdir: input.workdir,
    description: "Read bounded stable Git checkout snapshot",
    timeoutMs: 30000,
  });
  if (result.kind !== "foreground")
    throw new Error("Git checkout snapshot did not return in the foreground");
  if (result.timedOut || result.aborted || result.signal !== null || result.sandbox?.denied)
    throw new Error("Git checkout snapshot did not terminate normally");
  if (result.exitCode !== 0) {
    if (result.exitCode === 20) throw new Error("Git checkout has an unborn HEAD");
    if (result.exitCode === 25) throw new Error("Git checkout status exceeded 750000 bytes");
    if (result.exitCode === 26) throw new Error("Git checkout identity changed during snapshot");
    throw new Error("Git checkout snapshot failed");
  }
  if (result.stdout.truncated || result.stderr.truncated)
    throw new Error("Git checkout snapshot exceeded bounded process output");
  if (result.stderr.text !== "")
    throw new Error("Git checkout snapshot returned unexpected diagnostics");

  const lines = result.stdout.text.split("\n");
  if (lines.length !== 8 || lines[7] !== "")
    throw new Error("Git checkout snapshot returned invalid framed output");
  const [
    headBefore,
    headAfter,
    rootFrame,
    branchBeforeFrame,
    branchAfterFrame,
    byteFrame,
    statusFrame,
  ] = lines;
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(headBefore ?? "") || headBefore !== headAfter)
    throw new Error("Git checkout snapshot returned invalid identity data");

  const decodeCanonical = (frame: string, label: string): Buffer => {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(frame))
      throw new Error("Git checkout snapshot returned invalid " + label + " frame");
    const decoded = Buffer.from(frame, "base64");
    if (decoded.toString("base64") !== frame)
      throw new Error("Git checkout snapshot returned non-canonical " + label + " frame");
    return decoded;
  };
  const decodeText = (frame: string, label: string): string => {
    const decoded = decodeCanonical(frame, label);
    const text = decoded.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(decoded))
      throw new Error("Git checkout snapshot returned invalid " + label + " text");
    return text;
  };

  const rootText = decodeText(rootFrame ?? "", "root");
  const branchBefore = decodeText(branchBeforeFrame ?? "", "branch");
  const branchAfter = decodeText(branchAfterFrame ?? "", "branch");
  if (branchBefore !== branchAfter || branchBefore.length > 1024 || /[\0\r\n]/u.test(branchBefore))
    throw new Error("Git checkout snapshot returned invalid branch identity");
  if (includeRoot && (!rootText.startsWith("/") || rootText.length > 4096 || /\0/u.test(rootText)))
    throw new Error("Git checkout snapshot returned invalid checkout root");

  if (!/^(?:0|[1-9][0-9]{0,5})$/u.test(byteFrame ?? ""))
    throw new Error("Git checkout snapshot returned invalid status byte count");
  const measuredStatusBytes = Number(byteFrame);
  if (!Number.isSafeInteger(measuredStatusBytes) || measuredStatusBytes > 750000)
    throw new Error("Git checkout status exceeded 750000 bytes");
  const statusBuffer = decodeCanonical(statusFrame ?? "", "status");
  if (statusBuffer.length !== measuredStatusBytes)
    throw new Error("Git checkout snapshot returned mismatched status byte count");

  return {
    root: includeRoot ? rootText : null,
    head: headBefore ?? "",
    branch: includeBranch ? branchBefore || null : null,
    statusBase64: includeStatus ? (statusFrame ?? "") : null,
    statusBytes: includeStatus ? measuredStatusBytes : null,
    clean: includeStatus ? measuredStatusBytes === 0 : null,
  };
}
