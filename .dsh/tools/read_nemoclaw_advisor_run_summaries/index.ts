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
  const all = [];
  let listingTruncated = false;
  for (let page = 1; page <= 5; page += 1) {
    const listed = await tools.run_github_cli({
      workdir: input.workdir,
      args: [
        "api",
        `repos/${repo}/actions/runs/${input.runId}/artifacts?per_page=100&page=${page}`,
        "--jq",
        '{total_count,artifacts:[.artifacts[]|select(.name|startswith("pr-review-specialist-"))|{id,name,expired,size:.size_in_bytes}]}',
      ],
      timeoutMs: 60000,
    });
    let payload;
    try {
      payload = JSON.parse(listed.stdout);
    } catch {
      throw new Error("Could not parse advisor artifact listing");
    }
    if (!Array.isArray(payload.artifacts) || !Number.isSafeInteger(payload.total_count))
      throw new Error("Advisor artifact listing has invalid fields");
    all.push(...payload.artifacts);
    if (page * 100 >= payload.total_count) break;
    if (page === 5) listingTruncated = true;
  }
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
      typeof raw.size !== "number" ||
      !Number.isSafeInteger(raw.size) ||
      raw.size < 0 ||
      raw.size > 5000000
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
mapfile -t entries < <(zipinfo -1 "\$zip")
[ "\${#entries[@]}" -le 100 ] || { echo 'artifact inventory exceeds 100 entries' >&2; exit 21; }
summary=''
for entry in "\${entries[@]}"; do
  case "\$entry" in
    /*|../*|*/../*|*'/..') echo 'unsafe artifact entry' >&2; exit 22 ;;
    *summary.md)
      [ -z "\$summary" ] || { echo 'artifact contains multiple summary files' >&2; exit 23; }
      summary="\$entry"
      ;;
  esac
done
[ -n "\$summary" ] || { echo 'artifact has no summary Markdown file' >&2; exit 24; }
set +e
unzip -p "\$zip" "\$summary" | head -c ${maxCharacters * 4 + 1} > "\$tmp/summary"
statuses=("\${PIPESTATUS[@]}")
producer=\${statuses[0]}
consumer=\${statuses[1]}
set -e
[ "\$consumer" -eq 0 ] && { [ "\$producer" -eq 0 ] || [ "\$producer" -eq 141 ]; } || exit 25
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
