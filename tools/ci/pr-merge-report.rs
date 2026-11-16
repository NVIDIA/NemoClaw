// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Preview a merged PR's GitHub-only outcomes; --post publishes one bot comment.
//! Compile with rustc --edition=2024 tools/ci/pr-merge-report.rs.

use std::{
    collections::{BTreeMap, BTreeSet},
    fmt::Write,
    process::Command,
};

const MARKER: &str = "<!-- nemoclaw-merge-report:v1 -->";
const QUEUED_PREFIX: &str = "<!-- nemoclaw-merge-queued:v1 ";
const INTEGRITY_ERROR: &str = "Existing merge report did not match the expected single report; stop and investigate, do not retry";

#[derive(Default)]
struct Report {
    additions: u64,
    deletions: u64,
    files: u64,
    checks: Vec<Check>,
    reviews: Vec<Review>,
    repo: String,
    number: u64,
    head: String,
    revisions: BTreeMap<String, i64>,
    commit_order: BTreeMap<String, usize>,
    unavailable: BTreeSet<String>,
}

#[derive(Default)]
struct Check {
    id: u64,
    name: String,
    sha: String,
    key: String,
    observed: i64,
    completed: i64,
    conclusion: String,
    started: i64,
    source: CheckSource,
}

#[derive(Default, Clone, Copy)]
enum CheckSource {
    Actions(u64),
    #[default]
    App,
    Status,
}

impl CheckSource {
    fn link(self, repo: &str, number: u64, sha: &str, id: u64) -> String {
        match self {
            Self::Actions(run) => format!("https://github.com/{repo}/actions/runs/{run}/job/{id}"),
            Self::Status => format!("https://github.com/{repo}/commit/{sha}"),
            Self::App => {
                format!("https://github.com/{repo}/pull/{number}/checks?check_run_id={id}")
            }
        }
    }
}

#[derive(Default)]
struct Review {
    id: u64,
    sha: String,
    submitted: i64,
    state: String,
}

