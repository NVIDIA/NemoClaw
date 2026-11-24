// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Builds the Windows installer from a windows_amd64 bundle with WiX Toolset.
//! It reads the bundle as data and never runs it, so the release can build
//! from a signed bundle with signing access. Compile with rustc; no crates.
//!
//! windows-installer build --bundle DIR --output FILE.msi [--version VERSION]
//!     [--compression LEVEL] [--source FILE.wxs] [--wix PROGRAM]
//! windows-installer version VERSION
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};
type Result<T> = std::result::Result<T, String>;

/// The installer's WiX source, relative to the repository root.
const SOURCE: &str = "packaging/windows/NemoClaw.wxs";
/// The heading of the bundle's own license on the license page.
const PRODUCT: &str = "NVIDIA NemoClaw Agent Configs";

/// The Windows Installer ProductVersion for a bundle version.
///
/// Windows Installer compares only the first three fields, each at most
/// 255.255.65535, and has no pre-release part. The third field is
/// PATCH * 1000 plus a rank, so a release follows its candidates: 999 for a
/// release, N for release candidate rc.N and the CI builds after it
/// (rc.N.RUN), and 0 for any other pre-release, such as a CI build before
/// the first candidate or a local dev build. Builds that share a
/// ProductVersion replace each other, because the source allows same-version
/// upgrades.
fn msi_version(version: &str) -> Result<String> {
    let invalid = || format!("{version} isn't a bundle version MAJOR.MINOR.PATCH[-PRE][+BUILD]");
    let release = version.split('+').next().unwrap_or_default();
    let (core, pre) = match release.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (release, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    let [major, minor, patch] = parts[..] else {
        return Err(invalid());
    };
    let field = |part: &str| -> Result<u32> {
        if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
            return Err(invalid());
        }
        part.parse().map_err(|_| invalid())
    };
    let (major, minor, patch) = (field(major)?, field(minor)?, field(patch)?);
    if major > 255 || minor > 255 || patch > 64 {
        return Err(format!(
            "{version} doesn't fit a Windows Installer version: MAJOR and MINOR can be at most 255 and PATCH at most 64"
        ));
    }
    let rank = match pre {
        None => 999,
        Some(pre) => match pre.split('.').collect::<Vec<_>>()[..] {
            ["rc", candidate, ..] => match field(candidate) {
                Ok(candidate @ 1..=998) => candidate,
                _ => {
                    return Err(format!(
                        "{version} names a release candidate outside 1 to 998"
                    ))
                }
            },
            [] | [""] => return Err(invalid()),
            _ => 0,
        },
    };
    Ok(format!("{major}.{minor}.{}", patch * 1000 + rank))
}

/// The top-level "Version" string of a bundle's manifest.json.
fn manifest_version(manifest: &str) -> Result<String> {
    let missing = || "the bundle manifest names no version".to_owned();
    // Values are names, digests, and versions, none with quotes or escapes,
    // so the first "Version" key is the top-level one.
    let after = manifest.split_once("\"Version\"").ok_or_else(missing)?.1;
    let value = after.trim_start().strip_prefix(':').ok_or_else(missing)?;
    let value = value.trim_start().strip_prefix('"').ok_or_else(missing)?;
    let (version, _) = value.split_once('"').ok_or_else(missing)?;
    if version.is_empty() || version.contains('\\') {
        return Err(missing());
    }
    Ok(version.to_owned())
}

/// Text as RTF: escapes RTF's control characters and writes other
/// characters as Unicode escapes, one paragraph per line.
fn rtf_text(text: &str) -> String {
    let mut rtf = String::new();
    for ch in text.chars() {
        match ch {
            '\\' | '{' | '}' => {
                rtf.push('\\');
                rtf.push(ch);
            }
            '\r' => {}
            '\n' => rtf.push_str("\\par\n"),
            '\t' => rtf.push_str("\\tab "),
            ' '..='~' => rtf.push(ch),
            _ => {
                let mut units = [0; 2];
                for unit in ch.encode_utf16(&mut units) {
                    // RTF's \u takes a signed 16-bit value; ? is the fallback.
                    rtf.push_str(&format!("\\u{}?", *unit as i16));
                }
            }
        }
    }
    rtf
}

