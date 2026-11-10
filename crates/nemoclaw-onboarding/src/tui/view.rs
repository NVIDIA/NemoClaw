// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::{
    app::JourneyWizard,
    labels::{self, terminal_text},
    logo::BrandImage,
    summary::{self, Facts},
};
use nemoclaw_authoring::{CompatibilityStatus, DiscoveryAssessment, JourneyQuestion};
use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Paragraph, Scrollbar, ScrollbarOrientation, ScrollbarState, Wrap},
};
use serde_json::Value;

/// Terminals shorter than this get the one-line wordmark, so questions and
/// the review keep their room.
const FULL_WORDMARK_HEIGHT: u16 = 50;
const NVIDIA_GREEN: Color = Color::Rgb(118, 185, 0);
const BRIGHT_GREEN: Color = Color::Rgb(163, 230, 53);
const DIM: Color = Color::Rgb(82, 121, 84);
const MUTED: Color = Color::Rgb(126, 145, 128);
const WHITE: Color = Color::Rgb(238, 245, 238);
pub(super) const WARNING: Color = Color::Rgb(255, 170, 70);
pub(super) const ERROR: Color = Color::Rgb(255, 95, 95);
const LOGO_GRADIENT: [Color; 6] = [
    Color::Rgb(180, 246, 72),
    Color::Rgb(154, 226, 51),
    Color::Rgb(128, 205, 31),
    Color::Rgb(105, 183, 24),
    Color::Rgb(82, 157, 28),
    Color::Rgb(61, 128, 31),
];
const TEXTURE_GRADIENT: [Color; 7] = [
    Color::Rgb(35, 75, 38),
    Color::Rgb(49, 105, 39),
    Color::Rgb(70, 139, 36),
    Color::Rgb(95, 174, 31),
    Color::Rgb(118, 185, 0),
    Color::Rgb(145, 213, 37),
    Color::Rgb(174, 238, 72),
];

impl JourneyWizard {
    #[cfg(test)]
    pub(super) fn render(&self, frame: &mut Frame<'_>) {
        self.render_with_brand(frame, None);
    }

    pub(super) fn render_with_brand(&self, frame: &mut Frame<'_>, brand: Option<BrandImage>) {
        let area = frame.area();
        frame.render_widget(
            Block::new().style(Style::new().bg(Color::Rgb(5, 10, 7))),
            area,
        );
        if area.width < 72 || area.height < 24 {
            frame.render_widget(
                Paragraph::new(
                    "NEMOCLAW\n\nThis experience needs a 72 × 24 terminal.\nResize to continue.",
                )
                .style(Style::new().fg(NVIDIA_GREEN)),
                area,
            );
            return;
        }
        let margin = if area.width >= 96 { 4 } else { 2 };
        let body = Rect::new(
            area.x.saturating_add(margin),
            area.y,
            area.width.saturating_sub(margin * 2),
            area.height,
        );
        let current = self.question();
        let reviewing = self.reviewing();
        // The review leads with what it saves, so it always takes the room.
        let compact = reviewing || area.height < FULL_WORDMARK_HEIGHT;
        let rows = Layout::vertical([
            Constraint::Length(if compact { 2 } else { 8 }),
            Constraint::Length(1),
            Constraint::Min(10),
            Constraint::Length(2),
        ])
        .split(body);
        self.render_logo(frame, rows[0], brand.filter(|_| body.width >= 80), compact);
        let asking = self.started && matches!(&current, Ok(Some(_)));
        let mut lines = if !self.started {
            welcome()
        } else if let Err(error) = &current {
            vec![
                Line::from(Span::styled(
                    terminal_text(&error.to_string()),
                    Style::new().fg(WARNING),
                )),
                Line::from(""),
                Line::from(Span::styled(
                    "The questionnaire cannot continue. Press ← to go back or Esc to cancel.",
                    Style::new().fg(MUTED),
                )),
            ]
        } else if let Ok(Some(question)) = current.as_ref() {
            self.question_lines(question, rows[2].width)
        } else {
            // The review's scrollbar takes the last column.
            self.review_lines(rows[2].width.saturating_sub(1))
        };
        // Review lists them after the target, so the verdict opens the screen.
        if self.started
            && !reviewing
            && let Ok(resolution) = self.resolution()
            && !resolution.information().is_empty()
        {
            let mut information = resolution
                .information()
                .iter()
                .map(|note| Line::from(Span::styled(terminal_text(note), Style::new().fg(MUTED))))
                .collect::<Vec<_>>();
            information.push(Line::from(""));
            information.append(&mut lines);
            lines = information;
        }
        let content = Paragraph::new(lines).wrap(Wrap { trim: false });
        if reviewing {
            self.render_review(frame, rows[2], content);
        } else {
            frame.render_widget(content, rows[2]);
        }
        let optional = matches!(&current, Ok(Some(question)) if question.omittable());
        let entry = match &current {
            Ok(Some(question)) if !question.choices().is_empty() && !self.custom_answer => {
                "↑/↓  choose"
            }
            Ok(Some(question)) if self.input.is_empty() && self.placeholder(question).is_some() => {
                "Tab  edit suggestion"
            }
            _ => "Type to answer",
        };
        self.render_footer(frame, rows[3], reviewing, asking, entry, optional);
    }