fn render(report: &Report) -> String {
    let mut seen: BTreeMap<&str, i64> = report
        .revisions
        .iter()
        .map(|(s, t)| (s.as_str(), *t))
        .collect();
    for check in report.checks.iter().filter(|c| c.observed >= 0) {
        seen.entry(&check.sha)
            .and_modify(|t| *t = (*t).min(check.observed))
            .or_insert(check.observed);
    }
    let mut revisions: Vec<_> = seen.into_iter().collect();
    revisions.sort_by_key(|(sha, time)| (*time, *sha));
    let repairs = revisions
        .windows(2)
        .filter(|pair| {
            if !report.precedes(pair[0].0, pair[1].0) {
                return false;
            }
            let mut latest = BTreeMap::new();
            for check in report
                .checks
                .iter()
                .filter(|c| c.sha == pair[0].0 && c.completed >= 0 && c.completed < pair[1].1)
            {
                let previous: &mut &Check = latest.entry(&check.key).or_insert(check);
                if (check.completed, check.id) > (previous.completed, previous.id) {
                    *previous = check;
                }
            }
            latest.values().any(|c| {
                matches!(
                    c.conclusion.as_str(),
                    "failure" | "timed_out" | "action_required" | "startup_failure"
                )
            })
        })
        .count();
    let requests: Vec<_> = report
        .reviews
        .iter()
        .filter(|r| r.state == "CHANGES_REQUESTED")
        .collect();
    let followups: BTreeSet<_> = requests
        .iter()
        .filter_map(|review| {
            revisions
                .iter()
                .find(|(sha, time)| report.precedes(&review.sha, sha) && *time > review.submitted)
                .map(|(sha, _)| *sha)
        })
        .collect();
    let queued: BTreeSet<_> = report
        .checks
        .iter()
        .filter(|check| check.started < 0 && !matches!(check.source, CheckSource::Status))
        .map(|check| format!("{}:{}", check.sha, check.id))
        .collect();
    let queued = if queued.is_empty() {
        "-".into()
    } else {
        queued.into_iter().collect::<Vec<_>>().join(",")
    };
    let snapshot = format!(
        "{QUEUED_PREFIX}{} {} {} {queued} -->",
        report.repo, report.number, report.head
    );
    let mut text = format!(
        "<details>\n<summary>Merge outcomes</summary>\n\n{MARKER}\n\n{snapshot}\n\nGitHub data for #{} at merge, head `{}`.\n\n| Measure | Result |\n| --- | --- |\n| Repair rounds | {repairs} (observed revisions after failed checks) |\n| Review rounds | {} changes-requested reviews; {} observed follow-up revisions |\n| Diff size | +{} / -{} lines across {} files |\n\n",
        report.number,
        report.head,
        requests.len(),
        followups.len(),
        report.additions,
        report.deletions,
        report.files
    );
    text.push_str("A revision is a distinct checked head SHA. Round counts require a forward step in the retained PR commit order. Repair rounds count a later commit when the preceding observed revision's latest completed check still failed before that commit was first observed. Retries on the same or older SHAs do not increase round counts. Review follow-ups count the first later commit observed after each changes-requested review, once per revision. Missing review attribution or commit order cannot establish a follow-up.\n\n");
    text.push_str("Limits: these are observed revision counts, not a complete push history. GitHub does not supply push timestamps here. Intermediate pushes without checks, removed history, deleted checks, and the original state of dismissed reviews may be missing. Workflow-run and check-suite creation times bound observation, not individual check creation. This report does not decide whether required checks were green or whether a push fixed a failure.\n\n");
    if !report.unavailable.is_empty() {
        let revisions: Vec<_> = report
            .unavailable
            .iter()
            .map(|sha| format!("`{sha}`"))
            .collect();
        writeln!(
            text,
            "Historical check or status data unavailable for: {}.\n",
            revisions.join(", ")
        )
        .unwrap();
    }
    text.push_str("| Revision | Check | Result | Seconds |\n| --- | --- | --- | --- |\n");
    let mut checks: Vec<_> = report.checks.iter().collect();
    checks.sort_by_key(|c| (c.observed, &c.sha, c.started, c.id));
    for check in checks {
        let round = revisions
            .iter()
            .position(|(sha, _)| *sha == check.sha)
            .map_or("unavailable".into(), |i| (i + 1).to_string());
        let duration = if check.conclusion == "skipped"
            || check.started < 0
            || check.completed < check.started
        {
            "unavailable".into()
        } else {
            (check.completed - check.started).to_string()
        };
        let link = check
            .source
            .link(&report.repo, report.number, &check.sha, check.id);
        writeln!(
            text,
            "| {round} (`{}`) | [{}]({link}) | {} | {duration} |",
            short_sha(&check.sha),
            cell(&check.name),
            cell(&check.conclusion)
        )
        .unwrap();
    }
    if report.checks.is_empty() {
        text.push_str("| - | No retained checks | unavailable | unavailable |\n");
    }
    text.push_str("\nTimes are completed minus started, excluding queue time. Retries retain separate rows. Missing, skipped, reversed timestamps, and checks unfinished at merge have unavailable durations.\n\n");
    for review in requests {
        writeln!(
            text,
            "Changes requested: https://github.com/{}/pull/{}#pullrequestreview-{}\n",
            report.repo, report.number, review.id
        )
        .unwrap();
    }
    text.push_str("</details>\n");
    text
}

fn short_sha(sha: &str) -> &str {
    &sha[..sha.len().min(12)]
}

fn cell(value: &str) -> String {
    let mut escaped = String::new();
    for c in value.chars() {
        if c.is_control() {
            escaped.push(' ');
        } else if "&<>|[]()\\`*_~!@".contains(c) {
            write!(escaped, "&#{};", u32::from(c)).unwrap();
        } else {
            escaped.push(c);
        }
    }
    escaped
}

type Result<T> = std::result::Result<T, String>;

