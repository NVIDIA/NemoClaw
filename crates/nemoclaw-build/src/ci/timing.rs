// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Where test time goes, read from a nextest JUnit report.

use std::{collections::BTreeMap, fmt::Write};

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

    /// A Markdown report: totals, then the `rows` slowest test modules of
    /// each binary, then the `rows` slowest tests.
    #[must_use]
    pub fn report(&self, profile: &str, rows: usize) -> String {
        let summed: f64 = self.tests.iter().map(|test| test.seconds).sum();
        let mut report = format!(
            "### {profile}: {} tests, {:.1} s wall, {:.1} s summed\n\n",
            self.tests.len(),
            self.wall_seconds,
            summed
        );
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