    /// Draw the scrolled review with a scrollbar when it exceeds `area`. The
    /// offset is clamped here as well as when scrolling, because a resize can
    /// shrink the limit after the last key press.
    fn render_review(&self, frame: &mut Frame<'_>, area: Rect, content: Paragraph<'_>) {
        // The scrollbar takes the last column, so the text wraps one short.
        let text = Rect {
            width: area.width.saturating_sub(1),
            ..area
        };
        let height = content.line_count(text.width);
        let limit =
            u16::try_from(height.saturating_sub(usize::from(text.height))).unwrap_or(u16::MAX);
        self.review_scroll_limit.set(limit);
        let offset = self.review_scroll.min(limit);
        frame.render_widget(content.scroll((offset, 0)), text);
        if limit > 0 {
            let mut scrollbar = ScrollbarState::new(usize::from(limit))
                .position(usize::from(offset))
                .viewport_content_length(usize::from(text.height));
            frame.render_stateful_widget(
                Scrollbar::new(ScrollbarOrientation::VerticalRight)
                    .begin_symbol(None)
                    .end_symbol(None)
                    .track_symbol(Some("│"))
                    .thumb_symbol("┃")
                    .style(Style::new().fg(DIM)),
                area,
                &mut scrollbar,
            );
        }
    }

