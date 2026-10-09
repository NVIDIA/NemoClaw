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

/// The value of `name` among an element's attributes, unescaped.
fn attribute(element: &str, name: &str) -> Option<String> {
    let start = element.find(&format!(" {name}=\""))? + name.len() + 3;
    let end = start + element[start..].find('"')?;
    Some(
        element[start..end]
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&apos;", "'")
            .replace("&amp;", "&"),
    )
}

fn seconds(element: &str) -> Result<f64, String> {
    attribute(element, "time")
        .and_then(|time| time.parse().ok())
        .ok_or_else(|| "JUnit element lacks its time".to_owned())
}

impl Run {
    /// Read a nextest JUnit report.
    ///
    /// # Errors
    /// Returns an error when the report lacks its run or test times.
    pub fn parse(xml: &str) -> Result<Self, String> {
        let open = xml
            .find("<testsuites")
            .ok_or("JUnit report lacks <testsuites>")?;
        let header = &xml[open..open + xml[open..].find('>').ok_or("unterminated <testsuites>")?];
        let wall_seconds = seconds(header)?;
        let mut tests = Vec::new();
        let mut rest = &xml[open..];
        while let Some(start) = rest.find("<testcase ") {
            rest = &rest[start..];
            let end = rest.find('>').ok_or("unterminated <testcase>")?;
            let element = &rest[..end];
            // A test failed when its element holds a failure or error.
            let failed = !element.ends_with('/') && {
                let body = &rest[end..rest.find("</testcase>").unwrap_or(rest.len())];
                body.contains("<failure") || body.contains("<error")
            };
            tests.push(Test {
                binary: attribute(element, "classname").unwrap_or_default(),
                name: attribute(element, "name").ok_or("JUnit test lacks its name")?,
                seconds: seconds(element)?,
                failed,
            });
            rest = &rest[end..];
        }
        Ok(Self {
            wall_seconds,
            tests,
        })
    }

    /// A Markdown report: totals, then time by binary and test module, then
    /// the `slowest` tests.
    #[must_use]
    pub fn report(&self, profile: &str, slowest: usize) -> String {
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
        for ((binary, module), (count, total, max)) in groups {
            let _ = writeln!(
                report,
                "| {binary} | {module} | {count} | {total:.1} s | {max:.1} s |"
            );
        }
        let mut tests: Vec<_> = self.tests.iter().collect();
        tests.sort_by(|a, b| b.seconds.total_cmp(&a.seconds));
        report.push_str("\n| Time | Slowest tests |\n|---|---|\n");
        for test in tests.into_iter().take(slowest) {
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
