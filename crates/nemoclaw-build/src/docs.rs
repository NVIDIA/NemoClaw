// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Publish one Markdown source through repository and Fern navigation.
use pulldown_cmark::{Event, HeadingLevel, LinkType, Options, Parser, Tag, TagEnd};
use serde::Deserialize;
use serde_json::json;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    process::Command,
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const OUTPUT: &str = "fern/_generated";
const ROUTE: &str = "/nemoclaw/v1";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Navigation {
    #[serde(rename = "$comment")]
    _comment: Option<String>,
    sections: Vec<Section>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Section {
    title: String,
    pages: Vec<Page>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Page {
    title: String,
    source: String,
    slug: String,
    #[serde(default)]
    changelog: bool,
}

/// The Markdown extensions the pages use; the writer must know them to round-trip.
const PARSER_OPTIONS: Options = Options::ENABLE_TABLES.union(Options::ENABLE_STRIKETHROUGH);

fn parser(text: &str) -> Parser<'_> {
    Parser::new_ext(text, PARSER_OPTIONS)
}

fn check_yaml(source: &Path, text: &str) -> Result<()> {
    let mut yaml = None;
    for (event, range) in parser(text).into_offset_iter() {
        match event {
            Event::Start(Tag::CodeBlock(pulldown_cmark::CodeBlockKind::Fenced(info)))
                if matches!(info.split_whitespace().next(), Some("yaml" | "yml")) =>
            {
                yaml = Some((range.start, String::new()));
            }
            Event::Text(text) if yaml.is_some() => yaml.as_mut().unwrap().1.push_str(&text),
            Event::End(TagEnd::CodeBlock) if yaml.is_some() => {
                let (offset, content) = yaml.take().unwrap();
                let location = format!(
                    "{}:{}",
                    source.display(),
                    text[..offset].bytes().filter(|byte| *byte == b'\n').count() + 1
                );
                let value: serde_json::Value = serde_saphyr::from_str(&content)
                    .map_err(|error| format!("{location}: invalid YAML example: {error}"))?;
                if value.get("apiVersion").is_some() && value.get("kind").is_some() {
                    nemoclaw_sdk::config::Document::parse(content.as_bytes()).map_err(|error| {
                        format!("{location}: invalid deployment example: {error}")
                    })?;
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn anchors(text: &str) -> BTreeSet<String> {
    let mut anchors = BTreeSet::new();
    let mut heading = None;
    for event in parser(text) {
        match event {
            Event::Start(Tag::Heading { .. }) => heading = Some(String::new()),
            Event::Text(text) | Event::Code(text) if heading.is_some() => {
                heading.as_mut().unwrap().push_str(&text);
            }
            Event::End(TagEnd::Heading(_)) => {
                let slug: String = heading
                    .take()
                    .unwrap_or_default()
                    .to_lowercase()
                    .chars()
                    .filter_map(|c| {
                        if c.is_alphanumeric() || c == '-' || c == '_' {
                            Some(c)
                        } else if c.is_whitespace() {
                            Some('-')
                        } else {
                            None
                        }
                    })
                    .collect();
                let mut unique = slug.clone();
                let mut index = 0;
                while anchors.contains(&unique) {
                    index += 1;
                    unique = format!("{slug}-{index}");
                }
                anchors.insert(unique);
            }
            _ => {}
        }
    }
    anchors
}

fn local_path(root: &Path, path: &Path) -> Result<PathBuf> {
    let resolved = path
        .canonicalize()
        .map_err(|e| format!("{}: {e}", path.display()))?;
    if !resolved.starts_with(root) {
        return Err(format!("path escapes repository: {}", path.display()).into());
    }
    Ok(resolved)
}

fn changelog_entries(overview: &Path, slug: &str) -> Result<Vec<(PathBuf, String)>> {
    if overview.file_name().and_then(|name| name.to_str()) != Some("overview.md") {
        return Err("a changelog must start with overview.md".into());
    }
    let mut entries = Vec::new();
    for entry in fs::read_dir(overview.parent().unwrap())? {
        let entry = entry?;
        let path = entry.path();
        if path == overview || path.extension().is_none_or(|ext| ext != "md") {
            continue;
        }
        let name = path
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        let date = time::Date::parse(name, &time::format_description::well_known::Iso8601::DATE)
            .map_err(|_| {
                format!(
                    "expected a YYYY-MM-DD.md changelog entry: {}",
                    path.display()
                )
            })?;
        if !entry.file_type()?.is_file() || date.to_string() != name {
            return Err(format!(
                "expected a YYYY-MM-DD.md changelog entry: {}",
                path.display()
            )
            .into());
        }
        let route = format!(
            "{slug}/{}/{}/{}",
            date.year(),
            u8::from(date.month()),
            date.day()
        );
        entries.push((path, route));
    }
    Ok(entries)
}

struct Renderer<'a> {
    root: &'a Path,
    revision: &'a str,
    routes: BTreeMap<PathBuf, String>,
}
impl Renderer<'_> {
    fn link(&self, source: &Path, destination: &str, image: bool) -> Result<String> {
        if destination.starts_with("https://")
            || destination.starts_with("http://")
            || destination.starts_with("mailto:")
        {
            return Ok(destination.into());
        }
        if destination.starts_with('/') || destination.contains(':') {
            return Err(format!("use a repository-relative link: {destination}").into());
        }
        let (file, fragment) = destination
            .split_once('#')
            .map_or((destination, None), |(f, a)| (f, Some(a)));
        let target = if file.is_empty() {
            source.to_path_buf()
        } else {
            source.parent().unwrap().join(file)
        };
        let target = local_path(self.root, &target)
            .map_err(|e| format!("{}: {destination}: {e}", source.display()))?;
        if let Some(anchor) = fragment.filter(|a| !a.is_empty())
            && target
                .extension()
                .is_some_and(|extension| extension == "md")
            && !anchors(&fs::read_to_string(&target)?).contains(anchor)
        {
            return Err(format!("{}: missing heading in {destination}", source.display()).into());
        }
        let suffix = fragment.map(|a| format!("#{a}")).unwrap_or_default();
        if !image && let Some(slug) = self.routes.get(&target) {
            return Ok(format!("{ROUTE}/{slug}{suffix}"));
        }
        let relative = target.strip_prefix(self.root)?;
        let base = if image {
            "https://raw.githubusercontent.com/NVIDIA/NemoClaw"
        } else if target.is_dir() {
            "https://github.com/NVIDIA/NemoClaw/tree"
        } else {
            "https://github.com/NVIDIA/NemoClaw/blob"
        };
        let mut url = url::Url::parse(&format!("{base}/{}/", self.revision))?;
        {
            let mut segments = url
                .path_segments_mut()
                .map_err(|_| "invalid repository URL")?;
            segments.pop_if_empty();
            for segment in relative.components() {
                segments.push(&segment.as_os_str().to_string_lossy());
            }
        }
        url.set_fragment(fragment);
        Ok(url.into())
    }

    fn render(&self, source: &Path) -> Result<String> {
        let text = fs::read_to_string(source)?;
        check_yaml(source, &text)?;
        let mut events = Vec::new();
        let mut in_title = false;
        let mut in_code = false;
        for event in parser(&text) {
            let event = match event {
                Event::Start(Tag::Heading {
                    level: HeadingLevel::H1,
                    ..
                }) => {
                    in_title = true;
                    continue;
                }
                Event::End(TagEnd::Heading(HeadingLevel::H1)) => {
                    in_title = false;
                    continue;
                }
                _ if in_title => continue,
                Event::Start(Tag::CodeBlock(kind)) => {
                    in_code = true;
                    Event::Start(Tag::CodeBlock(kind))
                }
                Event::End(TagEnd::CodeBlock) => {
                    in_code = false;
                    Event::End(TagEnd::CodeBlock)
                }
                Event::Start(Tag::Link {
                    dest_url, title, ..
                }) => Event::Start(Tag::Link {
                    dest_url: self.link(source, &dest_url, false)?.into(),
                    title,
                    link_type: LinkType::Inline,
                    id: "".into(),
                }),
                Event::Start(Tag::Image {
                    dest_url, title, ..
                }) => Event::Start(Tag::Image {
                    dest_url: self.link(source, &dest_url, true)?.into(),
                    title,
                    link_type: LinkType::Inline,
                    id: "".into(),
                }),
                Event::Html(html) | Event::InlineHtml(html) if html.trim().starts_with("<!--") => {
                    Event::Html(html.replace("<!--", "{/*").replace("-->", "*/}").into())
                }
                // MDX reads braces as expressions, so they become character
                // references. The writer escapes `&` in text, so the references
                // go out as inline HTML between the text around them.
                Event::Text(text) if !in_code => {
                    let mut rest = text.as_ref();
                    while let Some(index) = rest.find(['{', '}']) {
                        if index > 0 {
                            events.push(Event::Text(rest[..index].to_owned().into()));
                        }
                        let reference = if rest.as_bytes()[index] == b'{' {
                            "&#123;"
                        } else {
                            "&#125;"
                        };
                        events.push(Event::InlineHtml(reference.into()));
                        rest = &rest[index + 1..];
                    }
                    if rest.is_empty() {
                        continue;
                    }
                    Event::Text(rest.to_owned().into())
                }
                event => event,
            };
            events.push(event);
        }
        let mut output = String::new();
        pulldown_cmark_to_cmark::cmark(events.iter(), &mut output, PARSER_OPTIONS)?;
        output.push('\n');
        Ok(output)
    }
}

fn output_files(root: &Path) -> Result<BTreeSet<PathBuf>> {
    fn visit(base: &Path, path: &Path, files: &mut BTreeSet<PathBuf>) -> Result<()> {
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                visit(base, &entry.path(), files)?;
            } else {
                files.insert(entry.path().strip_prefix(base)?.to_path_buf());
            }
        }
        Ok(())
    }
    let mut files = BTreeSet::new();
    if root.exists() {
        visit(root, root, &mut files)?;
    }
    Ok(files)
}

/// Generate only after every source and link validates; check never writes output.
pub fn generate(root: &Path, check: bool, revision: Option<&str>) -> Result<()> {
    let revision = match revision {
        Some(value) => value.to_owned(),
        None => {
            let result = Command::new("git")
                .current_dir(root)
                .args(["rev-parse", "HEAD"])
                .output()?;
            if !result.status.success() {
                return Err("pass --revision outside a Git checkout".into());
            }
            String::from_utf8(result.stdout)?.trim().into()
        }
    };
    if revision.len() != 40
        || !revision
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err("source revision must be a full lowercase 40-hex commit".into());
    }
    let root = root.canonicalize()?;
    let navigation: Navigation = serde_json::from_slice(&fs::read(root.join("fern/pages.json"))?)?;
    let mut renderer = Renderer {
        root: &root,
        revision: &revision,
        routes: BTreeMap::new(),
    };
    let mut slugs = BTreeSet::new();
    let mut sections = Vec::new();
    for section in &navigation.sections {
        let mut contents = Vec::new();
        for page in &section.pages {
            if page.slug.is_empty()
                || !page.slug.split('/').all(|part| {
                    !part.is_empty()
                        && part
                            .bytes()
                            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
                })
            {
                return Err(format!("invalid route: {}", page.slug).into());
            }
            if !page.source.starts_with("docs/") || !page.source.ends_with(".md") {
                return Err("pages must be docs/*.md sources".into());
            }
            let source = local_path(&root, &root.join(&page.source))?;
            let relative = source.strip_prefix(root.join("docs"))?;
            let mut routes = vec![(source.clone(), page.slug.clone())];
            let node = if page.changelog {
                routes.extend(changelog_entries(&source, &page.slug)?);
                json!({"changelog": format!("./pages/{}", relative.parent().unwrap().to_string_lossy().replace('\\', "/")),
                    "title": page.title, "slug": page.slug})
            } else {
                json!({"page": page.title, "slug": page.slug,
                    "path": format!("./pages/{}", relative.with_extension("mdx").to_string_lossy().replace('\\', "/"))})
            };
            for (file, route) in routes {
                if !slugs.insert(route.clone()) || renderer.routes.insert(file, route).is_some() {
                    return Err(format!("duplicate route or source for {}", page.source).into());
                }
            }
            contents.push(node);
        }
        sections.push(json!({"section": section.title, "skip-slug": true, "contents": contents}));
    }
    let mut files = BTreeMap::new();
    for source in renderer.routes.keys() {
        let destination = Path::new("pages")
            .join(source.strip_prefix(root.join("docs"))?)
            .with_extension("mdx");
        files.insert(destination, renderer.render(source)?);
    }
    files.insert(
        PathBuf::from("navigation.yml"),
        serde_saphyr::to_string(&json!({"navigation": sections}))?,
    );
    let output = root.join(OUTPUT);
    let expected: BTreeSet<_> = files.keys().cloned().collect();
    if check {
        if output_files(&output)? != expected {
            return Err("generated docs are missing or obsolete; run nemoclaw-build docs".into());
        }
        for (name, contents) in files {
            if fs::read(output.join(&name))? != contents.as_bytes() {
                return Err(format!("stale generated docs: {}", name.display()).into());
            }
        }
    } else {
        // Stage a complete tree so a validation failure preserves the previous render.
        let staging = tempfile::tempdir_in(root.join("fern"))?;
        for (name, contents) in files {
            let path = staging.path().join(name);
            fs::create_dir_all(path.parent().unwrap())?;
            fs::write(path, contents)?;
        }
        if output.exists() {
            fs::remove_dir_all(&output)?;
        }
        fs::rename(staging.path(), output)?;
    }
    Ok(())
}