    fn question_lines(&self, question: &JourneyQuestion, width: u16) -> Vec<Line<'static>> {
        let mut title = vec![Span::styled(
            terminal_text(&labels::title(question)),
            Style::new().fg(WHITE).add_modifier(Modifier::BOLD),
        )];
        // The resolver reveals later questions as answers arrive, so there is
        // no stable total to show.
        title.extend([
            Span::raw("  "),
            Span::styled(
                format!("⟦ {} ⟧", self.history.len() + 1),
                Style::new().fg(DIM),
            ),
        ]);
        let mut lines = vec![Line::from(title)];
        if let Some(service) = labels::service(question) {
            lines.push(Line::from(Span::styled(
                format!("Service: {}", terminal_text(service)),
                Style::new().fg(MUTED),
            )));
        }
        lines.push(Line::from(""));
        if let Some(description) = labels::description(question) {
            lines.push(Line::from(Span::styled(
                terminal_text(&description),
                Style::new().fg(MUTED),
            )));
        }
        lines.push(Line::from(Span::styled(
            format!(
                "{}  ·  {}",
                if question.required() {
                    "Required"
                } else {
                    "Optional"
                },
                terminal_text(question.id())
            ),
            Style::new().fg(DIM),
        )));
        if let Some(cause) = question.reopened_because() {
            lines.push(Line::from(Span::styled(
                format!(
                    "Recheck this answer because {} changed.",
                    terminal_text(cause)
                ),
                Style::new().fg(WARNING),
            )));
        }
        if let Some(note) = question.note() {
            lines.push(Line::from(Span::styled(
                terminal_text(note),
                Style::new().fg(WARNING),
            )));
        }
        lines.push(Line::from(""));
        if question.choices().is_empty() || self.custom_answer {
            let cursor = Span::styled("▌", Style::new().fg(BRIGHT_GREEN));
            let suggested = self.placeholder(question);
            let hint = match (&suggested, self.input.is_empty()) {
                // The cursor comes first and the text says what the value is,
                // so a placeholder never reads as typed text, even without colour.
                (Some(suggested), true) => {
                    lines.push(Line::from(vec![
                        cursor,
                        Span::styled(terminal_text(suggested), Style::new().fg(MUTED)),
                        Span::styled("  (suggested)", Style::new().fg(DIM)),
                    ]));
                    Some(if question.omittable() {
                        "Enter accepts the suggestion · Tab edits it · typing replaces it · Ctrl+O omits it"
                    } else {
                        "Enter accepts the suggestion · Tab edits it · typing replaces it"
                    })
                }
                (suggested, _) => {
                    lines.push(Line::from(vec![
                        Span::styled(terminal_text(&self.input), Style::new().fg(WHITE)),
                        cursor,
                    ]));
                    suggested
                        .is_some()
                        .then_some("Delete the text to use the suggestion again.")
                }
            };
            lines.push(Line::from(Span::styled(
                "─".repeat(width as usize),
                Style::new().fg(BRIGHT_GREEN),
            )));
            if let Some(hint) = hint {
                lines.push(Line::from(Span::styled(hint, Style::new().fg(MUTED))));
            }
        } else {
            let selected = self.choice_index(question);
            let mut choices = question
                .choices()
                .iter()
                .map(|value| labels::choice(question, value))
                .collect::<Vec<_>>();
            if question.allows_custom_answer() {
                choices.push("Type another model".into());
            }
            if question.omittable() {
                choices.push("Omit".into());
            }
            lines.extend(
                choices
                    .iter()
                    .enumerate()
                    .map(|(index, value)| choice_line(value, index == selected)),
            );
        }
        lines
    }

    /// The review, with the open configuration file wrapped to `width`.
    pub(super) fn review_lines(&self, width: u16) -> Vec<Line<'static>> {
        let mut lines = vec![
            Line::from(Span::styled(
                "Review your deployment",
                Style::new().fg(WHITE).add_modifier(Modifier::BOLD),
            )),
            Line::from(""),
        ];
        let resolution = match self.resolution() {
            Ok(resolution) => resolution,
            Err(error) => {
                lines.push(Line::from(Span::styled(
                    terminal_text(&error.to_string()),
                    Style::new().fg(WARNING),
                )));
                return lines;
            }
        };
        let assessment = resolution.target_assessment();
        // A target that blocks saving without a conflict is one the journey
        // requires compatible evidence from.
        let blocked = assessment.is_some_and(|assessment| {
            assessment.status == CompatibilityStatus::Conflict
                || (resolution.materialized_document().is_some()
                    && resolution.ready_document().is_none())
        });
        // What prevents saving leads the screen; otherwise the target's
        // verdict is in the Image row and its reasons follow the summary.
        if let Some(assessment) = assessment.filter(|_| blocked) {
            lines.extend(target_lines(assessment, true));
            lines.push(Line::from(""));
        }
        let Some(document) = resolution.materialized_document() else {
            if let Some(assessment) = assessment.filter(|_| !blocked) {
                lines.extend(target_lines(assessment, false));
                lines.push(Line::from(""));
            }
            lines.extend(resolution.unverified().iter().map(|warning| {
                Line::from(Span::styled(
                    terminal_text(warning),
                    Style::new().fg(WARNING),
                ))
            }));
            lines.extend(
                resolution
                    .assessment()
                    .issues()
                    .iter()
                    .take(5)
                    .map(|issue| {
                        Line::from(Span::styled(
                            terminal_text(&format!("{}: {}", issue.path(), issue.rule())),
                            Style::new().fg(WARNING),
                        ))
                    }),
            );
            lines.extend(template_value_lines(resolution.kept()));
            return lines;
        };
        let facts = Facts {
            observations: self.observations(),
            target: assessment.map(|assessment| assessment.status),
            output: self.output.as_deref(),
        };
        lines.extend(
            summary::rows(document, &facts)
                .iter()
                .flat_map(summary_lines),
        );
        lines.push(Line::from(""));
        if let Some(assessment) = assessment.filter(|_| !blocked)
            && !assessment.reasons.is_empty()
        {
            let color = if assessment.status == CompatibilityStatus::Unverified {
                WARNING
            } else {
                MUTED
            };
            lines.extend(assessment.reasons.iter().map(|reason| {
                Line::from(Span::styled(terminal_text(reason), Style::new().fg(color)))
            }));
            lines.push(Line::from(""));
        }
        if !resolution.information().is_empty() {
            lines.extend(
                resolution.information().iter().map(|note| {
                    Line::from(Span::styled(terminal_text(note), Style::new().fg(MUTED)))
                }),
            );
            lines.push(Line::from(""));
        }
        match self.configuration() {
            Some(Ok(yaml)) => lines.extend(self.configuration_lines(&yaml, width)),
            Some(Err(reason)) => lines.push(Line::from(Span::styled(
                terminal_text(&format!("Cannot save: {reason}")),
                Style::new().fg(ERROR),
            ))),
            None => {}
        }
        lines.extend(template_value_lines(resolution.kept()));
        if self.saveable() {
            lines.push(Line::from(""));
            lines.push(Line::from(Span::styled(
                "Press Enter to save.",
                Style::new().fg(MUTED),
            )));
        }
        lines
    }

    /// The saved YAML as a box under the summary: one line while collapsed,
    /// the complete file behind a rule while open.
    fn configuration_lines(&self, yaml: &str, width: u16) -> Vec<Line<'static>> {
        let count = yaml.lines().count();
        let (marker, hint) = if self.show_configuration {
            ("▾", "Tab hides it".to_owned())
        } else {
            ("▸", format!("{count} lines · Tab shows it"))
        };
        let mut lines = vec![Line::from(vec![
            Span::styled(format!("{marker} "), Style::new().fg(BRIGHT_GREEN)),
            Span::styled(
                "Configuration file",
                Style::new().fg(WHITE).add_modifier(Modifier::BOLD),
            ),
            Span::styled(format!("  {hint}"), Style::new().fg(DIM)),
        ])];
        if self.show_configuration {
            lines.extend(
                yaml.lines()
                    .flat_map(|line| ruled_lines(line, width.into())),
            );
            lines.push(Line::from(Span::styled("╰─", Style::new().fg(DIM))));
        }
        lines
    }

    fn render_footer(
        &self,
        frame: &mut Frame<'_>,
        area: Rect,
        reviewing: bool,
        asking: bool,
        entry: &str,
        optional: bool,
    ) {
        let rows = Layout::vertical([Constraint::Length(1); 2]).split(area);
        let controls = if !self.started {
            "Enter  begin     Esc  exit".to_owned()
        } else if reviewing {
            format!(
                "{}↑/↓  scroll     Tab  file     ←  back     Esc  exit",
                if self.saveable() {
                    "Enter  save     "
                } else {
                    ""
                }
            )
        } else {
            format!("{entry}     Enter  continue     ←  back     Esc  exit")
        };
        let (controls, color) = match &self.error {
            Some(error) => (terminal_text(error), WARNING),
            None => (controls, MUTED),
        };
        frame.render_widget(
            Paragraph::new(controls).style(Style::new().fg(color)),
            rows[0],
        );
        // Omission shares the second row, so the first fits a 72-column terminal.
        if asking {
            frame.render_widget(
                Paragraph::new(format!(
                    "{}Ctrl+D  choose remaining settings and review",
                    if optional { "Ctrl+O  omit     " } else { "" }
                ))
                .style(Style::new().fg(MUTED)),
                rows[1],
            );
        }
    }

    fn render_logo(
        &self,
        frame: &mut Frame<'_>,
        area: Rect,
        brand: Option<BrandImage>,
        compact: bool,
    ) {
        if compact {
            // The brand image spans two rows: the wordmark and the texture.
            let mut wordmark = Vec::new();
            let mut texture = Vec::new();
            if let Some(brand) = brand {
                wordmark.extend([brand.placeholder(0), Span::raw("  ")]);
                texture.extend([brand.placeholder(1), Span::raw("  ")]);
            }
            wordmark.push(Span::styled(
                "NEMOCLAW",
                Style::new()
                    .fg(LOGO_GRADIENT[0])
                    .add_modifier(Modifier::BOLD),
            ));
            let used = if brand.is_some() { 8 } else { 0 };
            texture.extend(texture_line((area.width as usize).saturating_sub(used)).spans);
            frame.render_widget(
                Paragraph::new(vec![Line::from(wordmark), Line::from(texture)]),
                area,
            );
            return;
        }
        let rows = [
            "███╗   ██╗███████╗███╗   ███╗ ██████╗  ██████╗██╗      █████╗ ██╗    ██╗",
            "████╗  ██║██╔════╝████╗ ████║██╔═══██╗██╔════╝██║     ██╔══██╗██║    ██║",
            "██╔██╗ ██║█████╗  ██╔████╔██║██║   ██║██║     ██║     ███████║██║ █╗ ██║",
            "██║╚██╗██║██╔══╝  ██║╚██╔╝██║██║   ██║██║     ██║     ██╔══██║██║███╗██║",
            "██║ ╚████║███████╗██║ ╚═╝ ██║╚██████╔╝╚██████╗███████╗██║  ██║╚███╔███╔╝",
            "╚═╝  ╚═══╝╚══════╝╚═╝     ╚═╝ ╚═════╝  ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝ ",
        ];
        let mut lines = vec![Line::from("")];
        for (index, row) in rows.into_iter().enumerate() {
            let mut spans = Vec::new();
            if let Some(brand) = brand {
                if (2..=3).contains(&index) {
                    spans.push(brand.placeholder(index - 2));
                } else {
                    spans.push(Span::raw("      "));
                }
                spans.push(Span::raw("  "));
            }
            spans.push(Span::styled(row, Style::new().fg(LOGO_GRADIENT[index])));
            lines.push(Line::from(spans));
        }
        lines.push(texture_line(area.width as usize));
        frame.render_widget(Paragraph::new(lines), area);
    }
}