/// The license page: the bundle's LICENSE, then each third-party notice in
/// its licenses directory, by file name, each headed with its path in the
/// installed bundle.
fn license_rtf(product: &str, notices: &[(String, String)]) -> String {
    let mut rtf = String::from(
        "{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\fswiss\\fcharset0 Segoe UI;}{\\f1\\fmodern\\fcharset0 Consolas;}}\n\\viewkind4\\uc1\\pard\\f0\\fs18\n",
    );
    for (index, (path, text)) in notices.iter().enumerate() {
        let heading = if index == 0 {
            format!("{product} is licensed under the following terms ({path}).")
        } else {
            format!("Third-party notice: {path}")
        };
        if index == 1 {
            rtf.push_str("\\par\n{\\b ");
            rtf.push_str(&rtf_text(
                "The bundle includes third-party software under the following licenses.",
            ));
            rtf.push_str("}\\par\n");
        }
        if index > 0 {
            rtf.push_str("\\par\n");
        }
        rtf.push_str("{\\b ");
        rtf.push_str(&rtf_text(&heading));
        rtf.push_str("}\\par\n\\par\n{\\f1\\fs16 ");
        rtf.push_str(&rtf_text(text.trim_start_matches(['\r', '\n']).trim_end()));
        rtf.push_str("}\\par\n");
    }
    rtf.push_str("}\n");
    rtf
}

/// The bundle's LICENSE and its licenses directory's files, by file name,
/// with their paths as Windows shows them.
fn notices(bundle: &Path) -> Result<Vec<(String, String)>> {
    let read = |path: &Path| {
        fs::read(path)
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .map_err(|e| format!("cannot read {}: {e}", path.display()))
    };
    let mut notices = vec![("LICENSE".to_owned(), read(&bundle.join("LICENSE"))?)];
    let directory = bundle.join("licenses");
    let mut names = Vec::new();
    for entry in
        fs::read_dir(&directory).map_err(|e| format!("cannot read {}: {e}", directory.display()))?
    {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().map_err(|e| e.to_string())?.is_file() {
            names.push(entry.file_name().to_string_lossy().into_owned());
        }
    }
    names.sort();
    for name in names {
        notices.push((format!("licenses\\{name}"), read(&directory.join(&name))?));
    }
    Ok(notices)
}

struct Build {
    bundle: PathBuf,
    output: PathBuf,
    version: Option<String>,
    compression: String,
    source: PathBuf,
    wix: String,
}

fn parse_build(args: &[String]) -> Result<Build> {
    let mut build = Build {
        bundle: PathBuf::new(),
        output: PathBuf::new(),
        version: None,
        compression: "high".into(),
        source: PathBuf::from(SOURCE),
        wix: "wix".into(),
    };
    let mut args = args.iter();
    while let Some(flag) = args.next() {
        let value = args
            .next()
            .ok_or_else(|| format!("{flag} needs a value"))?
            .clone();
        match flag.as_str() {
            "--bundle" => build.bundle = value.into(),
            "--output" => build.output = value.into(),
            "--version" => build.version = Some(value),
            "--compression" => build.compression = value,
            "--source" => build.source = value.into(),
            "--wix" => build.wix = value,
            _ => return Err(format!("unknown option {flag}")),
        }
    }
    if build.bundle.as_os_str().is_empty() || build.output.as_os_str().is_empty() {
        return Err("build needs --bundle and --output".into());
    }
    if !["none", "low", "medium", "high", "mszip"].contains(&build.compression.as_str()) {
        return Err(format!("unknown compression {}", build.compression));
    }
    Ok(build)
}

