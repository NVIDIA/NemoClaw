// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::{
    app::{Step, Wizard},
    labels,
};
use nemoclaw_authoring::ProviderPreset;
use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span, Text},
    widgets::{Block, Borders, Paragraph, Wrap},
};

const NVIDIA_GREEN: Color = Color::Rgb(118, 185, 0);
const BRIGHT_GREEN: Color = Color::Rgb(163, 230, 53);
const DEEP_GREEN: Color = Color::Rgb(15, 35, 18);
const MUTED: Color = Color::Rgb(126, 145, 128);
const WHITE: Color = Color::Rgb(238, 245, 238);
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

impl Wizard {
    pub(crate) fn render(&self, frame: &mut Frame<'_>) {
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
        let content_height = 10;
        let rows = Layout::vertical([
            Constraint::Length(8),
            Constraint::Min(content_height),
            Constraint::Length(if self.target_status.is_some() { 4 } else { 0 }),
            Constraint::Length(if self.can_offer_delegation() { 3 } else { 2 }),
        ])
        .split(body);
        self.render_logo(frame, rows[0]);
        self.render_question(frame, rows[1]);
        if let Some(status) = &self.target_status {
            frame.render_widget(
                Paragraph::new(status.as_str())
                    .style(Style::new().fg(MUTED))
                    .wrap(Wrap { trim: true }),
                rows[2],
            );
        }
        self.render_footer(frame, rows[3]);
    }

    fn render_logo(&self, frame: &mut Frame<'_>, area: Rect) {
        let rows = [
            "███╗   ██╗███████╗███╗   ███╗ ██████╗  ██████╗██╗      █████╗ ██╗    ██╗",
            "████╗  ██║██╔════╝████╗ ████║██╔═══██╗██╔════╝██║     ██╔══██╗██║    ██║",
            "██╔██╗ ██║█████╗  ██╔████╔██║██║   ██║██║     ██║     ███████║██║ █╗ ██║",
            "██║╚██╗██║██╔══╝  ██║╚██╔╝██║██║   ██║██║     ██║     ██╔══██║██║███╗██║",
            "██║ ╚████║███████╗██║ ╚═╝ ██║╚██████╔╝╚██████╗███████╗██║  ██║╚███╔███╔╝",
            "╚═╝  ╚═══╝╚══════╝╚═╝     ╚═╝ ╚═════╝  ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝ ",
        ];
        let mut lines = vec![Line::from("")];
        lines.extend(rows.into_iter().enumerate().map(|(index, row)| {
            Line::from(Span::styled(row, Style::new().fg(LOGO_GRADIENT[index])))
        }));
        lines.push(texture_line(area.width as usize));
        frame.render_widget(Paragraph::new(Text::from(lines)), area);
    }

    fn render_question(&self, frame: &mut Frame<'_>, area: Rect) {
        let area = Rect::new(
            area.x,
            area.y.saturating_add(1),
            area.width,
            area.height.saturating_sub(1),
        );
        if self.pending_edit.is_some() {
            frame.render_widget(
                Paragraph::new(self.conflict_message())
                    .style(Style::new().fg(WHITE))
                    .wrap(Wrap { trim: true }),
                area,
            );
        } else if self.step == Step::Welcome {
            self.render_welcome(frame, area);
        } else if self.step == Step::Review {
            self.render_review(frame, area);
        } else {
            let rows = Layout::vertical([
                Constraint::Length(2),
                Constraint::Length(3),
                Constraint::Min(4),
            ])
            .split(area);
            let mut title = vec![Span::styled(
                self.title(),
                Style::new().fg(WHITE).add_modifier(Modifier::BOLD),
            )];
            if let Some((position, total)) = self.progress() {
                title.extend([
                    Span::raw("  "),
                    Span::styled(
                        format!("⟦ {position}/{total} ⟧"),
                        Style::new().fg(Color::Rgb(82, 121, 84)),
                    ),
                ]);
            }
            frame.render_widget(Paragraph::new(Line::from(title)), rows[0]);
            frame.render_widget(
                Paragraph::new(self.help())
                    .style(Style::new().fg(MUTED))
                    .wrap(Wrap { trim: true }),
                rows[1],
            );
            if self.is_choice() {
                self.render_choices(frame, rows[2]);
            } else {
                self.render_input(frame, rows[2]);
            }
        }
    }