fn welcome() -> Vec<Line<'static>> {
    let muted = |text: &'static str| Line::from(Span::styled(text, Style::new().fg(MUTED)));
    vec![
        Line::from(Span::styled(
            "Welcome to NemoClaw",
            Style::new().fg(WHITE).add_modifier(Modifier::BOLD),
        )),
        Line::from(""),
        muted("Create desired state for an isolated sandbox."),
        Line::from(""),
        muted("Review deployment settings and author deployment YAML."),
        muted("Nothing is installed or started yet."),
        Line::from(""),
        muted("Press Enter to begin."),
    ]
}

fn choice_line(value: &str, active: bool) -> Line<'static> {
    Line::from(vec![
        Span::styled(
            if active { "  ●  " } else { "  ○  " },
            Style::new().fg(if active { BRIGHT_GREEN } else { MUTED }),
        ),
        Span::styled(
            terminal_text(value),
            if active {
                Style::new().fg(WHITE).add_modifier(Modifier::BOLD)
            } else {
                Style::new().fg(MUTED)
            },
        ),
    ])
}

/// One YAML line behind the box's rule, wrapped here so every row keeps the
/// rule. Continuation rows start with `↪` past the line's own indentation,
/// so they don't read as lines of the file.
fn ruled_lines(line: &str, width: usize) -> Vec<Line<'static>> {
    const GUTTER: usize = 2;
    const MARKER: &str = "↪ ";
    let room = width.saturating_sub(GUTTER).max(1);
    let indent = (line.len() - line.trim_start().len()).min(room / 2);
    let gutter = || Span::styled("│ ", Style::new().fg(DIM));
    let continuation = || {
        vec![
            gutter(),
            Span::raw(" ".repeat(indent)),
            Span::styled(MARKER, Style::new().fg(DIM)),
        ]
    };
    let indent = indent + MARKER.chars().count();
    let mut rows = Vec::new();
    let mut row = vec![gutter()];
    let mut used = 0;
    for span in yaml_line(line).spans {
        let mut text = String::new();
        for character in span.content.chars() {
            let cells = Span::raw(character.to_string()).width();
            if used > 0 && used + cells > room {
                if !text.is_empty() {
                    row.push(Span::styled(std::mem::take(&mut text), span.style));
                }
                rows.push(Line::from(std::mem::replace(&mut row, continuation())));
                used = indent;
            }
            text.push(character);
            used += cells;
        }
        if !text.is_empty() {
            row.push(Span::styled(text, span.style));
        }
    }
    rows.push(Line::from(row));
    rows
}

