// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Where test time goes, read from nextest JUnit reports.

use serde::Deserialize;
use std::{collections::BTreeMap, fmt::Write};

/// A test step's wall-clock budget, and the limit for any one test in it.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Budget {
    pub wall_seconds: u64,
    pub test_seconds: u64,
}

/// Budgets by test step name, as `.config/test-budgets.yaml` records them.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct Budgets(BTreeMap<String, Budget>);

impl Budgets {
    /// Read budgets from YAML.
    ///
    /// # Errors
    /// Returns an error for malformed budgets.
    pub fn parse(yaml: &str) -> Result<Self, String> {
        serde_saphyr::from_str(yaml).map_err(|error| format!("invalid test budgets: {error}"))
    }

    /// The budget of the step named `step`.
    #[must_use]
    pub fn get(&self, step: &str) -> Option<Budget> {
        self.0.get(step).copied()
    }
}

/// One test's result.
#[derive(Clone, Debug, PartialEq)]
pub struct Test {
    /// Test binary, as nextest names it, such as `nemoclaw-e2e::integration`.
    pub binary: String,
    /// Test path within the binary, such as `deployment::applies`.
    pub name: String,
    pub seconds: f64,
    pub failed: bool,
}

/// One nextest run.
#[derive(Clone, Debug, PartialEq)]
pub struct Run {
    /// Elapsed time of the whole run.
    pub wall_seconds: f64,
    pub tests: Vec<Test>,
}

impl Run {
    /// Read a nextest JUnit report.
    ///
    /// # Errors
    /// Returns an error when the report is not JUnit XML or lacks its run time.
    pub fn parse(xml: &str) -> Result<Self, String> {
        let report = quick_junit::Report::deserialize_from_str(xml)
            .map_err(|error| format!("invalid JUnit report: {error}"))?;
        let wall_seconds = report
            .time
            .ok_or("JUnit report lacks its run time")?
            .as_secs_f64();
        let tests = report
            .test_suites
            .iter()
            .flat_map(|suite| &suite.test_cases)
            .map(|test| Test {
                binary: test
                    .classname
                    .as_ref()
                    .map(|binary| binary.as_str().to_owned())
                    .unwrap_or_default(),
                name: test.name.as_str().to_owned(),
                seconds: test.time.unwrap_or_default().as_secs_f64(),
                failed: matches!(test.status, quick_junit::TestCaseStatus::NonSuccess { .. }),
            })
            .collect();
        Ok(Self {
            wall_seconds,
            tests,
        })
    }

    /// What exceeds `budget`: the run's wall time, then each test over the
    /// limit, slowest first.
    #[must_use]
    pub fn over(&self, budget: Budget) -> Vec<String> {
        let mut over = Vec::new();
        if self.wall_seconds > budget.wall_seconds as f64 {
            over.push(format!(
                "{:.1} s wall exceeds the {} s budget",
                self.wall_seconds, budget.wall_seconds
            ));
        }
        let mut tests: Vec<_> = self
            .tests
            .iter()
            .filter(|test| test.seconds > budget.test_seconds as f64)
            .collect();
        tests.sort_by(|a, b| b.seconds.total_cmp(&a.seconds));
        over.extend(tests.into_iter().map(|test| {
            format!(
                "{} {} took {:.1} s; the limit is {} s",
                test.binary, test.name, test.seconds, budget.test_seconds
            )
        }));
        over
    }

    /// A Markdown report: totals, then the `rows` slowest test modules of
    /// each binary, then the `rows` slowest tests.
    #[must_use]
    pub fn report(&self, profile: &str, rows: usize) -> String {
        let mut report = self.headline(profile);
        report.push('\n');
        report.push_str(&self.tables(rows));
        report
    }

    fn summed_seconds(&self) -> f64 {
        self.tests.iter().map(|test| test.seconds).sum()
    }

    fn headline(&self, profile: &str) -> String {
        format!(
            "### {profile}: {} tests, {:.1} s wall, {:.1} s summed\n",
            self.tests.len(),
            self.wall_seconds,
            self.summed_seconds()
        )
    }

