// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! OpenTofu string templates in both syntaxes. The JSON syntax writes a
//! template as a JSON string whose decoded text is the template's source. The
//! native syntax writes it between quotes, where literal text escapes quotes,
//! backslashes, and control characters, and interpolations keep their own
//! syntax.

/// One part of a template's source.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Part<'a> {
    /// Literal text.
    Text(&'a str),
    /// A literal `${` or `%{`, written `$${` or `%%{`.
    Escape(&'a str),
    /// An interpolation or a directive, from `${` or `%{` through its `}`.
    Sequence(&'a str),
}

/// Why a template's source can't be written in the native syntax.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Unsupported(pub &'static str);

/// Split a template's source into its parts.
pub(crate) fn parts(source: &str) -> Result<Vec<Part<'_>>, Unsupported> {
    let mut parts = Vec::new();
    let mut text = 0;
    let mut index = 0;
    while index < source.len() {
        let rest = &source[index..];
        let (end, escape) = if rest.starts_with("$${") || rest.starts_with("%%{") {
            (index + 3, true)
        } else if rest.starts_with("${") || rest.starts_with("%{") {
            (sequence_end(source, index)?, false)
        } else {
            index += rest.chars().next().map_or(1, char::len_utf8);
            continue;
        };
        if text < index {
            parts.push(Part::Text(&source[text..index]));
        }
        let part = &source[index..end];
        parts.push(if escape {
            Part::Escape(part)
        } else {
            Part::Sequence(part)
        });
        index = end;
        text = end;
    }
    if text < source.len() {
        parts.push(Part::Text(&source[text..]));
    }
    Ok(parts)
}

/// The end of the interpolation or directive that starts at `start`.
fn sequence_end(source: &str, start: usize) -> Result<usize, Unsupported> {
    let bytes = source.as_bytes();
    let mut depth = 1;
    let mut index = start + 2;
    while index < bytes.len() {
        match bytes[index] {
            b'"' => {
                index = string_end(source, index + 1)?;
                continue;
            }
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Ok(index + 1);
                }
            }
            b'#' => return Err(Unsupported("a comment in an interpolation")),
            b'/' if matches!(bytes.get(index + 1), Some(b'/' | b'*')) => {
                return Err(Unsupported("a comment in an interpolation"));
            }
            b'<' if bytes.get(index + 1) == Some(&b'<') => {
                return Err(Unsupported("a heredoc in an interpolation"));
            }
            _ => {}
        }
        index += 1;
    }
    Err(Unsupported("an unterminated interpolation"))
}

/// The end of the quoted string whose text starts at `start`, inside an
/// interpolation. Its own interpolations nest.
fn string_end(source: &str, start: usize) -> Result<usize, Unsupported> {
    let bytes = source.as_bytes();
    let mut index = start;
    while index < bytes.len() {
        let rest = &source[index..];
        if rest.starts_with("$${") || rest.starts_with("%%{") {
            index += 3;
        } else if rest.starts_with("${") || rest.starts_with("%{") {
            index = sequence_end(source, index)?;
        } else {
            match bytes[index] {
                b'\\' => index += 2,
                b'"' => return Ok(index + 1),
                b'\n' => return Err(Unsupported("a line break in a quoted string")),
                _ => index += 1,
            }
        }
    }
    Err(Unsupported("an unterminated string in an interpolation"))
}

/// The native syntax's quoted template for a template's source.
pub(crate) fn quoted(source: &str) -> Result<String, Unsupported> {
    let mut quoted = String::with_capacity(source.len() + 2);
    quoted.push('"');
    for part in parts(source)? {
        match part {
            Part::Text(text) => escape(&mut quoted, text),
            Part::Escape(part) | Part::Sequence(part) => quoted.push_str(part),
        }
    }
    quoted.push('"');
    Ok(quoted)
}

/// The expression of a template that is one interpolation and nothing else,
/// which evaluates to the expression's own value, unconverted.
pub(crate) fn interpolation_only(source: &str) -> Option<&str> {
    match parts(source).ok()?.as_slice() {
        [Part::Sequence(sequence)]
            if sequence.starts_with("${")
                && !sequence.starts_with("${~")
                && !sequence.ends_with("~}") =>
        {
            Some(sequence[2..sequence.len() - 1].trim())
        }
        _ => None,
    }
}

/// A quoted string whose text is literal, with `${` and `%{` escaped.
pub(crate) fn literal(text: &str) -> String {
    quoted(&text.replace("${", "$${").replace("%{", "%%{"))
        .expect("escaped literal text has no interpolations")
}

