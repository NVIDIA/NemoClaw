/**
 * Summarize explicit NemoClaw issues and pull requests with bounded body and comment excerpts.
 */
export default async function summarize_nemoclaw_planning_items(input: {
  workdir: string;
  issues?: Integer[];
  prs?: Integer[];
  repo?: string;
  relevantPattern?: string;
  maxBodyMatches?: Integer;
  maxComments?: Integer;
  commentMarker?: string;
}): Promise<{
  repo: string;
  count: Integer;
  relevantPattern: string;
  limits: { maxBodyMatches: Integer; maxComments: Integer };
  items: {
    number: Integer;
    title: string;
    state: string;
    url: string;
    kind: "issue" | "pr";
    headRefOid: string | null;
    headRefName: string | null;
    baseRefName: string | null;
    isDraft: boolean | null;
    relevantBodyLines: { line: Integer; text: string }[];
    recentComments: {
      author: string | null;
      createdAt: string;
      hasMarker: boolean;
      preview: string;
    }[];
  }[];
}> {
  const repo = input.repo ?? "NVIDIA/NemoClaw";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("repo must be owner/name");
  const issues = [...new Set(input.issues ?? [])],
    prs = [...new Set(input.prs ?? [])],
    numbers = [...issues, ...prs];
  if (
    numbers.length < 1 ||
    numbers.length > 10 ||
    numbers.some((n) => !Number.isSafeInteger(n) || n <= 0)
  )
    throw new Error("Provide 1 to 10 positive issue and pull request numbers");
  const pattern =
    input.relevantPattern ??
    "^(#{1,4} )|dependency|depends|sequence|scope|acceptance|blocked|owner|state|agent|runtime|onboard|lifecycle|manifest|file|layout|PR |#[0-9]+";
  if (typeof pattern !== "string") throw new Error("relevantPattern must be a string");
  if (pattern.length < 1 || pattern.length > 500)
    throw new Error("relevantPattern must contain 1 to 500 characters");
  if (/\)[+*{]/u.test(pattern)) throw new Error("relevantPattern must not quantify groups");
  let regex;
  try {
    regex = new RegExp(pattern, "i");
  } catch {
    throw new Error("relevantPattern must be a valid regular expression");
  }
  const maxBodyMatches = Math.max(1, Math.min(30, input.maxBodyMatches ?? 20)),
    maxComments = Math.max(0, Math.min(5, input.maxComments ?? 3)),
    marker = input.commentMarker ?? "";
  if (typeof marker !== "string") throw new Error("commentMarker must be a string");
  if (marker.length > 200) throw new Error("commentMarker must contain at most 200 characters");
  const view = async (kind, number) => {
    const fields =
      kind === "pr"
        ? "number,title,state,url,headRefOid,headRefName,baseRefName,isDraft,body,comments"
        : "number,title,state,url,body,comments";
    const result = await tools.run_github_cli({
      workdir: input.workdir,
      args: [kind, "view", String(number), "--repo", repo, "--json", fields],
      timeoutMs: 60000,
    });
    const x = JSON.parse(result.stdout);
    const bodyMatches = String(x.body ?? "")
      .split(/\r?\n/)
      .map((text, i) => ({ line: i + 1, text: text.slice(0, 240) }))
      .filter((v) => regex.test(v.text))
      .slice(0, maxBodyMatches);
    const relevantBodyLines = await Promise.all(
      bodyMatches.map(async (match) => ({
        line: match.line,
        text: (
          await tools.project_diagnostic_text({
            lines: [match.text],
            clipMode: "head",
            maxLines: 1,
            maxCharacters: 240,
            maxLineCharacters: 240,
          })
        ).text,
      })),
    );
    const recentComments = await Promise.all(
      (maxComments === 0 ? [] : (x.comments ?? []).slice(-maxComments)).map(async (c) => ({
        author: c.author?.login ?? null,
        createdAt: c.createdAt ?? "",
        hasMarker: marker !== "" && String(c.body ?? "").includes(marker),
        preview: (
          await tools.project_diagnostic_text({
            lines: [String(c.body ?? "")],
            clipMode: "head",
            maxLines: 1,
            maxCharacters: 240,
            maxLineCharacters: 240,
          })
        ).text,
      })),
    );
    return {
      number: x.number,
      title: x.title ?? "",
      state: x.state ?? "",
      url: x.url ?? "",
      kind,
      headRefOid: x.headRefOid ?? null,
      headRefName: x.headRefName ?? null,
      baseRefName: x.baseRefName ?? null,
      isDraft: typeof x.isDraft === "boolean" ? x.isDraft : null,
      relevantBodyLines,
      recentComments,
    };
  };
  const items = await Promise.all([
    ...issues.map((n) => view("issue", n)),
    ...prs.map((n) => view("pr", n)),
  ]);
  return {
    repo,
    count: items.length,
    relevantPattern: pattern,
    limits: { maxBodyMatches, maxComments },
    items,
  };
}
