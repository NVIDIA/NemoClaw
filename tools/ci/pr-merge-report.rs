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
                .find(|(sha, time)| *sha != review.sha && *time > review.submitted)
                .map(|(sha, _)| *sha)
        })
        .collect();
    let mut text = format!(
        "<details>\n<summary>Merge outcomes</summary>\n\n{MARKER}\n\nGitHub data for #{} at merge, head `{}`.\n\n| Measure | Result |\n| --- | --- |\n| Repair rounds | {repairs} (observed revisions after failed checks) |\n| Review rounds | {} changes-requested reviews; {} observed follow-up revisions |\n| Diff size | +{} / -{} lines across {} files |\n\n",
        report.number,
        report.head,
        requests.len(),
        followups.len(),
        report.additions,
        report.deletions,
        report.files
    );
    text.push_str("A revision is a distinct checked head SHA. Repair rounds count a new revision when the preceding revision's latest completed check still failed before that revision was first observed. A retry on the same SHA is not a push. Review follow-ups count the first later observed revision for each changes-requested review, once per revision.\n\n");
    text.push_str("Limits: these are observed revision counts, not a complete push history. GitHub does not supply push timestamps here. Intermediate pushes without checks, removed history, deleted checks, and the original state of dismissed reviews may be missing. A new check's creation time is an upper bound on its push time. This report does not decide whether required checks were green or whether a push fixed a failure.\n\n");
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
        let link = match check.source {
            CheckSource::Actions(run) => format!(
                "https://github.com/{}/actions/runs/{run}/job/{}",
                report.repo, check.id
            ),
            CheckSource::Status => {
                format!("https://github.com/{}/commit/{}", report.repo, check.sha)
            }
            CheckSource::App => format!(
                "https://github.com/{}/pull/{}/checks?check_run_id={}",
                report.repo, report.number, check.id
            ),
        };
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
const PR_QUERY: &str = r#"[.merged,.base.ref,.head.sha,.head.ref,.created_at,.merged_at,(.merged_at | if . == null then -1 else fromdateiso8601 end),.additions,.deletions,.changed_files,(.created_at|fromdateiso8601)] | @tsv"#;
const RUN_QUERY: &str = r#"[.id,.head_sha,(.created_at|fromdateiso8601),.workflow_id,(.head_branch // ""),([(.pull_requests // [])[].number]|join(","))] | @tsv"#;
const CHECK_QUERY: &str = r#"def stamp: if . == null then -1 else fromdateiso8601 end; .check_runs[] | [.id,.name,.app.id,.app.slug,(.started_at|stamp),(.completed_at|stamp),(.conclusion // "unfinished"),(.details_url // "")] | @tsv"#;
const REVIEW_QUERY: &str = r#".[] | select(.submitted_at != null) | [.id,.state,.commit_id,(.submitted_at|fromdateiso8601)] | @tsv"#;

struct Api {
    repo: String,
    number: u64,
}

