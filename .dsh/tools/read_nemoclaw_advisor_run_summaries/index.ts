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
  const selected = all.slice(0, maxArtifacts);
  const artifacts = selected.map((raw) => ({
    artifactId: Number(raw.id ?? 0),
    artifactName: String(raw.name ?? "").slice(0, 300),
    expired: Boolean(raw.expired),
    size: raw.size_in_bytes,
  }));
  const failures = [];
  const eligible = [];
  let cumulativeCompressedBytes = 0;
  for (const [index, artifact] of artifacts.entries()) {
    if (!Number.isSafeInteger(artifact.artifactId) || artifact.artifactId < 1 || artifact.expired) {
      failures.push({
        index,
        artifactId: Number.isSafeInteger(artifact.artifactId) ? artifact.artifactId : 0,
        artifactName: artifact.artifactName,
        detail: artifact.expired ? "artifact expired" : "invalid artifact identity",
      });
      continue;
    }
    if (
      typeof artifact.size !== "number" ||
      !Number.isSafeInteger(artifact.size) ||
      artifact.size < 0 ||
      artifact.size > 5000000
    ) {
      failures.push({
        index,
        artifactId: artifact.artifactId,
        artifactName: artifact.artifactName,
        detail: "compressed artifact exceeds the 5,000,000-byte bound or has invalid size metadata",
      });
      continue;
    }
    if (cumulativeCompressedBytes + artifact.size > 50000000) {
      failures.push({
        index,
        artifactId: artifact.artifactId,
        artifactName: artifact.artifactName,
        detail: "cumulative compressed artifact metadata exceeds the 50,000,000-byte bound",
      });
      continue;
    }
    cumulativeCompressedBytes += artifact.size;
    eligible.push({ index, artifactId: artifact.artifactId });
  }
  const specifications = eligible.map((item) => item.index + ":" + item.artifactId).join(" ");
  const command = `set -euo pipefail
umask 077
tmp=\$(mktemp -d "\${TMPDIR:-/tmp}/advisor-summaries.XXXXXX")
trap 'rm -rf "\$tmp"' EXIT
process_artifact() {
  local index=\$1 artifact_id=\$2 dir zip test_summary declared summary actual expected bound
  dir="\$tmp/\$index"
  mkdir "\$dir"
  zip="\$dir/artifact.zip"
  set +e
  gh api "repos/${repo}/actions/artifacts/\$artifact_id/zip" | head -c 5000001 > "\$zip"
  local statuses=("\${PIPESTATUS[@]}")
  set -e
  [ "\${statuses[1]}" -eq 0 ] && { [ "\${statuses[0]}" -eq 0 ] || [ "\${statuses[0]}" -eq 141 ]; } || return 19
  [ "\$(stat -c %s "\$zip")" -le 5000000 ] || { echo 'compressed artifact exceeds bound' >&2; return 20; }
  test_summary=\$(LC_ALL=C zipinfo -t "\$zip" 2>/dev/null) || { echo 'artifact ZIP is malformed' >&2; return 21; }
  [[ "\$test_summary" != *$'\n'* && "\$test_summary" =~ ^([0-9]+)[[:space:]]files?,[[:space:]]([0-9]+)[[:space:]]bytes[[:space:]]uncompressed, ]] || { echo 'artifact ZIP summary is ambiguous' >&2; return 21; }
  [ "\${BASH_REMATCH[1]}" -le 100 ] || { echo 'artifact inventory exceeds 100 entries' >&2; return 21; }
  [ "\${BASH_REMATCH[2]}" -le 20000000 ] || { echo 'expanded artifact exceeds 20,000,000 bytes' >&2; return 21; }
  LC_ALL=C zipinfo -l "\$zip" > "\$dir/listing" 2>/dev/null || return 21
  LC_ALL=C zipinfo -1 "\$zip" > "\$dir/names" 2>/dev/null || return 21
  [ "\$(wc -c < "\$dir/listing")" -le 1000000 ] || { echo 'artifact listing exceeds bound' >&2; return 21; }
  awk -v declared_count="\${BASH_REMATCH[1]}" 'NR==FNR { exact[FNR]=$0; names=FNR; next } BEGIN { count=0; state="ok" } FNR <= 2 { next } /^[bcdlps-][rwxStTs-]{9}[[:space:]]/ { count++; mode=substr($0,1,1); size=$4; line=$0; for (i=1;i<=9;i++) sub(/^[^[:space:]]+[[:space:]]+/, "", line); name=exact[count]; if (line != name || (mode != "-" && mode != "d") || size !~ /^[0-9]+$/) state="unsafe"; parts=split(name, component, "/"); if (name == "" || substr(name,1,1) == "-" || substr(name,1,1) == "/" || index(name,sprintf("%c",92)) || name ~ /[[:cntrl:]]/ || index(name,"*") || index(name,"?") || index(name,"[") || seen[name]++) state="unsafe"; for (part=1; part<=parts; part++) if (component[part] == "..") state="unsafe"; if (mode == "-" && name ~ /summary[.]md$/) { selected++; selected_size=size; selected_name=name } } END { if (state != "ok" || count != names || count != declared_count) exit 2; if (selected != 1) exit 3; printf "%s\t%s", selected_size, selected_name }' "\$dir/names" "\$dir/listing" > "\$dir/selected" || { echo 'artifact entries are unsafe, ambiguous, or missing one summary' >&2; return 22; }
  IFS=\$'\t' read -r declared summary < "\$dir/selected" || [ -n "\$summary" ]
  [ -n "\$summary" ] && [[ "\$declared" =~ ^[0-9]+$ ]] || { echo 'artifact summary metadata is invalid' >&2; return 24; }
  [ "\$declared" -le 20000000 ] || { echo 'summary entry exceeds expanded-size bound' >&2; return 24; }
  set +e
  unzip -p "\$zip" "\$summary" | head -c ${maxCharacters * 4 + 1} > "\$dir/summary"
  statuses=("\${PIPESTATUS[@]}")
  set -e
  [ "\${statuses[1]}" -eq 0 ] && { [ "\${statuses[0]}" -eq 0 ] || [ "\${statuses[0]}" -eq 141 ]; } || return 25
  actual=\$(stat -c %s "\$dir/summary")
  expected=\$declared
  bound=${maxCharacters * 4 + 1}
  [ "\$expected" -le "\$bound" ] || expected=\$bound
  [ "\$actual" -eq "\$expected" ] || { echo 'summary size differs from archive metadata' >&2; return 25; }
  printf '%.1000s\t' "\$summary"
  [ "\$actual" -gt ${maxCharacters * 4} ] && printf '1\t' || printf '0\t'
  base64 -w 0 "\$dir/summary"
}
run_artifact() {
  local specification=\$1 index=\${1%%:*} artifact_id=\${1#*:}
  ( if process_artifact "\$index" "\$artifact_id" > "\$tmp/\$index.out" 2> "\$tmp/\$index.err"; then status=0; else status=\$?; fi; printf '%s\n' "\$status" > "\$tmp/\$index.status" ) &
}
running=0
for specification in ${specifications}; do
  run_artifact "\$specification"
  running=\$((running + 1))
  if [ "\$running" -eq 4 ]; then
    wait -n
    running=\$((running - 1))
  fi
done
while [ "\$running" -gt 0 ]; do
  wait -n
  running=\$((running - 1))
done
for specification in ${specifications}; do
  index=\${specification%%:*}
  if IFS= read -r status < "\$tmp/\$index.status" 2>/dev/null && [[ "\$status" =~ ^[0-9]{1,3}$ ]]; then
    if [ "\$status" -eq 0 ]; then
      printf '0\t%s\t' "\$index"
      cat "\$tmp/\$index.out"
    else
      printf '%s\t%s\t' "\$status" "\$index"
      head -c 2000 "\$tmp/\$index.err" | base64 -w 0
    fi
  else
    printf '99\t%s\t' "\$index"
    printf 'artifact worker status was missing or malformed' | base64 -w 0
  fi
  printf '\n'
done`;
  const batch =
    eligible.length === 0
      ? null
      : await tools.bash({
          command,
          workdir: input.workdir,
          description: "Read bounded advisor artifact summaries",
          timeoutMs: Math.min(300000, 60000 * Math.ceil(eligible.length / 4)),
        });
  const batchRecords = new Map();
  let batchFailureDetail = "artifact summary batch processing failed";
  if (batch?.kind === "foreground" && batch.exitCode !== 0) {
    const projected = await tools.project_diagnostic_text({
      lines: [batch.stderr.text],
      maxLines: 5,
      maxCharacters: 1000,
      maxLineCharacters: 500,
    });
    batchFailureDetail = projected.text || batchFailureDetail;
  }
  if (batch?.kind === "foreground") {
    let completeOutput = batch.stdout.text;
    if (batch.stdout.truncated) {
      const firstNewline = completeOutput.indexOf("\n");
      completeOutput = firstNewline < 0 ? "" : completeOutput.slice(firstNewline + 1);
    }
    const lastNewline = completeOutput.lastIndexOf("\n");
    completeOutput = lastNewline < 0 ? "" : completeOutput.slice(0, lastNewline);
    for (const line of completeOutput.split("\n")) {
      if (!line) continue;
      const fields = line.split("\t");
      const index = Number(fields[1]);
      if (
        (fields.length === 3 || fields.length === 5) &&
        Number.isSafeInteger(index) &&
        eligible.some((item) => item.index === index)
      )
        batchRecords.set(index, fields);
    }
  }
  const summaries = [];
  for (const { index } of eligible) {
    const artifact = artifacts[index];
    const fields = batchRecords.get(index);
    if (!fields) {
      failures.push({
        index,
        artifactId: artifact.artifactId,
        artifactName: artifact.artifactName,
        detail:
          batch?.kind === "foreground" && batch.stdout.truncated
            ? "artifact summary response exceeded the transport bound"
            : batchFailureDetail,
      });
      continue;
    }
    if (fields[0] !== "0") {
      let detail = "";
      try {
        if (
          fields.length !== 3 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(fields[2])
        )
          throw new Error("invalid failure record");
        detail = Buffer.from(fields[2], "base64").toString("utf8");
      } catch {
        detail = "artifact summary response was malformed";
      }
      const projected = await tools.project_diagnostic_text({
        lines: [detail],
        maxLines: 5,
        maxCharacters: 1000,
        maxLineCharacters: 500,
      });
      failures.push({
        index,
        artifactId: artifact.artifactId,
        artifactName: artifact.artifactName,
        detail: projected.text || "artifact summary read failed",
      });
      continue;
    }
    if (fields.length !== 5 || (fields[3] !== "0" && fields[3] !== "1")) {
      failures.push({
        index,
        artifactId: artifact.artifactId,
        artifactName: artifact.artifactName,
        detail: "artifact summary response was malformed",
      });
      continue;
    }
    let decoded = "";
    try {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(fields[4]))
        throw new Error("invalid base64");
      decoded = Buffer.from(fields[4], "base64").toString("utf8");
    } catch {
      failures.push({
        index,
        artifactId: artifact.artifactId,
        artifactName: artifact.artifactName,
        detail: "artifact summary was not valid base64",
      });
      continue;
    }
    const clipped = fields[3] === "1" || decoded.length > maxCharacters;
    const projected = await tools.project_diagnostic_text({
      lines: (clipped ? decoded.slice(0, maxCharacters) : decoded).split("\n"),
      clipMode: "head",
      maxLines: 500,
      maxCharacters,
      maxLineCharacters: 4000,
      sourceTruncated: clipped,
    });
    summaries.push({
      artifactId: artifact.artifactId,
      artifactName: artifact.artifactName,
      entry: fields[2].slice(0, 1000),
      text: projected.text,
      truncated: projected.truncated,
      index,
    });
  }
  summaries.sort((left, right) => left.index - right.index);
  failures.sort((left, right) => left.index - right.index);
  return {
    repo,
    runId: input.runId,
    artifactsFound: all.length,
    summariesRead: summaries.length,
    truncated:
      listing.truncated || all.length > selected.length || summaries.some((item) => item.truncated),
    summaries: summaries.map(({ index: _index, ...summary }) => summary),
    failures: failures.map(({ index: _index, ...failure }) => failure),
  };
}