fn escape(quoted: &mut String, text: &str) {
    for character in text.chars() {
        match character {
            '"' => quoted.push_str("\\\""),
            '\\' => quoted.push_str("\\\\"),
            '\n' => quoted.push_str("\\n"),
            '\r' => quoted.push_str("\\r"),
            '\t' => quoted.push_str("\\t"),
            character if character.is_control() => {
                quoted.push_str(&format!("\\u{:04X}", u32::from(character)));
            }
            character => quoted.push(character),
        }
    }
}

/// Rewrite each literal part of a template's source with `rewrite`, whose
/// result is template source: literal text, or an interpolation it adds.
pub(crate) fn rewrite_text(
    source: &str,
    mut rewrite: impl FnMut(&str) -> String,
) -> Result<String, Unsupported> {
    let mut rewritten = String::with_capacity(source.len());
    for part in parts(source)? {
        match part {
            Part::Text(text) => rewritten.push_str(&rewrite(text)),
            Part::Escape(part) | Part::Sequence(part) => rewritten.push_str(part),
        }
    }
    Ok(rewritten)
}

/// Replace each occurrence of `literal` in `text` with `interpolation`, except
/// after a `$` or `%`, where the interpolation would read as an escape.
pub(crate) fn replace_literal(text: &str, literal: &str, interpolation: &str) -> String {
    if literal.is_empty() {
        return text.to_owned();
    }
    let mut replaced = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(found) = rest.find(literal) {
        let before = &rest[..found];
        replaced.push_str(before);
        let escaped = before.ends_with('$')
            || before.ends_with('%')
            || (before.is_empty() && replaced.ends_with(['$', '%']));
        replaced.push_str(if escaped { literal } else { interpolation });
        rest = &rest[found + literal.len()..];
    }
    replaced.push_str(rest);
    replaced
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn literal_text_escapes_quotes_backslashes_and_line_breaks() {
        assert_eq!(
            quoted("say \"hi\"\\\n\tnow").unwrap(),
            r#""say \"hi\"\\\n\tnow""#
        );
    }

    #[test]
    fn interpolations_keep_their_own_quotes_and_escapes() {
        let source = r#"${format("Gateway \"%s\" is %s", self.name, "a\nb")} and "${x}""#;
        assert_eq!(
            quoted(source).unwrap(),
            r#""${format("Gateway \"%s\" is %s", self.name, "a\nb")} and \"${x}\"""#
        );
    }

    #[test]
    fn nested_templates_and_objects_end_at_their_own_brace() {
        let source = r#"${join(",", [for k, v in { a = "${b}" } : "${k}=${v}"])}!"#;
        assert_eq!(
            parts(source).unwrap(),
            [Part::Sequence(&source[..source.len() - 1]), Part::Text("!"),]
        );
    }

    #[test]
    fn escapes_and_directives_pass_through() {
        assert_eq!(
            quoted("$${literal} %%{also} %{ if x }yes%{ endif }").unwrap(),
            r#""$${literal} %%{also} %{ if x }yes%{ endif }""#
        );
        assert_eq!(quoted("$$${x}").unwrap(), r#""$$${x}""#);
        assert_eq!(parts("$$${x}").unwrap()[1], Part::Escape("$${"));
    }

    #[test]
    fn only_a_lone_interpolation_unwraps() {
        assert_eq!(interpolation_only("${ a.b }"), Some("a.b"));
        assert_eq!(interpolation_only("${a}${b}"), None);
        assert_eq!(interpolation_only("x${a}"), None);
        assert_eq!(interpolation_only("${~a}"), None);
        assert_eq!(interpolation_only("%{ if a }b%{ endif }"), None);
    }

    #[test]
    fn literal_escapes_template_syntax() {
        assert_eq!(literal("${not} %{this}"), r#""$${not} %%{this}""#);
    }

    #[test]
    fn unsupported_interpolations_are_refused() {
        assert!(quoted("${a # comment\n}").is_err());
        assert!(quoted("${<<EOT\nx\nEOT\n}").is_err());
        assert!(quoted("${unterminated").is_err());
    }

    #[test]
    fn rewriting_changes_only_literal_text() {
        let rewritten = rewrite_text("nc-1-${nc-1}-$${x}", |text| {
            replace_literal(text, "nc-1", "${local.workspace}")
        })
        .unwrap();
        assert_eq!(rewritten, "${local.workspace}-${nc-1}-$${x}");
    }

    #[test]
    fn a_dollar_before_a_replacement_keeps_the_literal() {
        assert_eq!(
            replace_literal("a$nc-1 nc-1", "nc-1", "${w}"),
            "a$nc-1 ${w}"
        );
    }
}