    fn render_welcome(&self, frame: &mut Frame<'_>, area: Rect) {
        frame.render_widget(
            Paragraph::new(vec![
                Line::from(Span::styled(
                    "Welcome to NemoClaw",
                    Style::new().fg(WHITE).add_modifier(Modifier::BOLD),
                )),
                Line::from(""),
                Line::from(Span::styled(
                    "NemoClaw runs an AI agent inside an isolated sandbox.",
                    Style::new().fg(MUTED),
                )),
                Line::from(""),
                Line::from(Span::styled(
                    "Choose an agent, Docker or Podman, and hosted inference.",
                    Style::new().fg(MUTED),
                )),
                Line::from(Span::styled(
                    "Press Enter to keep each suggested answer.",
                    Style::new().fg(MUTED),
                )),
                Line::from(""),
                Line::from(Span::styled(
                    "Review your choices and save a deployment YAML file.",
                    Style::new().fg(MUTED),
                )),
                Line::from(Span::styled(
                    "Nothing is installed or started yet.",
                    Style::new().fg(MUTED),
                )),
            ]),
            area,
        );
    }

    fn render_choices(&self, frame: &mut Frame<'_>, area: Rect) {
        let area = if let Some(error) = &self.error {
            let rows = Layout::vertical([Constraint::Min(1), Constraint::Length(3)]).split(area);
            frame.render_widget(
                Paragraph::new(error.as_str())
                    .style(Style::new().fg(Color::Rgb(255, 170, 70)))
                    .wrap(Wrap { trim: true }),
                rows[1],
            );
            rows[0]
        } else {
            area
        };
        let labels = self.choice_labels();
        let visible = area.height as usize;
        let start = self
            .selected
            .saturating_sub(visible.saturating_sub(1))
            .min(labels.len().saturating_sub(visible));
        let lines = labels
            .into_iter()
            .enumerate()
            .skip(start)
            .take(visible)
            .map(|(index, label)| {
                let active = index == self.selected;
                let unavailable = self.choice_unavailable_reason(index);
                let label = match unavailable {
                    Some(reason) => format!("{label} (unavailable: {reason})"),
                    None => label,
                };
                Line::from(vec![
                    Span::styled(
                        if unavailable.is_some() {
                            "  ×  "
                        } else if active {
                            "  ●  "
                        } else {
                            "  ○  "
                        },
                        Style::new().fg(if active { BRIGHT_GREEN } else { MUTED }),
                    ),
                    Span::styled(
                        terminal_text(&label),
                        Style::new()
                            .fg(if active && unavailable.is_none() {
                                WHITE
                            } else {
                                MUTED
                            })
                            .add_modifier(if active {
                                Modifier::BOLD
                            } else {
                                Modifier::empty()
                            }),
                    ),
                ])
            })
            .collect::<Vec<_>>();
        frame.render_widget(Paragraph::new(lines), area);
    }

    fn render_input(&self, frame: &mut Frame<'_>, area: Rect) {
        let field = Rect::new(area.x, area.y, area.width, 3.min(area.height));
        frame.render_widget(
            Paragraph::new(self.input.as_str())
                .style(Style::new().fg(WHITE))
                .block(
                    Block::new()
                        .borders(Borders::BOTTOM)
                        .border_style(Style::new().fg(BRIGHT_GREEN)),
                ),
            field,
        );
        let cursor_x = field
            .x
            .saturating_add(self.input.chars().count().min(field.width as usize - 1) as u16);
        frame.set_cursor_position((cursor_x, field.y));
        if let Some(error) = &self.error {
            let error_area = Rect::new(
                area.x,
                area.y.saturating_add(3),
                area.width,
                area.height.saturating_sub(3),
            );
            frame.render_widget(
                Paragraph::new(format!("▲ {error}"))
                    .style(Style::new().fg(Color::Rgb(255, 170, 70)))
                    .wrap(Wrap { trim: true }),
                error_area,
            );
        }
    }

