// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use std::collections::BTreeMap;

use ::varar::{HandlerError, Steps};
use nemoclaw_sdk::config::Document;

use super::{Ctx, repository_path};

/// The parse failure as a user sees it, or a marker a mismatch makes obvious.
fn outcome(source: &str) -> String {
    match Document::parse(source.as_bytes()) {
        Ok(_) => "the configuration was accepted".to_owned(),
        Err(error) => error.to_string(),
    }
}

pub fn register(s: &mut Steps<Ctx>) {
    s.stimulus(
        "Reading this configuration:",
        |_ctx: Ctx, source: String| Ok(Ctx { source }),
    );

    s.stimulus("Starting from `{code}`", |_ctx: Ctx, path: String| {
        Ok(Ctx {
            source: read(&path)?,
        })
    });

    s.stimulus(
        "changing `{code}` to `{code}`",
        |ctx: Ctx, from: String, to: String| replace(ctx, &from, &to),
    );

    // A doc string ends with its newline; the message does not.
    s.sensor("fails with:", |ctx: Ctx, _expected: String| {
        Ok(format!("{}\n", outcome(&ctx.source)))
    });

    s.sensor(
        "Each input, written as a JSON string, fails with its message",
        |_ctx: Ctx, row: BTreeMap<String, String>| {
            let input: String = serde_json::from_str(&row["input"])
                .map_err(|e| HandlerError::new(format!("input is not a JSON string: {e}")))?;
            Ok(BTreeMap::from([("message".to_owned(), outcome(&input))]))
        },
    );

    // Varar runs only the sensor for each row of a header-bound table, so the
    // starting document is part of this sentence rather than a stimulus.
    s.sensor(
        "Replacing each original in `{code}` with its replacement fails with the message",
        |_ctx: Ctx, path: String, row: BTreeMap<String, String>| {
            let edited = replace(
                Ctx {
                    source: read(&path)?,
                },
                &row["original"],
                &row["replacement"],
            )?;
            Ok((
                path,
                BTreeMap::from([("message".to_owned(), outcome(&edited.source))]),
            ))
        },
    );

    s.sensor(
        "keeps these harness settings:",
        |ctx: Ctx, _expected: String| {
            let document = Document::parse(ctx.source.as_bytes())
                .map_err(|e| HandlerError::new(e.to_string()))?;
            let tree =
                serde_json::to_value(document).map_err(|e| HandlerError::new(e.to_string()))?;
            let settings = &tree["spec"]["sandboxes"][0]["harness"]["settings"];
            Ok(format!(
                "{}\n",
                serde_json::to_string_pretty(settings).unwrap()
            ))
        },
    );
}

fn read(path: &str) -> Result<String, HandlerError> {
    std::fs::read_to_string(repository_path(path))
        .map_err(|e| HandlerError::new(format!("cannot read {path}: {e}")))
}

/// Replaces the first occurrence, failing when the original is absent so a
/// stale example cannot pass on an unchanged document.
fn replace(ctx: Ctx, from: &str, to: &str) -> Result<Ctx, HandlerError> {
    if !ctx.source.contains(from) {
        return Err(HandlerError::new(format!("the document has no `{from}`")));
    }
    Ok(Ctx {
        source: ctx.source.replacen(from, to, 1),
    })
}