/// Mute YAML keys so the authored values stand out.
fn yaml_line(line: &str) -> Line<'static> {
    let line = terminal_text(line);
    let body = line.trim_start().trim_start_matches("- ");
    let key_end = body
        .find(": ")
        .or_else(|| body.ends_with(':').then(|| body.len() - 1))
        .filter(|&end| {
            body[..end]
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
        });
    match key_end {
        Some(end) => {
            let split = line.len() - body.len() + end + 1;
            Line::from(vec![
                Span::styled(line[..split].to_owned(), Style::new().fg(MUTED)),
                Span::styled(line[split..].to_owned(), Style::new().fg(WHITE)),
            ])
        }
        None => Line::from(Span::styled(line, Style::new().fg(WHITE))),
    }
}

fn texture_line(width: usize) -> Line<'static> {
    const CELLS: [char; 14] = [
        '⠁', '⠃', '⠇', '⡇', '⣇', '⣧', '⣷', '⣿', '⣾', '⣼', '⣸', '⢸', '⠸', '⠘',
    ];
    Line::from(
        (0..width)
            .map(|column| {
                let wave = column % CELLS.len();
                let color = TEXTURE_GRADIENT[(column / 7) % TEXTURE_GRADIENT.len()];
                Span::styled(CELLS[wave].to_string(), Style::new().fg(color))
            })
            .collect::<Vec<_>>(),
    )
}