    /// The slowest modules and tests, without the headline.
    fn tables(&self, rows: usize) -> String {
        let mut report = String::new();
        let mut groups: BTreeMap<(&str, &str), (usize, f64, f64)> = BTreeMap::new();
        for test in &self.tests {
            let module = test.name.split("::").next().unwrap_or(&test.name);
            let group = groups.entry((&test.binary, module)).or_default();
            group.0 += 1;
            group.1 += test.seconds;
            group.2 = group.2.max(test.seconds);
        }
        let mut groups: Vec<_> = groups.into_iter().collect();
        groups.sort_by(|a, b| b.1.1.total_cmp(&a.1.1));
        report.push_str("| Binary | Module | Tests | Summed | Slowest |\n|---|---|---|---|---|\n");
        let rest: f64 = groups.iter().skip(rows).map(|group| group.1.1).sum();
        let others = groups.len().saturating_sub(rows);
        for ((binary, module), (count, total, max)) in groups.into_iter().take(rows) {
            let _ = writeln!(
                report,
                "| {binary} | {module} | {count} | {total:.1} s | {max:.1} s |"
            );
        }
        if others > 0 {
            let _ = writeln!(report, "| {others} other modules | | | {rest:.1} s | |");
        }
        let mut tests: Vec<_> = self.tests.iter().collect();
        tests.sort_by(|a, b| b.seconds.total_cmp(&a.seconds));
        report.push_str("\n| Time | Slowest tests |\n|---|---|\n");
        for test in tests.into_iter().take(rows) {
            let failed = if test.failed { " (failed)" } else { "" };
            let _ = writeln!(
                report,
                "| {:.1} s | {} {}{failed} |",
                test.seconds, test.binary, test.name
            );
        }
        report
    }
}

/// Join the JUnit reports of nextest runs made one after another, such as the
/// live-docker step's, into one report whose run time is their sum.
///
/// # Errors
/// Returns an error when there are no reports, or one is not a nextest JUnit
/// report with its run time.
pub fn join_consecutive(reports: &[String]) -> Result<String, String> {
    let mut joined: Option<quick_junit::Report> = None;
    for xml in reports {
        let report = quick_junit::Report::deserialize_from_str(xml)
            .map_err(|error| format!("invalid JUnit report: {error}"))?;
        let time = report.time.ok_or("JUnit report lacks its run time")?;
        match &mut joined {
            None => joined = Some(report),
            Some(joined) => {
                let total = joined.time.unwrap_or_default() + time;
                joined.add_test_suites(report.test_suites).set_time(total);
            }
        }
    }
    joined
        .ok_or("no JUnit reports to join")?
        .to_string()
        .map_err(|error| format!("cannot write the joined JUnit report: {error}"))
}

/// A Markdown report of a platform's whole lifecycle suite, from the JUnit
/// reports its partitions uploaded: the artifacts
/// `lifecycle-PLATFORM-SHARD-ATTEMPT`, downloaded as subdirectories of
/// `directory`. Each shard's latest attempt counts, and each of `shards` without
/// a report is named. Partitions run in parallel on separate runners, so the
/// suite's wall time is its slowest partition's.
///
/// # Errors
/// Returns an error when `directory` cannot be read or a partition's report
/// cannot be parsed.
pub fn partitioned_report(
    directory: &std::path::Path,
    platform: &str,
    shards: &[u32],
    rows: usize,
) -> Result<String, String> {
    let step = super::Step::Lifecycle;
    let (_, file) = step
        .junit()
        .ok_or("the lifecycle step writes no JUnit report")?;
    let prefix = format!("{}-{platform}-", step.name());
    // Shard to its latest attempt and artifact name.
    let mut latest: BTreeMap<u32, (u32, String)> = BTreeMap::new();
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries.collect::<Result<Vec<_>, _>>(),
        // No partition uploaded a report.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error),
    }
    .map_err(|error| format!("cannot read {}: {error}", directory.display()))?;
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some((shard, attempt)) = name
            .strip_prefix(&prefix)
            .and_then(|rest| rest.split_once('-'))
            .and_then(|(shard, attempt)| Some((shard.parse().ok()?, attempt.parse().ok()?)))
        else {
            continue;
        };
        if latest.get(&shard).is_none_or(|(seen, _)| *seen < attempt) {
            latest.insert(shard, (attempt, name));
        }
    }
    let mut all: Vec<u32> = shards
        .iter()
        .copied()
        .chain(latest.keys().copied())
        .collect();
    all.sort_unstable();
    all.dedup();

    let mut whole = Run {
        wall_seconds: 0.0,
        tests: Vec::new(),
    };
    let mut table =
        String::from("| Partition | Attempt | Tests | Wall | Summed |\n|---|---|---|---|---|\n");
    for shard in &all {
        let Some((attempt, name)) = latest.get(shard) else {
            let _ = writeln!(table, "| {shard} | | | | no JUnit report |");
            continue;
        };
        let path = directory.join(name).join(file);
        let run = std::fs::read_to_string(&path)
            .map_err(|error| error.to_string())
            .and_then(|xml| Run::parse(&xml))
            .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
        let _ = writeln!(
            table,
            "| {shard} | {attempt} | {} | {:.1} s | {:.1} s |",
            run.tests.len(),
            run.wall_seconds,
            run.summed_seconds()
        );
        whole.wall_seconds = whole.wall_seconds.max(run.wall_seconds);
        whole.tests.extend(run.tests);
    }
    let mut report = whole.headline(&format!(
        "{} on {platform}, {} partitions",
        step.name(),
        all.len()
    ));
    report.push_str("\nPartitions run in parallel; the wall time is the slowest partition's.\n\n");
    report.push_str(&table);
    report.push('\n');
    report.push_str(&whole.tables(rows));
    Ok(report)
}
