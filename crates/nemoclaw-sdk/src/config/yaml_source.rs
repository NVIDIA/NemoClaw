// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::{ConfigError, Diagnostic};
use serde_saphyr::granit_parser::{Event, Parser, ScalarStyle};
use std::{collections::BTreeMap, ops::ControlFlow};

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
    ConfigError::from(Diagnostic {
        line: Some(line),
        column: Some(column),
        message: message.to_owned(),
        ..Diagnostic::default()
    })
}

enum Frame {
    /// A mapping and, after a key, that key and its position.
    Mapping {
        path: String,
        key: Option<(String, (usize, usize))>,
    },
    Sequence {
        path: String,
        next: usize,
    },
}

/// Where each node of a parsed YAML document starts, by JSON pointer, using the
/// same parser's node positions. It never renders source text.
pub(super) struct Positions(BTreeMap<String, Node>);

struct Node {
    start: (usize, usize),
    /// Where the mapping key that holds the node starts.
    key: Option<(usize, usize)>,
}

impl Positions {
    pub(super) fn of(text: &str) -> Self {
        let mut nodes = BTreeMap::new();
        walk::<()>(text, |pointer, start, key| {
            nodes.insert(pointer.to_owned(), Node { start, key });
            ControlFlow::Continue(())
        });
        Self(nodes)
    }

    /// Where the value at `pointer` starts or, when the text doesn't write it,
    /// its nearest ancestor that the text writes.
    pub(super) fn value(&self, mut pointer: &str) -> Option<(usize, usize)> {
        loop {
            if let Some(node) = self.0.get(pointer) {
                return Some(node.start);
            }
            pointer = &pointer[..pointer.rfind('/')?];
        }
    }

    /// Where the mapping key that holds the value at `pointer` starts, or the
    /// value itself when a sequence holds it.
    pub(super) fn key(&self, pointer: &str) -> Option<(usize, usize)> {
        self.0
            .get(pointer)
            .map(|node| node.key.unwrap_or(node.start))
    }
}

/// Visits each node with its JSON pointer, where it starts, and where the
/// mapping key that holds it starts, until `visit` breaks.
fn walk<B>(
    text: &str,
    mut visit: impl FnMut(&str, (usize, usize), Option<(usize, usize)>) -> ControlFlow<B>,
) -> Option<B> {
    let mut frames = Vec::new();
    for event in Parser::new_from_str(text) {
        let (event, span) = event.ok()?;
        let start = (span.start.line(), span.start.col() + 1);
        match event {
            Event::MappingEnd | Event::SequenceEnd => {
                frames.pop();
            }
            Event::Scalar(ref value, ..)
                if matches!(frames.last(), Some(Frame::Mapping { key: None, .. })) =>
            {
                if let Some(Frame::Mapping { key, .. }) = frames.last_mut() {
                    *key = Some((value.to_string(), start));
                }
            }
            Event::Scalar(..) | Event::MappingStart(..) | Event::SequenceStart(..) => {
                let (path, key_start) = match frames.last_mut() {
                    Some(Frame::Mapping { path, key }) => {
                        let (key, key_start) = key.take()?;
                        let key = key.replace('~', "~0").replace('/', "~1");
                        (format!("{path}/{key}"), Some(key_start))
                    }
                    Some(Frame::Sequence { path, next }) => {
                        let path = format!("{path}/{next}");
                        *next += 1;
                        (path, None)
                    }
                    None => (String::new(), None),
                };
                if let ControlFlow::Break(found) = visit(&path, start, key_start) {
                    return Some(found);
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