/// The target's status and every reason. A reason that blocks saving is an
/// error; one that only leaves the target unverified is a warning.
fn target_lines(assessment: &DiscoveryAssessment, blocked: bool) -> Vec<Line<'static>> {
    let color = match (blocked, assessment.status) {
        (true, _) => ERROR,
        (false, CompatibilityStatus::Unverified) => WARNING,
        (false, _) => MUTED,
    };
    let mut lines = vec![Line::from(Span::styled(
        format!("Target: {:?}", assessment.status),
        Style::new().fg(color).add_modifier(Modifier::BOLD),
    ))];
    lines.extend(
        assessment
            .reasons
            .iter()
            .map(|reason| Line::from(Span::styled(terminal_text(reason), Style::new().fg(color)))),
    );
    lines
}

/// A summary row: the label in a column, the value, then its status.
fn summary_lines(row: &summary::Row) -> Vec<Line<'static>> {
    let mut spans = vec![
        Span::styled(format!("  {:<10} ", row.label), Style::new().fg(MUTED)),
        Span::styled(terminal_text(&row.value), Style::new().fg(WHITE)),
    ];
    if let Some(status) = &row.status {
        spans.push(Span::styled(" · ", Style::new().fg(MUTED)));
        spans.push(Span::styled(
            terminal_text(&status.text),
            Style::new().fg(if status.attention { WARNING } else { MUTED }),
        ));
    }
    let mut lines = vec![Line::from(spans)];
    if let Some(detail) = &row.detail {
        lines.push(Line::from(vec![
            Span::raw(" ".repeat(13)),
            Span::styled(terminal_text(detail), Style::new().fg(MUTED)),
        ]));
    }
    lines
}

/// Template values that omission kept without a question, so the person sees
/// where their template replaced a default.
fn template_value_lines(kept: &[(String, Value)]) -> Vec<Line<'static>> {
    if kept.is_empty() {
        return Vec::new();
    }
    let mut lines = vec![
        Line::from(""),
        Line::from(Span::styled(
            "From your template:",
            Style::new().fg(WHITE).add_modifier(Modifier::BOLD),
        )),
    ];
    lines.extend(kept.iter().map(|(id, value)| {
        Line::from(Span::styled(
            terminal_text(&format!(
                "{}: {}",
                labels::readable(id),
                labels::display_value(value)
            )),
            Style::new().fg(MUTED),
        ))
    }));
    lines
}
