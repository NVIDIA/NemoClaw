/**
 * Read bounded Markdown summaries from retained PR Review Advisor artifacts for one GitHub Actions run. Requires Bash, authenticated GitHub CLI access to repository Actions artifacts, base64, mktemp, stat, Info-ZIP zipinfo and unzip on Linux.
 */
export default async function read_nemoclaw_advisor_run_summaries(input: {
  workdir: string;
  runId: Integer;
  repo?: string;
  maxArtifacts?: Integer;
  maxSummaryCharacters?: Integer;
}): Promise<{
  repo: string;
  runId: Integer;
  artifactsFound: Integer;
  summariesRead: Integer;
  truncated: boolean;
  summaries: {
    artifactId: Integer;
    artifactName: string;
    entry: string;
    text: string;
    truncated: boolean;
  }[];
  failures: { artifactId: Integer; artifactName: string; detail: string }[];
}> {
  const repo = input.repo ?? "NVIDIA/NemoClaw";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("repo must be owner/name");
  if (!Number.isSafeInteger(input.runId) || input.runId < 1)
    throw new Error("runId must be a positive integer");
  const maxArtifacts = input.maxArtifacts ?? 12;
  const maxCharacters = input.maxSummaryCharacters ?? 15000;
  if (!Number.isSafeInteger(maxArtifacts) || maxArtifacts < 1 || maxArtifacts > 20)
    throw new Error("maxArtifacts must be an integer from 1 through 20");
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1000 || maxCharacters > 15000)
    throw new Error("maxSummaryCharacters must be an integer from 1000 through 15000");
  const listing = await tools.read_github_pages({
    workdir: input.workdir,
    repository: repo,
    path: "actions/runs/" + input.runId + "/artifacts",
    pageSize: 100,
    pageLimit: 5,
    arrayField: "artifacts",
  });
  const all = listing.items.filter(
    (item) => typeof item.name === "string" && item.name.startsWith("pr-review-specialist-"),
  );
  const listingTruncated = listing.truncated;
  const selected = all.slice(0, maxArtifacts);
  const quote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
  const summaries = [];
  const failures = [];
  for (const raw of selected) {
    const artifactId = Number(raw.id ?? 0);
    const artifactName = String(raw.name ?? "").slice(0, 300);
    if (!Number.isSafeInteger(artifactId) || artifactId < 1 || raw.expired) {
      failures.push({
        artifactId: Number.isSafeInteger(artifactId) ? artifactId : 0,
        artifactName,
        detail: raw.expired ? "artifact expired" : "invalid artifact identity",
      });
      continue;
    }
    if (
      typeof raw.size_in_bytes !== "number" ||
      !Number.isSafeInteger(raw.size_in_bytes) ||
      raw.size_in_bytes < 0 ||
      raw.size_in_bytes > 5000000
    ) {
      failures.push({
        artifactId,
        artifactName,
        detail: "compressed artifact exceeds the 5,000,000-byte bound or has invalid size metadata",
      });
      continue;
    }
    const command = `set -euo pipefail
umask 077
tmp=\$(mktemp -d "\${TMPDIR:-/tmp}/advisor-summary.XXXXXX")
trap 'rm -rf "\$tmp"' EXIT
zip="\$tmp/artifact.zip"
set +e
gh api ${quote(`repos/${repo}/actions/artifacts/${artifactId}/zip`)} | head -c 5000001 > "\$zip"
statuses=("\${PIPESTATUS[@]}")
producer=\${statuses[0]}
consumer=\${statuses[1]}
set -e
[ "\$consumer" -eq 0 ] && { [ "\$producer" -eq 0 ] || [ "\$producer" -eq 141 ]; } || exit 19
bytes=\$(stat -c %s "\$zip")
[ "\$bytes" -le 5000000 ] || { echo 'compressed artifact exceeds bound' >&2; exit 20; }
test_summary=\$(LC_ALL=C zipinfo -t "\$zip" 2>/dev/null) || { echo 'artifact ZIP is malformed' >&2; exit 21; }
[[ "\$test_summary" != *$'\n'* && "\$test_summary" =~ ^([0-9]+)[[:space:]]files?,[[:space:]]([0-9]+)[[:space:]]bytes[[:space:]]uncompressed, ]] || { echo 'artifact ZIP summary is ambiguous' >&2; exit 21; }
[ "\${BASH_REMATCH[1]}" -le 100 ] || { echo 'artifact inventory exceeds 100 entries' >&2; exit 21; }
[ "\${BASH_REMATCH[2]}" -le 20000000 ] || { echo 'expanded artifact exceeds 20,000,000 bytes' >&2; exit 21; }
LC_ALL=C zipinfo -l "\$zip" > "\$tmp/listing" 2>/dev/null || exit 21
LC_ALL=C zipinfo -1 "\$zip" > "\$tmp/names" 2>/dev/null || exit 21
[ "\$(wc -c < "\$tmp/listing")" -le 1000000 ] || { echo 'artifact listing exceeds bound' >&2; exit 21; }
awk -v declared_count="\${BASH_REMATCH[1]}" 'NR==FNR { exact[FNR]=$0; names=FNR; next } BEGIN { count=0; state="ok" } FNR <= 2 { next } /^[bcdlps-][rwxStTs-]{9}[[:space:]]/ { count++; mode=substr($0,1,1); size=$4; line=$0; for (i=1;i<=9;i++) sub(/^[^[:space:]]+[[:space:]]+/, "", line); name=exact[count]; if (line != name || (mode != "-" && mode != "d") || size !~ /^[0-9]+$/) state="unsafe"; parts=split(name, component, "/"); if (name == "" || substr(name,1,1) == "-" || substr(name,1,1) == "/" || index(name,sprintf("%c",92)) || name ~ /[[:cntrl:]]/ || index(name,"*") || index(name,"?") || index(name,"[") || seen[name]++) state="unsafe"; for (part=1; part<=parts; part++) if (component[part] == "..") state="unsafe"; if (mode == "-" && name ~ /summary[.]md$/) { selected++; selected_size=size; selected_name=name } } END { if (state != "ok" || count != names || count != declared_count) exit 2; if (selected != 1) exit 3; printf "%s\t%s", selected_size, selected_name }' "\$tmp/names" "\$tmp/listing" > "\$tmp/selected" || { echo 'artifact entries are unsafe, ambiguous, or missing one summary' >&2; exit 22; }
IFS=\$'\t' read -r declared summary < "\$tmp/selected" || [ -n "\$summary" ]
[ -n "\$summary" ] && [[ "\$declared" =~ ^[0-9]+$ ]] || { echo 'artifact summary metadata is invalid' >&2; exit 24; }
[ "\$declared" -le 20000000 ] || { echo 'summary entry exceeds expanded-size bound' >&2; exit 24; }
set +e
unzip -p "\$zip" "\$summary" | head -c ${maxCharacters * 4 + 1} > "\$tmp/summary"
statuses=("\${PIPESTATUS[@]}")
producer=\${statuses[0]}
consumer=\${statuses[1]}
set -e
[ "\$consumer" -eq 0 ] && { [ "\$producer" -eq 0 ] || [ "\$producer" -eq 141 ]; } || exit 25
actual=\$(stat -c %s "\$tmp/summary")
expected=\$declared
bound=${maxCharacters * 4 + 1}
[ "\$expected" -le "\$bound" ] || expected=\$bound
[ "\$actual" -eq "\$expected" ] || { echo 'summary size differs from archive metadata' >&2; exit 25; }
printf '%s\n' "\$summary"
[ "\$(stat -c %s \"\$tmp/summary\")" -gt ${maxCharacters * 4} ] && printf '1\n' || printf '0\n'
base64 -w 0 "\$tmp/summary"`;
    const result = await tools.bash({
      command,
      workdir: input.workdir,
      description: "Read bounded advisor artifact summary",
      timeoutMs: 60000,
    });
    if (result.kind !== "foreground") throw new Error("Unexpected background result");
    if (result.exitCode !== 0) {
      const projected = await tools.project_diagnostic_text({
        lines: [result.stderr.text],
        maxLines: 5,
        maxCharacters: 1000,
        maxLineCharacters: 500,
      });
      failures.push({
        artifactId,
        artifactName,
        detail: projected.text || "artifact summary read failed",
      });
      continue;
    }
    if (result.stdout.truncated) {
      failures.push({
        artifactId,
        artifactName,
        detail: "artifact summary response exceeded the transport bound",
      });
      continue;
    }
    const newline = result.stdout.text.indexOf("\n");
    if (newline < 0) {
      failures.push({
        artifactId,
        artifactName,
        detail: "artifact summary response was malformed",
      });
      continue;
    }
    const entry = result.stdout.text.slice(0, newline).slice(0, 1000);
    const clippedNewline = result.stdout.text.indexOf("\n", newline + 1);
    if (clippedNewline < 0) {
      failures.push({
        artifactId,
        artifactName,
        detail: "artifact summary response was malformed",
      });
      continue;
    }
    const byteClipped = result.stdout.text.slice(newline + 1, clippedNewline) === "1";
    let decoded = "";
    try {
      const encoded = result.stdout.text.slice(clippedNewline + 1).trim();
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
        throw new Error("invalid base64");
      decoded = Buffer.from(encoded, "base64").toString("utf8");
    } catch {
      failures.push({ artifactId, artifactName, detail: "artifact summary was not valid base64" });
      continue;
    }
    const clipped = byteClipped || decoded.length > maxCharacters;
    const text = clipped ? decoded.slice(0, maxCharacters) : decoded;
    const projected = await tools.project_diagnostic_text({
      lines: text.split("\n"),
      clipMode: "head",
      maxLines: 500,
      maxCharacters,
      maxLineCharacters: 4000,
      sourceTruncated: clipped,
    });
    summaries.push({
      artifactId,
      artifactName,
      entry,
      text: projected.text,
      truncated: projected.truncated,
    });
  }
  return {
    repo,
    runId: input.runId,
    artifactsFound: all.length,
    summariesRead: summaries.length,
    truncated:
      listingTruncated || all.length > selected.length || summaries.some((item) => item.truncated),
    summaries,
    failures,
  };
}
