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
        let content_height = if self.step == Step::Review { 14 } else { 12 };
        let rows = Layout::vertical([
            Constraint::Length(8),
            Constraint::Min(content_height),
            Constraint::Length(2),
        ])
        .split(body);
        self.render_logo(frame, rows[0]);
        self.render_question(frame, rows[1]);
        self.render_footer(frame, rows[2]);
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
        if self.step == Step::Welcome {
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
                Line::from(Span::styled(
                    "The sandbox limits what the agent can reach on your computer.",
                    Style::new().fg(MUTED),
                )),
                Line::from(""),
                Line::from(Span::styled(
                    "This setup will help you choose:",
                    Style::new().fg(WHITE),
                )),
                welcome_choice("which agent to use"),
                welcome_choice("Docker or Podman for the sandbox"),
                welcome_choice("a model provider and model"),
                Line::from(""),
                Line::from(Span::styled(
                    "It writes a deployment YAML file for you to review.",
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
                Line::from(vec![
                    Span::styled(
                        if active { "  ●  " } else { "  ○  " },
                        Style::new().fg(if active { BRIGHT_GREEN } else { MUTED }),
                    ),
                    Span::styled(
                        label,
                        Style::new()
                            .fg(if active { WHITE } else { MUTED })
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
        lines.extend(review_field("Deployment", &answers.deployment_name));
        lines.extend(review_field("Harness", labels::harness(answers.harness)));
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
        frame.render_widget(Paragraph::new(lines), area);
    }

    fn render_footer(&self, frame: &mut Frame<'_>, area: Rect) {
        let controls = match self.step {
            Step::Welcome => "Enter  begin     Esc  exit",
            Step::Review => "Enter  author YAML     ←  back     Esc  exit",
            _ if self.is_choice() => "↑/↓  choose     Enter  continue     ←  back     Esc  exit",
            _ => "Type to replace     Enter  continue     ←  back     Esc  exit",
        };
        let rows = Layout::vertical([Constraint::Length(1), Constraint::Length(1)]).split(area);
        frame.render_widget(
            Paragraph::new(controls).style(Style::new().fg(MUTED)),
            rows[0],
        );
        if let Some((position, total)) = self.progress() {
            let width = rows[1].width as usize;
            let filled = width.saturating_mul(position) / total;
            frame.render_widget(
                Paragraph::new(Line::from(vec![
                    Span::styled("▄".repeat(filled), Style::new().fg(Color::Rgb(82, 135, 49))),
                    Span::styled(
                        "▄".repeat(width.saturating_sub(filled)),
                        Style::new().fg(DEEP_GREEN),
                    ),
                ])),
                rows[1],
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

    fn title(&self) -> &'static str {
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
    }

    fn help(&self) -> &'static str {
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
    }
}

fn welcome_choice(label: &'static str) -> Line<'static> {
    Line::from(vec![
        Span::styled("  • ", Style::new().fg(BRIGHT_GREEN)),
        Span::styled(label, Style::new().fg(WHITE)),
    ])
}

fn review_field<'a>(label: &'a str, value: &'a str) -> [Line<'a>; 2] {
    [
        Line::from(Span::styled(label, Style::new().fg(MUTED))),
        Line::from(vec![
            Span::raw("  "),
            Span::styled(value, Style::new().fg(WHITE)),
        ]),
    ]
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