    fn render_review(&self, frame: &mut Frame<'_>, area: Rect) {
        let answers = self
            .draft
            .guided_answers(&self.capabilities)
            .expect("wizard retains a guided document");
        let mut lines = Vec::new();
        if self.draft.has_delegated_answers() {
            lines.push(Line::from(
                "Remaining suggestions chosen with your permission.",
            ));
        }
        for credential in &self.facts.credentials {
            if credential.status == nemoclaw_sdk::discovery::ObservationStatus::Unavailable {
                lines.push(Line::from(Span::styled(
                    format!(
                        "Set {} before applying.",
                        terminal_text(&credential.reference)
                    ),
                    Style::new().fg(Color::Rgb(255, 170, 70)),
                )));
            }
        }
        lines.extend(review_field("Deployment", &answers.deployment_name));
        lines.extend(review_field("Harness", labels::harness(&answers.harness)));
        if let Some(settings) = &answers.harness_settings {
            for (name, value) in settings {
                lines.push(Line::from(format!("{name}: {value}")));
            }
        }

        lines.extend(review_field("Runtime", labels::runtime(answers.runtime)));
        lines.extend(review_field(
            "Provider",
            labels::inference(answers.inference),
        ));
        lines.extend(review_field("API", labels::api(answers.api)));
        lines.extend(review_field("Model", &answers.model));
        if matches!(
            answers.inference,
            ProviderPreset::OpenAiCompatible | ProviderPreset::AnthropicCompatible
        ) {
            lines.extend(review_field("Endpoint", &answers.endpoint));
        }
        if let Some(error) = &self.error {
            lines.push(Line::from(""));
            lines.push(Line::from(Span::styled(
                error.as_str(),
                Style::new().fg(Color::Rgb(255, 170, 70)),
            )));
        }
        frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: true }), area);
    }

    fn render_footer(&self, frame: &mut Frame<'_>, area: Rect) {
        let controls = if self.pending_edit.is_some() {
            "Enter  revise affected answers     ←  keep current answers     Esc  exit"
        } else {
            match self.step {
                Step::Welcome => "Enter  begin     Esc  exit",
                Step::Review => "Enter  author YAML     ←  back     Esc  exit",
                _ if self.is_choice() => {
                    "↑/↓  choose     Enter  continue     ←  back     Esc  exit"
                }
                _ => "Type to replace     Enter  continue     ←  back     Esc exit",
            }
        };
        let rows = Layout::vertical([
            Constraint::Length(1),
            Constraint::Length(u16::from(self.can_offer_delegation())),
            Constraint::Length(1),
        ])
        .split(area);
        frame.render_widget(
            Paragraph::new(controls).style(Style::new().fg(MUTED)),
            rows[0],
        );
        if self.can_offer_delegation() {
            frame.render_widget(
                Paragraph::new("Ctrl+D  choose remaining settings and review")
                    .style(Style::new().fg(MUTED)),
                rows[1],
            );
        }
        if let Some((position, total)) = self.progress() {
            let width = rows[2].width as usize;
            let filled = width.saturating_mul(position) / total;
            frame.render_widget(
                Paragraph::new(Line::from(vec![
                    Span::styled("▄".repeat(filled), Style::new().fg(Color::Rgb(82, 135, 49))),
                    Span::styled(
                        "▄".repeat(width.saturating_sub(filled)),
                        Style::new().fg(DEEP_GREEN),
                    ),
                ])),
                rows[2],
            );
        }
    }

    fn progress(&self) -> Option<(usize, usize)> {
        if self.step == Step::Welcome {
            return None;
        }
        let steps = self.flow_steps();
        let position = steps.iter().position(|step| *step == self.step)? + 1;
        Some((position, steps.len()))
    }

    fn title(&self) -> String {
        if let Some(question) = self.setting_question() {
            return question.title;
        }
        match self.step {
            Step::Harness => "Choose your agent harness",
            Step::Runtime => "Where should the sandbox run?",
            Step::Inference => "How should your agent reach its model?",
            Step::Api => "Which inference API should the harness speak?",
            Step::DeploymentName => "Name this deployment",
            Step::Endpoint => "Where is the compatible inference endpoint?",
            Step::Model => "Choose the model",
            _ => "",
        }
        .into()
    }

    fn help(&self) -> String {
        if let Some(question) = self.setting_question() {
            return format!(
                "{}{}",
                question.description,
                if question.required {
                    " Required."
                } else {
                    " Optional; leave empty to skip."
                }
            );
        }
        match self.step {
            Step::Harness => "The harness is the agent environment NemoClaw installs and isolates.",
            Step::Runtime => "The runtime owns the gateway and local sandbox resources.",
            Step::Inference => "Hosted inference keeps model compute outside the sandbox.",
            Step::Api => "Only APIs compatible with the selected harness are shown.",
            Step::DeploymentName => "A human-readable DNS label for this desired-state document.",
            Step::Endpoint => "Enter the complete HTTP or HTTPS endpoint URL.",
            Step::Model => "Choose a suggestion or enter another model identifier.",
            _ => "",
        }
        .into()
    }
}

// External labels are text; escaping must not alter the selected identity.
fn terminal_text(value: &str) -> String {
    value
        .chars()
        .flat_map(|character| {
            if character.is_control()
                || matches!(character, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
            {
                character.escape_default().collect::<Vec<_>>()
            } else {
                vec![character]
            }
        })
        .collect()
}

fn review_field<'a>(label: &'a str, value: &'a str) -> [Line<'a>; 1] {
    [Line::from(vec![
        Span::styled(format!("{label}: "), Style::new().fg(MUTED)),
        Span::styled(terminal_text(value), Style::new().fg(WHITE)),
    ])]
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

#[cfg(test)]
mod tests {
    #[test]
    fn discovered_identifiers_are_escaped_only_for_terminal_display() {
        let identifier = "org.fixture.\u{1b}[31m\n\u{202e}agent";
        let line = super::review_field("Harness", identifier);
        let displayed = line[0].spans[1].content.as_ref();
        assert_eq!(displayed, "org.fixture.\\u{1b}[31m\\n\\u{202e}agent");
        assert_eq!(identifier, "org.fixture.\u{1b}[31m\n\u{202e}agent");
    }
}