impl Api {
    fn rows(&self, path: &str, query: &str) -> Result<Vec<Vec<String>>> {
        let output = Command::new("gh")
            .args([
                "api",
                "--paginate",
                &format!("repos/{}/{path}", self.repo),
                "--jq",
                query,
            ])
            .output()
            .map_err(|e| format!("Cannot run gh: {e}"))?;
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

    fn pr(&self) -> Result<Vec<String>> {
        let mut rows = self.rows(&format!("pulls/{}", self.number), PR_QUERY)?;
        if rows.len() != 1 || rows[0].len() != 11 {
            return Err("Incomplete PR metadata".into());
        }
        let row = rows.remove(0);
        if row[0] != "true" || !matches!(row[1].as_str(), "main" | "v1") {
            return Err("Report requires a PR merged into main or v1".into());
        }
        validate_sha(&row[2])?;
        Ok(row)
    }

    fn existing(&self) -> Result<bool> {
        let rows = self.rows(
            &format!("issues/{}/comments?per_page=100", self.number),
            r#".[] | select(.user.login == "github-actions[bot]") | [.body] | @tsv"#,
        )?;
        Ok(rows
            .iter()
            .any(|row| row.first().is_some_and(|body| body.contains(MARKER))))
    }

    fn collect(&self, pr: &[String]) -> Result<Report> {
        let merged: i64 = number(&pr[6])?;
        let opened: i64 = number(&pr[10])?;
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
        for row in self.rows(
            &format!("pulls/{}/commits?per_page=100", self.number),
            r#".[] | [.sha] | @tsv"#,
        )? {
            fields(&row, 1)?;
            validate_sha(&row[0])?;
            commits.insert(row[0].clone());
        }
        for row in self.rows(
            &format!("pulls/{}/reviews?per_page=100", self.number),
            REVIEW_QUERY,
        )? {
            fields(&row, 4)?;
            let submitted = number(&row[3])?;
            if submitted <= merged {
                validate_sha(&row[2])?;
                commits.insert(row[2].clone());
                report.reviews.push(Review {
                    id: number(&row[0])?,
                    state: row[1].clone(),
                    sha: row[2].clone(),
                    submitted,
                });
            }
        }
        let runs_path = format!(
            "actions/runs?branch={}&created={}&per_page=100",
            encode(&pr[3]),
            encode(&format!("{}..{}", pr[4], pr[5]))
        );
        // Actions caps filtered searches at 1,000 runs. Fail visibly rather than
        // interpreting a truncated history as a complete search.
        let run_rows = self.rows(
            &runs_path,
            &format!(r#"(["total",.total_count] | @tsv), (.workflow_runs[] | {RUN_QUERY})"#),
        )?;
        let mut runs = BTreeMap::new();
        for row in run_rows {
            if row.first().is_some_and(|v| v == "total") {
                fields(&row, 2)?;
                if number::<u64>(&row[1])? > 1000 {
                    return Err("Actions search exceeds 1,000 retained runs; narrow collection before reporting".into());
                }
                continue;
            }
            fields(&row, 6)?;
            let id = number(&row[0])?;
            let run = Run::parse(&row)?;
            if run.created >= opened
                && run.created <= merged
                && run.belongs(self.number, &pr[3], commits.contains(&run.sha))
            {
                commits.insert(run.sha.clone());
                report.observe(&run.sha, run.created);
                runs.insert(id, run);
            }
        }
        for sha in commits {
            for row in self.rows(
                &format!("commits/{sha}/check-runs?filter=all&per_page=100"),
                CHECK_QUERY,
            )? {
                fields(&row, 8)?;
                let started = number(&row[4])?;
                if started > merged || (started >= 0 && started < opened) {
                    continue;
                }
                let mut completed = number(&row[5])?;
                let mut conclusion = row[6].clone();
                if completed > merged {
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
                        || !run.belongs(self.number, &pr[3], true)
                    {
                        continue;
                    }
                    (format!("workflow:{}:{}", run.workflow, row[1]), run.created)
                } else {
                    (format!("app:{}:{}", row[2], row[1]), started)
                };
                if observed >= 0 {
                    report.observe(&sha, observed);
                }
                report.checks.push(Check {
                    id: number(&row[0])?,
                    name: row[1].clone(),
                    sha: sha.clone(),
                    key,
                    observed,
                    completed,
                    conclusion,
                    started,
                    source: run_id.map_or(CheckSource::App, CheckSource::Actions),
                });
            }
            for row in self.rows(&format!("commits/{sha}/statuses?per_page=100"), r#".[] | [.id,.context,.state,(.created_at|fromdateiso8601),(.updated_at|fromdateiso8601)] | @tsv"#)? {
                fields(&row, 5)?;
                let observed = number(&row[3])?;
                if observed < opened || observed > merged { continue; }
                let state = row[2].as_str();
                let completed = number(&row[4])?;
                report.observe(&sha, observed);
                report.checks.push(Check {
                    id: number(&row[0])?, name: row[1].clone(), sha: sha.clone(),
                    key: format!("status:{}", row[1]), observed, started: -1,
                    completed: if state == "pending" || completed > merged { -1 } else { completed },
                    conclusion: if completed > merged { "unfinished at merge" } else { match state { "error" => "failure", _ => state } }.into(),
                    source: CheckSource::Status
                });
            }
        }
        Ok(report)
    }

    fn post(&self, original: &[String], body: &str) -> Result<()> {
        let current = self.pr()?;
        if current[1..3] != original[1..3] || current[5] != original[5] {
            return Err("PR identity changed during collection".into());
        }
        if self.existing()? {
            return Ok(());
        }
        let body = comment_body(body);
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
                "Report publication failed; inspect existing comments before retrying: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        let id = number::<u64>(String::from_utf8_lossy(&output.stdout).trim())?;
        let posted = self.rows(&format!("issues/comments/{id}"), "[.body] | @tsv")?;
        if posted != vec![vec![body]] {
            return Err(
                "Posted report did not match readback; inspect comments before retrying".into(),
            );
        }
        Ok(())
    }
}

impl Report {
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
}
impl Run {
    fn parse(row: &[String]) -> Result<Self> {
        fields(row, 6)?;
        validate_sha(&row[1])?;
        Ok(Self {
            sha: row[1].clone(),
            created: number(&row[2])?,
            workflow: number(&row[3])?,
            branch: row[4].clone(),
            prs: row[5].clone(),
        })
    }
    fn belongs(&self, pr: u64, branch: &str, known_commit: bool) -> bool {
        self.prs.split(',').any(|n| n == pr.to_string())
            || (self.prs.is_empty() && self.branch == branch && known_commit)
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
fn comment_body(body: &str) -> String {
    if body.len() <= 60_000 {
        return body.into();
    }
    let mut end = 58_000;
    while !body.is_char_boundary(end) {
        end -= 1;
    }
    let end = body[..end].rfind('\n').unwrap_or(end);
    format!(
        "{}\n\nTiming rows truncated to fit GitHub's comment limit. The full report is in this workflow run's summary and merge-outcomes artifact.\n\n</details>\n",
        &body[..end]
    )
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
    if args.len() == 3 && api.existing()? {
        eprintln!("Merge report already exists");
        return Ok(());
    }
    let report = api.collect(&pr)?;
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
    }

    #[test]
    fn a_long_comment_with_unicode_stays_within_the_limit_without_panicking() {
        let text = format!("{}{}", "a".repeat(57_999), "💻".repeat(2_000));
        let comment = comment_body(&text);
        assert!(comment.len() < 60_000);
        assert!(comment.contains("truncated"));
        assert!(comment.ends_with("</details>\n"));
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