// gh applies these jq expressions to each API page. TSV escapes control characters,
// so an untrusted check name cannot create additional records or fields.
const PR_QUERY: &str = r#"[.merged,.base.ref,.head.sha,.head.ref,.created_at,.merged_at,(.merged_at | if . == null then -1 else fromdateiso8601 end),.additions,.deletions,.changed_files,(.created_at|fromdateiso8601),(.head.repo.id // 0)] | @tsv"#;
const RUN_QUERY: &str = r#"[.id,.head_sha,(.created_at|fromdateiso8601),.workflow_id,(.head_branch // ""),([(.pull_requests // [])[].number]|join(",")),(.head_repository.id // 0)] | @tsv"#;
const CHECK_QUERY: &str = r#"def stamp: if . == null then -1 else fromdateiso8601 end; .check_runs[] | [.id,.name,.app.id,.app.slug,(.started_at|stamp),(.completed_at|stamp),(.conclusion // "unfinished"),(.details_url // ""),(.check_suite.id // 0)] | @tsv"#;
const REVIEW_QUERY: &str = r#".[] | select(.submitted_at != null) | [.id,.state,.commit_id,(.submitted_at|fromdateiso8601)] | @tsv"#;

struct Api {
    repo: String,
    number: u64,
}

impl Api {
    fn read(&self, path: &str, query: &str) -> Result<std::process::Output> {
        self.read_pages(path, query, true)
    }

    fn read_pages(&self, path: &str, query: &str, paginate: bool) -> Result<std::process::Output> {
        Command::new("gh")
            .arg("api")
            .args(if paginate { &["--paginate"][..] } else { &[] })
            .args([&format!("repos/{}/{path}", self.repo), "--jq", query])
            .output()
            .map_err(|e| format!("Cannot run gh: {e}"))
    }

    fn rows(&self, path: &str, query: &str) -> Result<Vec<Vec<String>>> {
        Self::parse_rows(path, self.read(path, query)?)
    }

    fn revision_rows(
        &self,
        sha: &str,
        head: &str,
        endpoint: &str,
        query: &str,
    ) -> Result<Option<Vec<Vec<String>>>> {
        let path = format!("commits/{sha}/{endpoint}");
        let output = self.read(&path, query)?;
        let missing = format!("gh: No commit found for SHA: {sha} (HTTP 422)");
        let error = String::from_utf8_lossy(&output.stderr);
        if sha != head
            && !output.status.success()
            && (error.trim() == "gh: Not Found (HTTP 404)" || error.trim() == missing)
        {
            // A checks 404 can mean denied access. Only the commit endpoint's
            // specific missing-SHA response confirms an unavailable revision.
            let commit_path = format!("commits/{sha}");
            let commit = self.read(&commit_path, ".sha")?;
            if !commit.status.success() && String::from_utf8_lossy(&commit.stderr).trim() == missing
            {
                return Ok(None);
            }
            Self::parse_rows(&commit_path, commit)?;
        }
        Self::parse_rows(&path, output).map(Some)
    }

