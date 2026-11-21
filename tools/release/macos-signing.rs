// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// 3S submission adapted from NVIDIA/fleet-intelligence-client PR #16,
// revision 9291b7eecac39b303e092d8c2109db579972f626 (Apache-2.0).
// Changes: Vault JWT authentication, inventory selection, bounded extraction,
// and explicit notarization result validation. Compile with rustc; no crates.
use std::{
    env, fs,
    io::Write,
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
};
type Result<T> = std::result::Result<T, String>;
const VAULT: &str = "https://prod.internal.vault.nvidia.com";
const NAMESPACE: &str = "dgxc-eng-ai";
const AUDIENCE: &str = "https://prod.internal.vault.nvidia.com";
fn required(name: &str) -> Result<String> {
    env::var(name)
        .ok()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("Missing {name}"))
}
// Capture output: service error responses and CLI diagnostics can contain credentials.
fn capture(cmd: &mut Command, input: Option<&[u8]>) -> Result<Vec<u8>> {
    let mut child = cmd
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "Could not start required tool")?;
    if let Some(bytes) = input {
        child
            .stdin
            .take()
            .ok_or("Missing child stdin")?
            .write_all(bytes)
            .map_err(|_| "Could not write child stdin")?;
    }
    let output = child
        .wait_with_output()
        .map_err(|_| "Could not wait for required tool")?;
    if !output.status.success() {
        return Err("Required tool failed; no release output is approved".into());
    }
    Ok(output.stdout)
}
fn json_field(bytes: &[u8], filter: &str) -> Result<String> {
    let output = capture(
        Command::new(if cfg!(target_os = "linux") {
            "/usr/bin/jq"
        } else {
            "jq"
        })
        .args(["-er", filter]),
        Some(bytes),
    )?;
    let s = String::from_utf8(output).map_err(|_| "Invalid UTF-8")?;
    let s = s.trim_end_matches('\n');
    if s.is_empty() || s.contains(['\r', '\n']) {
        return Err("Invalid empty or multiline field".into());
    }
    Ok(s.into())
}
fn quoted(s: &str) -> String {
    let mut result = String::from("\"");
    for ch in s.chars() {
        match ch {
            '"' => result.push_str("\\\""),
            '\\' => result.push_str("\\\\"),
            '\n' => result.push_str("\\n"),
            '\r' => result.push_str("\\r"),
            '\t' => result.push_str("\\t"),
            c if c.is_control() => result.push_str(&format!("\\u{:04x}", c as u32)),
            c => result.push(c),
        }
    }
    result.push('"');
    result
}
fn http(url: &str, headers: &[String], body: Option<&str>) -> Result<Vec<u8>> {
    if !url.starts_with("https://") {
        return Err("HTTPS is required".into());
    }
    // Config travels over stdin so authentication headers never enter argv.
    let mut config = format!("url = {}\n", quoted(url));
    for h in headers {
        config.push_str(&format!("header = {}\n", quoted(h)));
    }
    if let Some(b) = body {
        config.push_str(&format!("data = {}\n", quoted(b)));
    }
    capture(
        Command::new(if cfg!(target_os = "linux") {
            "/usr/bin/curl"
        } else {
            "curl"
        })
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin")
        .args([
            "-q",
            "--silent",
            "--show-error",
            "--fail",
            "--proto",
            "=https",
            "--connect-timeout",
            "15",
            "--max-time",
            "90",
            "--config",
            "-",
        ]),
        Some(config.as_bytes()),
    )
}
struct VaultToken(String);
impl Drop for VaultToken {
    fn drop(&mut self) {
        let _ = http(
            &format!("{VAULT}/v1/auth/token/revoke-self"),
            &[
                format!("X-Vault-Namespace: {NAMESPACE}"),
                format!("X-Vault-Token: {}", self.0),
            ],
            Some("{}"),
        );
    }
}
fn mask(s: &str) {
    println!(
        "::add-mask::{}",
        s.replace('%', "%25")
            .replace('\r', "%0D")
            .replace('\n', "%0A")
    );
}
fn authorize(role: &str) -> Result<VaultToken> {
    let url = required("ACTIONS_ID_TOKEN_REQUEST_URL")?;
    if !url.starts_with("https://") {
        return Err("Invalid OIDC URL".into());
    }
    let sep = if url.contains('?') { '&' } else { '?' };
    let jwt = json_field(
        &http(
            &format!("{url}{sep}audience={AUDIENCE}"),
            &[format!(
                "Authorization: bearer {}",
                required("ACTIONS_ID_TOKEN_REQUEST_TOKEN")?
            )],
            None,
        )?,
        ".value | select(type == \"string\")",
    )?;
    mask(&jwt);
    let body = format!("{{\"role\":{},\"jwt\":{}}}", quoted(role), quoted(&jwt));
    let response = http(
        &format!("{VAULT}/v1/auth/jwt/nemoclaw-release-signing/login"),
        &[
            format!("X-Vault-Namespace: {NAMESPACE}"),
            "Content-Type: application/json".into(),
        ],
        Some(&body),
    )?;
    let token = VaultToken(json_field(
        &response,
        ".auth.client_token | select(type == \"string\")",
    )?);
    mask(&token.0);
    Ok(token)
}
fn credentials() -> Result<(String, String, VaultToken)> {
    let token = authorize("nemoclaw-release-signing")?;
    let response = http(
        &format!("{VAULT}/v1/services/nemoclaw-release-signing/ssa/issue/creds"),
        &[
            format!("X-Vault-Namespace: {NAMESPACE}"),
            format!("X-Vault-Token: {}", token.0),
        ],
        None,
    )?;
    let id = json_field(&response, ".data.client_id | select(type == \"string\")")?;
    let secret = json_field(&response, ".data.secret | select(type == \"string\")")?;
    mask(&secret);
    Ok((id, secret, token))
}
struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Result<Self> {
        let parent = PathBuf::from(required("RUNNER_TEMP")?);
        let path = parent.join(format!("nemoclaw-3s-{}", std::process::id()));
        fs::create_dir(&path).map_err(|_| "Could not create private scratch directory")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
                .map_err(|_| "chmod scratch failed")?;
        }
        Ok(Self(path))
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn safe_program(bundle: &Path, name: &str) -> Result<()> {
    if name.is_empty()
        || !Path::new(name)
            .components()
            .all(|p| matches!(p, Component::Normal(_)))
    {
        return Err("Inventory path is outside bundle".into());
    }
    let root = bundle.canonicalize().map_err(|_| "Missing bundle")?;
    let file = bundle.join(name);
    let meta = fs::symlink_metadata(&file).map_err(|_| "Missing executable")?;
    if !meta.is_file()
        || meta.file_type().is_symlink()
        || !file
            .canonicalize()
            .map_err(|_| "Missing executable")?
            .starts_with(root)
    {
        return Err("Inventory entry is not a regular file inside bundle".into());
    }
    Ok(())
}
fn require_accepted(json: &[u8]) -> Result<()> {
    if json_field(json, ".status")? != "Accepted" {
        return Err("Apple has not accepted the notarization submission".into());
    }
    Ok(())
}
fn inventory(bundle: &Path) -> Result<Vec<String>> {
    let output = capture(
        Command::new("bash")
            .arg(".github/scripts/signing-inventory.sh")
            .arg(bundle)
            .arg("darwin_arm64"),
        None,
    )?;
    let text = String::from_utf8(output).map_err(|_| "Invalid inventory")?;
    let mut names = Vec::new();
    for line in text.lines() {
        let (owner, name) = line.split_once('\t').ok_or("Invalid inventory row")?;
        safe_program(bundle, name)?;
        match owner {
            "nvidia" => names.push(name.into()),
            "hashicorp" => (),
            _ => return Err("Unknown signing owner".into()),
        }
    }
    if names.is_empty() {
        return Err("No NVIDIA executables to sign".into());
    }
    Ok(names)
}
fn sign(bundle: &Path) -> Result<()> {
    if required("MACOS_THIRD_PARTY_SIGNING_APPROVED")? != "true" {
        return Err("Product Security approval is required".into());
    }
    let names = inventory(bundle)?;
    let scratch = Scratch::new()?;
    let (id, secret, token) = credentials()?;
    drop(token);
    for name in names {
        let input = scratch.0.join("payload.command");
        let archive = scratch.0.join("input.zip");
        let signed = scratch.0.join("signed.zip");
        fs::copy(bundle.join(&name), &input).map_err(|_| "Could not copy executable")?;
        capture(
            Command::new("zip")
                .current_dir(&scratch.0)
                .args(["-q", "-X"])
                .arg(&archive)
                .arg("payload.command"),
            None,
        )?;
        capture(
            Command::new("nvsec")
                .env("HOME", &scratch.0)
                .env("XDG_CACHE_HOME", &scratch.0)
                .env("TMPDIR", &scratch.0)
                .env("NVSEC_SSA_CLIENT_ID", &id)
                .env("NVSEC_SSA_CLIENT_SECRET", &secret)
                .args([
                    "3s",
                    "submit",
                    "--job_type",
                    "MACOS",
                    "--scope",
                    "SIGNING_MACOS",
                    "--auth",
                    "ssa",
                    "--input_file",
                ])
                .arg(&archive)
                .args(["--download", "--timeout", "600", "--result_dir"])
                .arg(&scratch.0)
                .args([
                    "--result_filename",
                    "signed.zip",
                    "--nspect_id",
                    "NSPECT-SQ44-PJFM",
                ]),
            None,
        )?;
        // Read just the expected member; never extract service-returned paths.
        let listing = capture(Command::new("unzip").arg("-Z1").arg(&signed), None)?;
        if listing != b"payload.command\n" {
            return Err("Unexpected 3S archive layout".into());
        }
        let bytes = capture(
            Command::new("unzip")
                .arg("-p")
                .arg(&signed)
                .arg("payload.command"),
            None,
        )?;
        if bytes.len() < 4 {
            return Err("3S returned an empty executable".into());
        }
        // The final hosted-Mac check proves signature, identity, and notarization.
        fs::write(&input, bytes).map_err(|_| "Could not save signed executable")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&input, fs::Permissions::from_mode(0o755))
                .map_err(|_| "chmod executable failed")?;
        }
        fs::copy(&input, bundle.join(&name)).map_err(|_| "Could not replace executable")?;
        fs::remove_file(archive).map_err(|_| "Could not remove input archive")?;
        fs::remove_file(signed).map_err(|_| "Could not remove result archive")?;
    }
    Ok(())
}
fn notarize(bundle: &Path) -> Result<()> {
    let names = inventory(bundle)?;
    let scratch = Scratch::new()?;
    let archive = scratch.0.join("notarize.zip");
    let mut zip = Command::new("zip");
    zip.current_dir(bundle).args(["-q", "-X"]).arg(&archive);
    for name in &names {
        zip.arg(name);
    }
    capture(&mut zip, None)?;
    let result = capture(
        Command::new("xcrun")
            .args(["notarytool", "submit"])
            .arg(&archive)
            .args([
                "--keychain-profile",
                &required("APPLE_NOTARY_PROFILE")?,
                "--keychain",
                &required("APPLE_NOTARY_KEYCHAIN")?,
                "--wait",
                "--timeout",
                "20m",
                "--output-format",
                "json",
            ]),
        None,
    )?;
    require_accepted(&result)?;
    fs::write(
        PathBuf::from(required("RUNNER_TEMP")?).join("darwin_arm64.notarization.json"),
        result,
    )
    .map_err(|_| "Could not save notarization evidence")?;
    Ok(())
}
// Job metadata is an early rejection; Vault validates the signed issuer claims.
fn admit_with(job: &str, login: impl FnOnce() -> Result<()>) -> Result<()> {
    if job != "sign-macos-3s" {
        return Err("This runner accepts only the release signing job".into());
    }
    login()
}
fn admit() -> Result<()> {
    admit_with(&required("GITHUB_JOB")?, || {
        let token = authorize("nemoclaw-release-signing-admission")?;
        drop(token);
        println!("Signing runner admission accepted by Vault");
        Ok(())
    })
}
fn run() -> Result<()> {
    let args: Vec<_> = env::args().collect();
    if args.len() == 2 && args[1] == "admit" {
        return admit();
    }
    if args.len() != 3 {
        return Err("Usage: macos-signing admit | sign BUNDLE | notarize BUNDLE".into());
    }
    let bundle = Path::new(&args[2])
        .canonicalize()
        .map_err(|_| "Missing bundle")?;
    match args[1].as_str() {
        "sign" => sign(&bundle),
        "notarize" => notarize(&bundle),
        _ => Err("Unknown signing operation".into()),
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
    #[test]
    fn unrelated_job_is_rejected_before_authentication() {
        let called = std::cell::Cell::new(false);
        assert!(admit_with("pull-request-build", || {
            called.set(true);
            Ok(())
        })
        .is_err());
        assert!(!called.get());
    }
    #[test]
    fn signing_job_is_rejected_when_vault_denies_its_identity() {
        assert!(admit_with("sign-macos-3s", || Err("identity denied".into())).is_err());
    }
    #[test]
    fn signing_job_requires_successful_admission() {
        let called = std::cell::Cell::new(false);
        assert!(admit_with("sign-macos-3s", || {
            called.set(true);
            Ok(())
        })
        .is_ok());
        assert!(called.get());
    }
    #[test]
    fn rejected_submission_stops_release() {
        assert!(require_accepted(br#"{"status":"Rejected"}"#).is_err());
    }
    #[test]
    fn incomplete_submission_stops_release() {
        assert!(require_accepted(br#"{"status":"In Progress"}"#).is_err());
        assert!(require_accepted(b"{}").is_err());
        assert!(require_accepted(b"invalid JSON").is_err());
    }
    #[test]
    fn accepted_submission_continues() {
        assert!(require_accepted(br#"{"status":"Accepted"}"#).is_ok());
    }
    #[test]
    fn regular_program_inside_bundle_is_allowed() {
        let root = std::env::temp_dir().join(format!("nemoclaw-path-test-{}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("program"), b"fixture").unwrap();
        assert!(safe_program(&root, "program").is_ok());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/etc/passwd", root.join("outside")).unwrap();
            assert!(safe_program(&root, "outside").is_err());
            std::os::unix::fs::symlink("program", root.join("alias")).unwrap();
            assert!(safe_program(&root, "alias").is_err());
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn inventory_cannot_escape_bundle() {
        assert!(safe_program(Path::new("."), "../outside").is_err());
        assert!(safe_program(Path::new("."), "/tmp/outside").is_err());
    }
}