fn build(build: Build) -> Result<()> {
    let bundle = fs::canonicalize(&build.bundle)
        .map_err(|e| format!("cannot open the bundle {}: {e}", build.bundle.display()))?;
    if !bundle.join("bin").join("nemoclaw.exe").is_file() {
        return Err(format!(
            "{} isn't a windows_amd64 bundle: it has no bin\\nemoclaw.exe",
            bundle.display()
        ));
    }
    let manifest = fs::read_to_string(bundle.join("manifest.json"))
        .map_err(|e| format!("cannot read the bundle manifest: {e}"))?;
    let version = match build.version {
        Some(version) => version,
        None => manifest_version(&manifest)?,
    };
    if !version
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b".+-".contains(&b))
    {
        return Err(format!("{version} has characters a bundle version can't"));
    }
    let product_version = msi_version(&version)?;
    let source = fs::canonicalize(&build.source)
        .map_err(|e| format!("cannot open {}: {e}", build.source.display()))?;
    let artwork = source
        .parent()
        .ok_or("the WiX source has no directory")?
        .join("artwork");
    let output = std::path::absolute(&build.output).map_err(|e| e.to_string())?;
    let work = output.with_extension("build");
    fs::create_dir_all(&work).map_err(|e| format!("cannot create {}: {e}", work.display()))?;
    let license = work.join("License.rtf");
    fs::write(&license, license_rtf(PRODUCT, &notices(&bundle)?))
        .map_err(|e| format!("cannot write {}: {e}", license.display()))?;
    let define = |name: &str, value: &Path| format!("{name}={}", value.display());
    let status = Command::new(&build.wix)
        .arg("build")
        .arg(&source)
        .args(["-arch", "x64", "-ext", "WixToolset.UI.wixext"])
        // Every component installs under the user's profile: a per-user
        // package's files can't have the registry key paths, and its harvested
        // directories the RemoveFolder rows, that these validators expect of
        // a roaming profile. LocalAppData doesn't roam.
        .args(["-sice", "ICE38", "-sice", "ICE64", "-sice", "ICE91"])
        .arg("-d")
        .arg(format!("ProductVersion={product_version}"))
        .arg("-d")
        .arg(format!("DisplayVersion={version}"))
        .arg("-d")
        .arg(format!("Compression={}", build.compression))
        .arg("-d")
        .arg(define("BundleDir", &bundle))
        .arg("-d")
        .arg(define("ArtworkDir", &artwork))
        .arg("-d")
        .arg(define("LicenseRtf", &license))
        .arg("-intermediatefolder")
        .arg(&work)
        .arg("-o")
        .arg(&output)
        .status()
        .map_err(|e| format!("cannot run {}: {e}", build.wix))?;
    if !status.success() {
        return Err(format!("WiX couldn't build the installer ({status})"));
    }
    println!(
        "Built {} for NemoClaw {version} (Windows Installer version {product_version})",
        output.display()
    );
    Ok(())
}