    fn parse_rows(path: &str, output: std::process::Output) -> Result<Vec<Vec<String>>> {
        if !output.status.success() {
            return Err(format!(
                "GitHub read failed for {path}: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        let text =
            String::from_utf8(output.stdout).map_err(|e| format!("Invalid API text: {e}"))?;
        text.lines()
            .map(|line| line.split('\t').map(unescape_tsv).collect())
            .collect()
    }

    fn workflow_runs(&self, branch: &str, opened: i64, merged: i64) -> Result<Vec<Vec<String>>> {
        let query = format!(r#"(["total",.total_count] | @tsv), (.workflow_runs[] | {RUN_QUERY})"#);
        let mut windows = vec![(opened, merged)];
        let mut runs = Vec::new();
        while let Some((start, end)) = windows.pop() {
            let range = Command::new("jq")
                .args([
                    "-nr",
                    &format!("[{start},{end}] | map(todateiso8601) | join(\"..\")"),
                ])
                .output()
                .map_err(|e| format!("Cannot format Actions search window: {e}"))?;
            if !range.status.success() {
                return Err("Invalid Actions search window".into());
            }
            let range = String::from_utf8(range.stdout)
                .map_err(|e| format!("Invalid search window: {e}"))?;
            let path = format!(
                "actions/runs?branch={}&created={}&per_page=100",
                encode(branch),
                encode(range.trim())
            );
            // Inspect one page before pagination: GitHub rejects pages beyond
            // the 1,000-result cap, so saturated windows must first be split.
            let first = Self::parse_rows(&path, self.read_pages(&path, &query, false)?)?;
            let total = first.first().ok_or("Missing Actions search total")?;
            fields(total, 2)?;
            if total[0] != "total" {
                return Err("Missing Actions search total".into());
            }
            let total = number::<u64>(&total[1])?;
            if total > 1000 {
                if start < end {
                    let middle = start + (end - start) / 2;
                    windows.push((middle + 1, end));
                    windows.push((start, middle));
                } else {
                    return Err(format!(
                        "Actions search exceeds 1,000 runs in one second ({}); cannot verify complete history, stop before publication",
                        range.trim()
                    ));
                }
                continue;
            }
            let rows = if total > 100 {
                self.rows(&path, &query)?
            } else {
                first
            };
            runs.extend(
                rows.into_iter()
                    .filter(|row| row.first().is_none_or(|v| v != "total")),
            );
        }
        Ok(runs)
    }

    fn pr(&self) -> Result<Vec<String>> {
        let mut rows = self.rows(&format!("pulls/{}", self.number), PR_QUERY)?;
        if rows.len() != 1 || rows[0].len() != 12 {
            return Err("Incomplete PR metadata".into());
        }
        let row = rows.remove(0);
        if row[0] != "true" {
            return Err("Report requires a merged PR".into());
        }
        validate_sha(&row[2])?;
        Ok(row)
    }

    fn published(&self) -> Result<Option<String>> {
        let rows = self.rows(
            &format!("issues/{}/comments?per_page=100", self.number),
            r#".[] | select(.user.login == "github-actions[bot]") | [.body] | @tsv"#,
        )?;
        let reports: Vec<_> = rows
            .iter()
            .filter_map(|row| row.first().filter(|body| body.contains(MARKER)))
            .collect();
        match reports.as_slice() {
            [] => Ok(None),
            [body] => Ok(Some((*body).clone())),
            _ => Err(INTEGRITY_ERROR.into()),
        }
    }

    fn existing(&self, expected: &str) -> Result<bool> {
        match self.published()?.as_deref() {
            None => Ok(false),
            Some(body) if body == expected => Ok(true),
            _ => Err(INTEGRITY_ERROR.into()),
        }
    }

    fn collect(&self, pr: &[String], queued: Option<&BTreeSet<String>>) -> Result<Report> {
        let merged: i64 = number(&pr[6])?;
        let opened: i64 = number(&pr[10])?;
        let head_repository: u64 = number(&pr[11])?;
        let mut report = Report {
            repo: self.repo.clone(),
            number: self.number,
            head: pr[2].clone(),
            additions: number(&pr[7])?,
            deletions: number(&pr[8])?,
            files: number(&pr[9])?,
            ..Report::default()
        };
        let mut commits = BTreeSet::from([report.head.clone()]);
        for (index, row) in self
            .rows(
                &format!("pulls/{}/commits?per_page=100", self.number),
                r#".[] | [.sha] | @tsv"#,
            )?
            .into_iter()
            .enumerate()
        {
            fields(&row, 1)?;
            validate_sha(&row[0])?;
            report.commit_order.insert(row[0].clone(), index);
            commits.insert(row[0].clone());
        }
        for row in self.rows(
            &format!("pulls/{}/reviews?per_page=100", self.number),
            REVIEW_QUERY,
        )? {
            fields(&row, 4)?;
            let submitted = number(&row[3])?;
            if submitted <= merged {
                if !row[2].is_empty() {
                    validate_sha(&row[2])?;
                    commits.insert(row[2].clone());
                }
                report.reviews.push(Review {
                    id: number(&row[0])?,
                    state: row[1].clone(),
                    sha: row[2].clone(),
                    submitted,
                });
            }
        }
        let mut runs = BTreeMap::new();
        for row in self.workflow_runs(&pr[3], opened, merged)? {
            fields(&row, 7)?;
            let id = number(&row[0])?;
            let run = Run::parse(&row)?;
            if run.created >= opened
                && run.created <= merged
                && run.belongs(
                    self.number,
                    &pr[3],
                    head_repository,
                    commits.contains(&run.sha),
                )
            {
                commits.insert(run.sha.clone());
                report.observe(&run.sha, run.created);
                runs.insert(id, run);
            }
        }
        let mut suites = BTreeMap::new();
        for sha in commits {
            let Some(checks) = self.revision_rows(
                &sha,
                &report.head,
                "check-runs?filter=all&per_page=100",
                CHECK_QUERY,
            )?
            else {
                report.unavailable.insert(sha);
                continue;
            };
            for row in checks {
                fields(&row, 9)?;
                let started = number(&row[4])?;
                if started >= 0 && started < opened {
                    continue;
                }
                let mut completed = number(&row[5])?;
                let mut conclusion = row[6].clone();
                if completed < 0 || completed > merged {
                    completed = -1;
                    conclusion = "unfinished at merge".into();
                }
                let run_id = row[7]
                    .strip_prefix(&format!("https://github.com/{}/actions/runs/", self.repo))
                    .and_then(|s| s.split('/').next())
                    .and_then(|s| s.parse::<u64>().ok());
                let (key, observed) = if let Some(id) = run_id {
                    if let std::collections::btree_map::Entry::Vacant(entry) = runs.entry(id) {
                        let rows = self.rows(&format!("actions/runs/{id}"), RUN_QUERY)?;
                        if rows.len() != 1 {
                            return Err("Incomplete workflow run metadata".into());
                        }
                        entry.insert(Run::parse(&rows[0])?);
                    }
                    let run = &runs[&id];
                    if run.sha != sha
                        || run.created < opened
                        || run.created > merged
                        || !run.belongs(self.number, &pr[3], head_repository, true)
                    {
                        continue;
                    }
                    (format!("workflow:{}:{}", run.workflow, row[1]), run.created)
                } else {
                    let id = number::<u64>(&row[8])?;
                    if id == 0 {
                        return Err("Missing check-suite identity".into());
                    }
                    if let std::collections::btree_map::Entry::Vacant(entry) = suites.entry(id) {
                        let rows = self.rows(
                            &format!("check-suites/{id}"),
                            r#"[.head_sha,(.created_at|fromdateiso8601)] | @tsv"#,
                        )?;
                        if rows.len() != 1 {
                            return Err("Incomplete check-suite metadata".into());
                        }
                        fields(&rows[0], 2)?;
                        validate_sha(&rows[0][0])?;
                        entry.insert((rows[0][0].clone(), number::<i64>(&rows[0][1])?));
                    }
                    let (suite_sha, created) = &suites[&id];
                    if suite_sha != &sha || *created < opened || *created > merged {
                        continue;
                    }
                    (format!("app:{}:{}", row[2], row[1]), *created)
                };
                let id = number(&row[0])?;
                let source = run_id.map_or(CheckSource::App, CheckSource::Actions);
                // Suite creation cannot establish when a new check was added.
                // The complete snapshot survives truncation of displayed rows.
                if (started > merged || (started < 0 && queued.is_some()))
                    && !queued.is_some_and(|ids| ids.contains(&format!("{sha}:{id}")))
                {
                    continue;
                }
                // Queued checks can expose a provisional start that changes later.
                // Freeze every unfinished check in the retained timing snapshot.
                let started = if started > merged || completed < 0 {
                    -1
                } else {
                    started
                };
                if observed >= 0 {
                    report.observe(&sha, observed);
                }
                report.checks.push(Check {
                    id,
                    name: row[1].clone(),
                    sha: sha.clone(),
                    key,
                    observed,
                    completed,
                    conclusion,
                    started,
                    source,
                });
            }
            let Some(statuses) = self.revision_rows(&sha, &report.head, "statuses?per_page=100", r#".[] | [.id,.context,.state,(.created_at|fromdateiso8601),(.updated_at|fromdateiso8601)] | @tsv"#)? else {
                report.unavailable.insert(sha);
                continue;
            };
            for row in statuses {
                fields(&row, 5)?;
                let observed = number(&row[3])?;
                if observed < opened || observed > merged {
                    continue;
                }
                let state = row[2].as_str();
                let completed = number(&row[4])?;
                report.observe(&sha, observed);
                report.checks.push(Check {
                    id: number(&row[0])?,
                    name: row[1].clone(),
                    sha: sha.clone(),
                    key: format!("status:{}", row[1]),
                    observed,
                    started: -1,
                    completed: if state == "pending" || completed > merged {
                        -1
                    } else {
                        completed
                    },
                    conclusion: if state == "pending" || completed > merged {
                        "unfinished at merge"
                    } else {
                        match state {
                            "error" => "failure",
                            _ => state,
                        }
                    }
                    .into(),
                    source: CheckSource::Status,
                });
            }
        }
        Ok(report)
    }

    fn post(&self, original: &[String], body: &str) -> Result<()> {
        let current = self.pr()?;
        if current[1..3] != original[1..3]
            || current[5] != original[5]
            || current[11] != original[11]
        {
            return Err("PR identity changed during collection".into());
        }
        let body = comment_body(body)?;
        if self.existing(&body)? {
            return Ok(());
        }
        let output = Command::new("gh")
            .args([
                "api",
                &format!("repos/{}/issues/{}/comments", self.repo, self.number),
                "--method",
                "POST",
                "-f",
                &format!("body={body}"),
                "--jq",
                ".id",
            ])
            .output()
            .map_err(|e| format!("Cannot post report: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "Report publication failed; retain the report and inspect existing comments: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        let id = number::<u64>(String::from_utf8_lossy(&output.stdout).trim())?;
        let posted = self.rows(&format!("issues/comments/{id}"), "[.body] | @tsv")?;
        if posted != vec![vec![body]] {
            return Err(
                "Posted report did not match readback; stop and investigate, do not retry".into(),
            );
        }
        Ok(())
    }
}

impl Report {
    fn precedes(&self, earlier: &str, later: &str) -> bool {
        self.commit_order
            .get(earlier)
            .zip(self.commit_order.get(later))
            .is_some_and(|(earlier, later)| earlier < later)
    }

    fn observe(&mut self, sha: &str, time: i64) {
        self.revisions
            .entry(sha.into())
            .and_modify(|t| *t = (*t).min(time))
            .or_insert(time);
    }
}

struct Run {
    sha: String,
    created: i64,
    workflow: u64,
    branch: String,
    prs: String,
    repository: u64,
}
impl Run {
    fn parse(row: &[String]) -> Result<Self> {
        fields(row, 7)?;
        validate_sha(&row[1])?;
        Ok(Self {
            sha: row[1].clone(),
            created: number(&row[2])?,
            workflow: number(&row[3])?,
            branch: row[4].clone(),
            prs: row[5].clone(),
            repository: number(&row[6])?,
        })
    }
    fn belongs(&self, pr: u64, branch: &str, repository: u64, known_commit: bool) -> bool {
        self.prs.split(',').any(|n| n == pr.to_string())
            || (self.prs.is_empty()
                && self.branch == branch
                && repository != 0
                && self.repository == repository
                && known_commit)
    }
}

fn fields(row: &[String], expected: usize) -> Result<()> {
    if row.len() == expected {
        Ok(())
    } else {
        Err("Incomplete API record".into())
    }
}
fn number<T: std::str::FromStr>(value: &str) -> Result<T> {
    value
        .parse()
        .map_err(|_| "Invalid API numeric field".into())
}
fn validate_sha(sha: &str) -> Result<()> {
    if sha.len() == 40 && sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err("Invalid commit SHA".into())
    }
}
fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                char::from(b).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
fn unescape_tsv(value: &str) -> Result<String> {
    let mut result = String::new();
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        result.push(if c == '\\' {
            match chars.next() {
                Some('n') => '\n',
                Some('r') => '\r',
                Some('t') => '\t',
                Some('\\') => '\\',
                _ => return Err("Invalid TSV escape from GitHub".into()),
            }
        } else {
            c
        });
    }
    Ok(result)
}
fn queued_membership(body: &str, repo: &str, pr: u64, head: &str) -> Result<BTreeSet<String>> {
    let mut snapshots = body
        .lines()
        .filter_map(|line| line.strip_prefix(QUEUED_PREFIX));
    let record = snapshots.next().ok_or(INTEGRITY_ERROR)?;
    if snapshots.next().is_some() {
        return Err(INTEGRITY_ERROR.into());
    }
    let fields: Vec<_> = record
        .strip_suffix(" -->")
        .ok_or(INTEGRITY_ERROR)?
        .split_whitespace()
        .collect();
    if fields.len() != 4 || fields[0] != repo || fields[1] != pr.to_string() || fields[2] != head {
        return Err(INTEGRITY_ERROR.into());
    }
    let mut ids = BTreeSet::new();
    if fields[3] != "-" {
        for key in fields[3].split(',') {
            let (sha, id) = key.split_once(':').ok_or(INTEGRITY_ERROR)?;
            validate_sha(sha)?;
            let id = number::<u64>(id)?;
            if id == 0 || key != format!("{sha}:{id}") || !ids.insert(key.to_owned()) {
                return Err(INTEGRITY_ERROR.into());
            }
        }
    }
    Ok(ids)
}

fn comment_body(body: &str) -> Result<String> {
    if body.len() <= 60_000 {
        return Ok(body.into());
    }
    let mut end = 58_000;
    while !body.is_char_boundary(end) {
        end -= 1;
    }
    let end = body[..end].rfind('\n').unwrap_or(end);
    if body
        .lines()
        .find(|line| line.starts_with(QUEUED_PREFIX))
        .is_some_and(|snapshot| !body[..end].contains(snapshot))
    {
        return Err("Complete queued-check snapshot exceeds GitHub's comment limit; retain the full report and stop before publication".into());
    }
    Ok(format!(
        "{}\n\nTiming rows truncated to fit GitHub's comment limit. The workflow attempts to retain the full report in its summary and the artifact for that run attempt; check the workflow result if either is unavailable.\n\n</details>\n",
        &body[..end]
    ))
}
fn execute() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if !(args.len() == 2 || (args.len() == 3 && args[2] == "--post")) {
        return Err("Usage: pr-merge-report OWNER/REPO NUMBER [--post]".into());
    }
    let parts: Vec<_> = args[0].split('/').collect();
    if parts.len() != 2
        || parts.iter().any(|s| {
            s.is_empty()
                || matches!(*s, "." | "..")
                || !s
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        })
    {
        return Err("Invalid repository".into());
    }
    let api = Api {
        repo: args[0].clone(),
        number: number(&args[1])?,
    };
    if api.number == 0 {
        return Err("PR number must be positive".into());
    }
    let pr = api.pr()?;
    let published = api.published()?;
    let queued = published
        .as_deref()
        .map(|body| queued_membership(body, &api.repo, api.number, &pr[2]))
        .transpose()?;
    let report = api.collect(&pr, queued.as_ref())?;
    let body = render(&report);
    print!("{body}");
    if args.len() == 3 {
        api.post(&pr, &body)?;
    }
    Ok(())
}
fn main() {
    if let Err(error) = execute() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_report_shows_github_diff_totals_in_a_separate_collapsed_comment() {
        let report = Report {
            additions: 209,
            deletions: 10,
            files: 5,
            ..Report::default()
        };
        let text = render(&report);
        assert!(text.starts_with("<details>\n<summary>Merge outcomes</summary>"));
        assert!(text.contains("+209 / -10 lines across 5 files"));
        assert!(!text.contains("agent-session-report:v1"));
    }

    fn check(sha: &str, observed: i64, completed: i64, conclusion: &str) -> Check {
        Check {
            sha: sha.into(),
            key: "unit".into(),
            observed,
            completed,
            conclusion: conclusion.into(),
            ..Check::default()
        }
    }

    #[test]
    fn retries_are_not_pushes_and_only_failures_known_before_the_next_revision_count() {
        let report = Report {
            commit_order: BTreeMap::from([
                ("a".into(), 0),
                ("b".into(), 1),
                ("c".into(), 2),
                ("d".into(), 3),
            ]),
            checks: vec![
                check("a", 10, 20, "failure"),
                check("a", 10, 25, "success"),
                check("b", 30, 40, "failure"),
                check("c", 50, 70, "failure"),
                check("d", 60, 80, "success"),
            ],
            reviews: vec![Review {
                sha: "a".into(),
                submitted: 26,
                state: "CHANGES_REQUESTED".into(),
                ..Review::default()
            }],
            ..Report::default()
        };
        let text = render(&report);
        assert!(text.contains("| Repair rounds | 1 (observed revisions after failed checks) |"));
        assert!(text.contains(
            "| Review rounds | 1 changes-requested reviews; 1 observed follow-up revisions |"
        ));

        let mut retry = Report {
            commit_order: BTreeMap::from([("a".into(), 0), ("b".into(), 1)]),
            checks: vec![check("b", 10, 20, "failure"), check("a", 40, 50, "success")],
            reviews: vec![Review {
                sha: "b".into(),
                submitted: 30,
                state: "CHANGES_REQUESTED".into(),
                ..Review::default()
            }],
            ..Report::default()
        };
        let text = render(&retry);
        assert!(text.contains("| Repair rounds | 0 (observed revisions after failed checks) |"));
        assert!(text.contains(
            "| Review rounds | 1 changes-requested reviews; 0 observed follow-up revisions |"
        ));
        for attribution in ["", "missing"] {
            retry.reviews[0].sha = attribution.into();
            assert!(render(&retry).contains(
                "| Review rounds | 1 changes-requested reviews; 0 observed follow-up revisions |"
            ));
        }
        retry.reviews[0].sha = "b".into();
        retry.commit_order.remove("a");
        assert!(render(&retry).contains(
            "| Review rounds | 1 changes-requested reviews; 0 observed follow-up revisions |"
        ));
    }

    #[test]
    fn a_long_comment_with_unicode_stays_within_the_limit_without_panicking() {
        let text = format!("{}{}", "a".repeat(57_999), "💻".repeat(2_000));
        let comment = comment_body(&text).unwrap();
        assert!(comment.len() < 60_000);
        assert!(comment.contains("truncated"));
        assert!(comment.ends_with("</details>\n"));
    }

    #[test]
    fn queued_snapshot_rejects_changed_identity_and_incomplete_evidence() {
        let head = "a".repeat(40);
        let snapshot = format!("{QUEUED_PREFIX}example/repo 1 {head} {head}:203,{head}:204 -->\n");
        assert_eq!(
            queued_membership(&snapshot, "example/repo", 1, &head)
                .unwrap()
                .len(),
            2
        );
        assert!(queued_membership(&snapshot, "other/repo", 1, &head).is_err());
        assert!(queued_membership(&snapshot, "example/repo", 2, &head).is_err());
        assert!(queued_membership(&snapshot, "example/repo", 1, &"b".repeat(40)).is_err());
        for invalid in [
            String::new(),
            format!("{snapshot}{snapshot}"),
            snapshot.replace(":204", ":203"),
            snapshot.replace(":204", ":0"),
            snapshot.replace(" -->", ""),
        ] {
            assert!(queued_membership(&invalid, "example/repo", 1, &head).is_err());
        }
        let entries = (1..=1_500)
            .map(|id| format!("{head}:{id}"))
            .collect::<Vec<_>>()
            .join(",");
        let oversized = format!("<details>\n{QUEUED_PREFIX}example/repo 1 {head} {entries} -->\n");
        assert_eq!(
            queued_membership(&oversized, "example/repo", 1, &head)
                .unwrap()
                .len(),
            1_500
        );
        assert!(comment_body(&oversized).is_err());
    }

    #[test]
    fn missing_or_reversed_check_timestamps_do_not_claim_a_duration() {
        let report = Report {
            checks: vec![Check {
                name: "Skipped".into(),
                started: 20,
                completed: 19,
                conclusion: "skipped".into(),
                ..check("a", 10, 19, "skipped")
            }],
            ..Report::default()
        };
        assert!(render(&report).contains("| skipped | unavailable |"));
    }
}
