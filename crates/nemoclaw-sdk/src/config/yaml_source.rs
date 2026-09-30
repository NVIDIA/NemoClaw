// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::ConfigError;
use serde_saphyr::granit_parser::{Event, Parser, ScalarStyle};

pub(super) fn validate_tags(text: &str) -> Result<(), ConfigError> {
    let mut populated = false;
    let mut documents = 0;
    for event in Parser::new_from_str(text) {
        let (event, span) = event.map_err(|error| {
            positioned(
                "invalid YAML syntax",
                error.marker().line(),
                error.marker().col() + 1,
            )
        })?;
        match &event {
            Event::DocumentStart(..) => {
                documents += 1;
                if documents > 1 {
                    return Err(positioned(
                        "multiple YAML documents are not allowed",
                        span.start.line(),
                        span.start.col() + 1,
                    ));
                }
            }
            Event::Scalar(_, style, _, _) => {
                populated |= span.start.index() != span.end.index() || *style != ScalarStyle::Plain;
            }
            Event::MappingStart(..) | Event::SequenceStart(..) | Event::Alias(_) => {
                populated = true
            }
            _ => {}
        }
        if matches!(
            event,
            Event::Scalar(_, _, _, Some(_))
                | Event::MappingStart(_, _, Some(_))
                | Event::SequenceStart(_, _, Some(_))
        ) {
            let marker = span.tag_start.unwrap_or(span.start);
            return Err(positioned(
                "explicit YAML tags are not allowed",
                marker.line(),
                marker.col() + 1,
            ));
        }
    }
    if !populated {
        return Err(ConfigError::new(
            "empty document; provide a NemoClaw configuration",
        ));
    }
    Ok(())
}

pub(super) fn syntax_error(error: serde_saphyr::Error) -> ConfigError {
    fn reason(error: &serde_saphyr::Error) -> &'static str {
        use serde_saphyr::Error;
        match error {
            Error::WithSnippet { error, .. } => reason(error),
            Error::DuplicateMappingKey { .. } => "duplicate mapping key",
            Error::MultipleDocuments { .. } => "multiple YAML documents are not allowed",
            Error::MergeKeyNotAllowed { .. } => "YAML merge keys are not allowed",
            Error::UnknownAnchor { .. } | Error::AliasError { .. } => {
                "YAML aliases are not allowed"
            }
            Error::Budget { .. } => {
                "YAML resource limit exceeded; anchors, aliases, and merge keys are disabled"
            }
            _ => "invalid YAML syntax or value type",
        }
    }
    let message = reason(&error);
    match error.location() {
        Some(location) => positioned(
            message,
            location.line() as usize,
            location.column() as usize,
        ),
        None => ConfigError::new(message),
    }
}

fn positioned(message: &str, line: usize, column: usize) -> ConfigError {
    ConfigError(format!("{message} at line {line}, column {column}"))
}

enum Frame {
    Mapping { path: String, key: Option<String> },
    Sequence { path: String, next: usize },
}

/// Locate a validated JSON pointer using the same YAML parser's node positions.
/// This runs only after bounded deserialization, and never renders source text.
pub(super) fn position(text: &str, pointer: &str) -> Option<(usize, usize)> {
    let mut frames = Vec::new();
    for event in Parser::new_from_str(text) {
        let (event, span) = event.ok()?;
        match event {
            Event::MappingEnd | Event::SequenceEnd => {
                frames.pop();
            }
            Event::Scalar(ref value, ..)
                if matches!(frames.last(), Some(Frame::Mapping { key: None, .. })) =>
            {
                if let Some(Frame::Mapping { key, .. }) = frames.last_mut() {
                    *key = Some(value.to_string());
                }
            }
            Event::Scalar(..) | Event::MappingStart(..) | Event::SequenceStart(..) => {
                let path = match frames.last_mut() {
                    Some(Frame::Mapping { path, key }) => {
                        let key = key.take()?.replace('~', "~0").replace('/', "~1");
                        format!("{path}/{key}")
                    }
                    Some(Frame::Sequence { path, next }) => {
                        let path = format!("{path}/{next}");
                        *next += 1;
                        path
                    }
                    None => String::new(),
                };
                if path == pointer {
                    return Some((span.start.line(), span.start.col() + 1));
                }
                match event {
                    Event::MappingStart(..) => frames.push(Frame::Mapping { path, key: None }),
                    Event::SequenceStart(..) => frames.push(Frame::Sequence { path, next: 0 }),
                    _ => {}
                }
            }
            _ => {}
        }
    }
    None
}