fn run() -> Result<()> {
    let args: Vec<String> = env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("build") => build(parse_build(&args[1..])?),
        Some("version") if args.len() == 2 => {
            println!("{}", msi_version(&args[1])?);
            Ok(())
        }
        _ => Err("usage: windows-installer build --bundle DIR --output FILE.msi [--version VERSION] [--compression LEVEL] [--source FILE.wxs] [--wix PROGRAM] | windows-installer version VERSION".into()),
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("::error::{error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ordered(versions: &[&str]) {
        let fields = |version: &str| -> Vec<u32> {
            msi_version(version)
                .unwrap()
                .split('.')
                .map(|field| field.parse().unwrap())
                .collect()
        };
        for pair in versions.windows(2) {
            assert!(
                fields(pair[0]) < fields(pair[1]),
                "{} must install over {}",
                pair[1],
                pair[0]
            );
        }
    }

    #[test]
    fn releases_follow_their_candidates_and_precede_the_next_patch() {
        assert_eq!(msi_version("0.1.0-rc.12").unwrap(), "0.1.12");
        assert_eq!(msi_version("0.1.0").unwrap(), "0.1.999");
        ordered(&[
            "0.1.0-dev.abc123",
            "0.1.0-rc.1",
            "0.1.0-rc.12",
            "0.1.0-rc.13",
            "0.1.0",
            "0.1.1-rc.1",
            "0.1.1",
            "0.2.0-rc.1",
            "1.0.0",
        ]);
    }

    #[test]
    fn ci_builds_share_the_version_of_the_candidate_they_follow() {
        assert_eq!(
            msi_version("0.1.0-rc.12.4567").unwrap(),
            msi_version("0.1.0-rc.12").unwrap()
        );
        assert_eq!(msi_version("0.1.0-rc.12.4567.2").unwrap(), "0.1.12");
        assert_eq!(msi_version("0.1.1-4567").unwrap(), "0.1.1000");
        assert_eq!(msi_version("0.1.0+build.5").unwrap(), "0.1.999");
    }

    #[test]
    fn versions_windows_installer_cannot_order_are_refused() {
        for version in [
            "0.1",
            "0.1.0.0",
            "v0.1.0",
            "0.1.x",
            "256.0.0",
            "0.256.0",
            "0.1.65",
            "0.1.0-rc.0",
            "0.1.0-rc.999",
            "0.1.0-",
        ] {
            assert!(msi_version(version).is_err(), "{version}");
        }
        assert_eq!(msi_version("255.255.64").unwrap(), "255.255.64999");
    }

    #[test]
    fn the_manifest_names_the_version() {
        let manifest = "{\n  \"Version\": \"0.1.0-rc.12\",\n  \"Rust\": \"1.100.0\",\n  \"Files\": {\n    \"bin/nemoclaw.exe\": \"abc\"\n  }\n}";
        assert_eq!(manifest_version(manifest).unwrap(), "0.1.0-rc.12");
        assert!(manifest_version("{\"Files\": {}}").is_err());
        assert!(manifest_version("{\"Version\": 1}").is_err());
    }

    #[test]
    fn rtf_escapes_control_characters_and_non_ascii_text() {
        assert_eq!(rtf_text("a\\b{c}"), "a\\\\b\\{c\\}");
        assert_eq!(rtf_text("one\r\ntwo\n"), "one\\par\ntwo\\par\n");
        assert_eq!(rtf_text("\u{a9} 2026"), "\\u169? 2026");
        assert_eq!(rtf_text("\u{2014}"), "\\u8212?");
        // Above U+7FFF, \u is negative; beyond the BMP, a surrogate pair.
        assert_eq!(rtf_text("\u{fffd}"), "\\u-3?");
        assert_eq!(rtf_text("\u{1f600}"), "\\u-10179?\\u-8704?");
    }

    #[test]
    fn the_license_page_shows_the_bundle_license_then_each_notice() {
        let rtf = license_rtf(
            "Product",
            &[
                ("LICENSE".into(), "Apache {2.0}\n".into()),
                ("licenses\\a-LICENSE".into(), "MPL\n".into()),
                ("licenses\\b-LICENSE".into(), "MIT\n".into()),
            ],
        );
        assert!(rtf.starts_with("{\\rtf1"));
        assert!(rtf.ends_with("}\n"));
        let order = [
            "Product is licensed under the following terms (LICENSE).",
            "Apache \\{2.0\\}",
            "Third-party notice: licenses\\\\a-LICENSE",
            "MPL",
            "Third-party notice: licenses\\\\b-LICENSE",
            "MIT",
        ];
        let mut from = 0;
        for text in order {
            let at = rtf[from..]
                .find(text)
                .unwrap_or_else(|| panic!("{text} missing or out of order in {rtf}"));
            from += at + text.len();
        }
        let opened = rtf.matches('{').count() - rtf.matches("\\{").count();
        let closed = rtf.matches('}').count() - rtf.matches("\\}").count();
        assert_eq!(opened, closed, "{rtf}");
    }

    #[test]
    fn the_license_page_reads_the_bundle_notices_by_name() {
        let bundle = env::temp_dir().join(format!("windows-installer-{}", std::process::id()));
        fs::create_dir_all(bundle.join("licenses")).unwrap();
        fs::write(bundle.join("LICENSE"), "Apache").unwrap();
        fs::write(bundle.join("licenses").join("b-LICENSE"), "B").unwrap();
        fs::write(bundle.join("licenses").join("a-LICENSE"), "A").unwrap();
        let found = notices(&bundle).unwrap();
        fs::remove_dir_all(&bundle).unwrap();
        let names: Vec<&str> = found.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(
            names,
            ["LICENSE", "licenses\\a-LICENSE", "licenses\\b-LICENSE"]
        );
        assert_eq!(found[1].1, "A");
    }

    #[test]
    fn build_options_are_checked_before_wix_runs() {
        let args = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(parse_build(&args(&["--bundle", "b"])).is_err());
        assert!(parse_build(&args(&[
            "--bundle",
            "b",
            "--output",
            "o.msi",
            "--compression",
            "max"
        ]))
        .is_err());
        assert!(parse_build(&args(&["--bundle", "b", "--output"])).is_err());
        let build = parse_build(&args(&["--bundle", "b", "--output", "o.msi"])).unwrap();
        assert_eq!(build.compression, "high");
        assert_eq!(build.source, PathBuf::from(SOURCE));
    }
}
