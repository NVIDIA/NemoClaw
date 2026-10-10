// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

pub const TPDE_REVISION: &str = "9779acf4ada3736e779391da1e4b3369dba08024";
pub const LLVM_VERSION: &str = "22.1.8";
pub const RUST_VERSION: &str = "1.98.1";

#[derive(Clone, Debug)]
pub struct Invocation {
    pub program: PathBuf,
    pub args: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct ToolOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

pub trait Runner {
    fn run(&mut self, invocation: &Invocation) -> Result<ToolOutput, String>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Backend {
    Tpde,
    Llvm,
}

#[derive(Clone, Debug)]
pub struct CompileRequest {
    pub input: PathBuf,
    pub output: PathBuf,
    pub bridge: PathBuf,
    pub llc: PathBuf,
    pub allow_fallback: bool,
    pub backend: Backend,
    pub llvm_codegen_opt_level: u8,
}

#[derive(Debug)]
pub struct CompileReport {
    pub backend: String,
    pub target: String,
    pub fallback_reason: Option<String>,
    pub object_bytes: u64,
    pub elapsed_ms: f64,
    pub stages: Vec<(String, f64)>,
    pub rustc_ident: Option<String>,
    pub llvm_codegen_opt_level: Option<u8>,
}

static NEXT_STAGE: AtomicU64 = AtomicU64::new(0);

struct StageDir(PathBuf);
impl StageDir {
    fn new(parent: &Path) -> Result<Self, String> {
        for _ in 0..32 {
            let p = parent.join(format!(
                ".fast-backend-{}-{}",
                std::process::id(),
                NEXT_STAGE.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&p) {
                Ok(()) => return Ok(Self(p)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(format!("create staging directory: {e}")),
            }
        }
        Err("could not create a unique staging directory".into())
    }
}
impl Drop for StageDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn path_arg(p: &Path) -> Result<String, String> {
    p.to_str()
        .map(str::to_owned)
        .ok_or_else(|| "paths must be UTF-8".into())
}

fn fields(text: &str) -> Result<BTreeMap<&str, &str>, String> {
    let mut out = BTreeMap::new();
    for line in text.lines() {
        let (key, value) = line.split_once('=').ok_or("invalid bridge protocol")?;
        if out.insert(key, value).is_some() {
            return Err("duplicate bridge protocol field".into());
        }
    }
    Ok(out)
}

fn timed_run(
    runner: &mut impl Runner,
    invocation: Invocation,
    name: &str,
    stages: &mut Vec<(String, f64)>,
) -> Result<ToolOutput, String> {
    let start = Instant::now();
    let result = runner.run(&invocation);
    stages.push((name.into(), start.elapsed().as_secs_f64() * 1000.0));
    result
}

fn tool_failure(label: &str, result: ToolOutput) -> String {
    format!("{label}: {}", result.stderr.trim())
}

pub fn compile(req: &CompileRequest, runner: &mut impl Runner) -> Result<CompileReport, String> {
    let start = Instant::now();
    if req.llvm_codegen_opt_level > 3 {
        return Err("LLVM codegen optimization level must be 0..=3".into());
    }
    if req.output.exists() {
        return Err(format!("output already exists: {}", req.output.display()));
    }
    if !req.input.is_file() {
        return Err(format!("input is not a file: {}", req.input.display()));
    }
    let parent = req
        .output
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let stage = StageDir::new(parent)?;
    let temporary = stage.0.join("candidate.o");
    let mut stages = vec![];
    let provenance = timed_run(
        runner,
        Invocation {
            program: req.bridge.clone(),
            args: vec!["--probe".into()],
        },
        "provenance",
        &mut stages,
    )?;
    if !provenance.success {
        return Err(tool_failure("backend provenance failed", provenance));
    }
    let p = fields(&provenance.stdout)?;
    if p.get("protocol") != Some(&"1")
        || p.get("tpde_revision") != Some(&TPDE_REVISION)
        || p.get("llvm_version") != Some(&LLVM_VERSION)
    {
        return Err("backend provenance does not match the pinned TPDE/LLVM versions".into());
    }
    let inspection = timed_run(
        runner,
        Invocation {
            program: req.bridge.clone(),
            args: vec!["--inspect".into(), path_arg(&req.input)?],
        },
        "parse-and-verify",
        &mut stages,
    )?;
    if !inspection.success {
        return Err(tool_failure("input verification failed", inspection));
    }
    let i = fields(&inspection.stdout)?;
    let target = i
        .get("target")
        .ok_or("input has no target triple")?
        .to_string();
    let kind = target_kind(&target)?;
    let rustc_ident = i
        .get("rustc_ident")
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    if let Some(ref ident) = rustc_ident {
        if !ident.starts_with(&format!("rustc version {RUST_VERSION} ")) {
            return Err(format!(
                "Rust producer does not match pinned {RUST_VERSION}: {ident}"
            ));
        }
    }
    let mut fallback_reason = None;
    let mut backend = "tpde";
    if req.backend == Backend::Tpde && kind.0 == "elf" {
        let fast = timed_run(
            runner,
            Invocation {
                program: req.bridge.clone(),
                args: vec![
                    "--compile".into(),
                    path_arg(&req.input)?,
                    path_arg(&temporary)?,
                ],
            },
            "tpde-codegen",
            &mut stages,
        );
        match fast {
            Ok(result) if result.success => {}
            Ok(result) => fallback_reason = Some(tool_failure("TPDE rejected module", result)),
            Err(e) => fallback_reason = Some(format!("TPDE invocation failed: {e}")),
        }
    } else if req.backend == Backend::Tpde {
        fallback_reason = Some(format!("TPDE does not support target {target}"));
    }
    if let Some(ref reason) = fallback_reason {
        if !req.allow_fallback {
            return Err(reason.clone());
        }
    }
    if req.backend == Backend::Llvm || fallback_reason.is_some() {
        // A failed backend may have written bytes; never validate or commit those bytes.
        if temporary.exists() {
            fs::remove_file(&temporary).map_err(|e| format!("remove failed candidate: {e}"))?;
        }
        let version = timed_run(
            runner,
            Invocation {
                program: req.llc.clone(),
                args: vec!["--version".into()],
            },
            "llvm-provenance",
            &mut stages,
        )?;
        if !version.success
            || !version
                .stdout
                .lines()
                .filter_map(|line| line.split_once("LLVM version "))
                .any(|(_, version)| version.split_whitespace().next() == Some(LLVM_VERSION))
        {
            return Err(format!(
                "LLVM fallback must report LLVM version {LLVM_VERSION}"
            ));
        }
        let result = timed_run(
            runner,
            Invocation {
                program: req.llc.clone(),
                args: vec![
                    "-filetype=obj".into(),
                    format!("-O={}", req.llvm_codegen_opt_level),
                    "-o".into(),
                    path_arg(&temporary)?,
                    "--".into(),
                    path_arg(&req.input)?,
                ],
            },
            "llvm-codegen",
            &mut stages,
        )?;
        if !result.success {
            return Err(tool_failure("LLVM fallback failed", result));
        }
        backend = "llvm";
    }
    let validation_start = Instant::now();
    let object_bytes = validate_object(&temporary, &target)?;
    stages.push((
        "object-validation".into(),
        validation_start.elapsed().as_secs_f64() * 1000.0,
    ));
    // Hard-link publication creates the destination only if absent, preserving a racing writer.
    fs::hard_link(&temporary, &req.output)
        .map_err(|e| format!("commit object without replacing output: {e}"))?;
    Ok(CompileReport {
        backend: backend.into(),
        target,
        fallback_reason,
        object_bytes,
        elapsed_ms: start.elapsed().as_secs_f64() * 1000.0,
        stages,
        rustc_ident,
        llvm_codegen_opt_level: (backend == "llvm").then_some(req.llvm_codegen_opt_level),
    })
}

fn target_kind(target: &str) -> Result<(&'static str, u16), String> {
    let machine = if target.starts_with("x86_64-") {
        62
    } else if target.starts_with("aarch64-") || target.starts_with("arm64-") {
        183
    } else {
        return Err(format!("unsupported object architecture: {target}"));
    };
    if target.contains("-linux-") {
        Ok(("elf", machine))
    } else if target.contains("-apple-") && (target.contains("darwin") || target.contains("macosx"))
    {
        Ok(("macho", machine))
    } else {
        Err(format!("unsupported object platform: {target}"))
    }
}

fn u16_at(data: &[u8], at: usize) -> u16 {
    u16::from_le_bytes(data[at..at + 2].try_into().unwrap())
}
fn u32_at(data: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(data[at..at + 4].try_into().unwrap())
}
fn u64_at(data: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(data[at..at + 8].try_into().unwrap())
}

pub fn validate_object(path: &Path, target: &str) -> Result<u64, String> {
    let data = fs::read(path).map_err(|e| format!("read emitted object: {e}"))?;
    let (format, machine) = target_kind(target)?;
    if format == "elf" {
        if data.len() < 64
            || &data[..7] != b"\x7fELF\x02\x01\x01"
            || u16_at(&data, 16) != 1
            || u32_at(&data, 20) != 1
        {
            return Err("backend did not produce a little-endian ELF64 relocatable object".into());
        }
        if u16_at(&data, 18) != machine {
            return Err("object machine does not match the input target".into());
        }
        let table = usize::try_from(u64_at(&data, 40)).map_err(|_| "invalid ELF section table")?;
        let count = usize::from(u16_at(&data, 60));
        if u16_at(&data, 52) != 64
            || u16_at(&data, 58) != 64
            || count < 2
            || table < 64
            || table
                .checked_add(count * 64)
                .filter(|&end| end <= data.len())
                .is_none()
        {
            return Err("truncated or unsupported ELF section table".into());
        }
        for index in 0..count {
            let at = table + index * 64;
            // SHT_NOBITS occupies memory but no bytes in the file.
            if u32_at(&data, at + 4) != 8 {
                let off = u64_at(&data, at + 24);
                let len = u64_at(&data, at + 32);
                if off
                    .checked_add(len)
                    .filter(|&end| end <= data.len() as u64)
                    .is_none()
                {
                    return Err("ELF section extends beyond emitted object".into());
                }
            }
        }
    } else {
        let cpu = if machine == 62 {
            0x0100_0007
        } else {
            0x0100_000c
        };
        if data.len() < 32 || u32_at(&data, 0) != 0xfeed_facf || u32_at(&data, 12) != 1 {
            return Err("backend did not produce a Mach-O 64-bit relocatable object".into());
        }
        if u32_at(&data, 4) != cpu {
            return Err("object machine does not match the input target".into());
        }
        if 32usize
            .checked_add(u32_at(&data, 20) as usize)
            .filter(|&end| end <= data.len())
            .is_none()
        {
            return Err("truncated Mach-O load commands".into());
        }
    }
    Ok(data.len() as u64)
}

pub struct ProcessRunner {
    pub timeout: Duration,
}
fn read_bounded(mut source: impl Read) -> String {
    const LIMIT: usize = 256 * 1024;
    let mut saved = Vec::new();
    let mut buf = [0; 8192];
    let mut truncated = false;
    loop {
        match source.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let keep = n.min(LIMIT.saturating_sub(saved.len()));
                saved.extend_from_slice(&buf[..keep]);
                truncated |= keep < n;
            }
        }
    }
    let mut out = String::from_utf8_lossy(&saved).into_owned();
    if truncated {
        out.push_str("\n[tool output truncated]\n");
    }
    out
}
impl Runner for ProcessRunner {
    fn run(&mut self, invocation: &Invocation) -> Result<ToolOutput, String> {
        let mut child = Command::new(&invocation.program)
            .args(&invocation.args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("start {}: {e}", invocation.program.display()))?;
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let stdout_thread = std::thread::spawn(move || read_bounded(stdout));
        let stderr_thread = std::thread::spawn(move || read_bounded(stderr));
        let start = Instant::now();
        let result = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Ok(status.success()),
                Ok(None) if start.elapsed() >= self.timeout => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break Err(format!("tool exceeded {} seconds", self.timeout.as_secs()));
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(10)),
                Err(e) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break Err(format!("wait for tool: {e}"));
                }
            }
        };
        let stdout = stdout_thread
            .join()
            .unwrap_or_else(|_| "stdout reader failed".into());
        let stderr = stderr_thread
            .join()
            .unwrap_or_else(|_| "stderr reader failed".into());
        Ok(ToolOutput {
            success: result?,
            stdout,
            stderr,
        })
    }
}

pub fn json_string(value: &str) -> String {
    let mut out = String::from("\"");
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c < ' ' => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
impl CompileReport {
    pub fn to_json(&self) -> String {
        let stages = self
            .stages
            .iter()
            .map(|(name, ms)| format!("{{\"name\":{},\"elapsed_ms\":{ms:.6}}}", json_string(name)))
            .collect::<Vec<_>>()
            .join(",");
        let llvm_level = self
            .llvm_codegen_opt_level
            .map(|level| level.to_string())
            .unwrap_or_else(|| "null".into());
        let llvm_scope = self
            .llvm_codegen_opt_level
            .map(|_| json_string("llvm-target-machine-codegen-only"))
            .unwrap_or_else(|| "null".into());
        format!("{{\"schema\":1,\"scope\":\"captured-llvm-module-to-object\",\"gpu_accelerated\":false,\"backend\":{},\"target\":{},\"tpde_revision\":{},\"llvm_version\":{},\"llvm_codegen_opt_level\":{},\"llvm_codegen_opt_scope\":{},\"expected_rust_version\":{},\"rustc_ident\":{},\"fallback_reason\":{},\"object_bytes\":{},\"elapsed_ms\":{:.6},\"stages\":[{}]}}\n", json_string(&self.backend), json_string(&self.target), json_string(TPDE_REVISION), json_string(LLVM_VERSION), llvm_level, llvm_scope, json_string(RUST_VERSION), self.rustc_ident.as_deref().map(json_string).unwrap_or_else(|| "null".into()), self.fallback_reason.as_deref().map(json_string).unwrap_or_else(|| "null".into()), self.object_bytes, self.elapsed_ms, stages)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static ID: AtomicU64 = AtomicU64::new(0);

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "fast-backend-test-{}-{}",
                std::process::id(),
                ID.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&p).unwrap();
            Self(p)
        }
        fn request(&self, allow_fallback: bool) -> CompileRequest {
            let input = self.0.join("input with spaces;literal.ll");
            fs::write(&input, "target triple = \"x86_64-unknown-linux-gnu\"\n").unwrap();
            CompileRequest {
                input,
                output: self.0.join("output with spaces;literal.o"),
                bridge: PathBuf::from("bridge with spaces"),
                llc: PathBuf::from("llc with spaces"),
                allow_fallback,
                backend: Backend::Tpde,
                llvm_codegen_opt_level: 0,
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn elf(machine: u16) -> Vec<u8> {
        let mut data = vec![0; 200];
        data[..7].copy_from_slice(b"\x7fELF\x02\x01\x01");
        data[16..18].copy_from_slice(&1u16.to_le_bytes());
        data[18..20].copy_from_slice(&machine.to_le_bytes());
        data[20..24].copy_from_slice(&1u32.to_le_bytes());
        data[40..48].copy_from_slice(&72u64.to_le_bytes());
        data[52..54].copy_from_slice(&64u16.to_le_bytes());
        data[58..60].copy_from_slice(&64u16.to_le_bytes());
        data[60..62].copy_from_slice(&2u16.to_le_bytes());
        data[64] = 0xc3;
        data[140..144].copy_from_slice(&1u32.to_le_bytes());
        data[144..152].copy_from_slice(&6u64.to_le_bytes());
        data[160..168].copy_from_slice(&64u64.to_le_bytes());
        data[168..176].copy_from_slice(&1u64.to_le_bytes());
        data
    }

    fn ok(stdout: &str) -> ToolOutput {
        ToolOutput {
            success: true,
            stdout: stdout.into(),
            stderr: String::new(),
        }
    }
    fn provenance() -> ToolOutput {
        ok(&format!(
            "protocol=1\ntpde_revision={TPDE_REVISION}\nllvm_version={LLVM_VERSION}\n"
        ))
    }
    fn inspected(target: &str) -> ToolOutput {
        ok(&format!("target={target}\n"))
    }

    struct FakeRunner {
        replies: VecDeque<ToolOutput>,
        calls: Vec<Invocation>,
        object: Vec<u8>,
    }
    impl Runner for FakeRunner {
        fn run(&mut self, invocation: &Invocation) -> Result<ToolOutput, String> {
            self.calls.push(invocation.clone());
            let reply = self.replies.pop_front().expect("unexpected invocation");
            if invocation.args.first().map(String::as_str) == Some("--compile") {
                fs::write(&invocation.args[2], &self.object).unwrap();
            } else if invocation.args.first().map(String::as_str) == Some("-filetype=obj") {
                let i = invocation.args.iter().position(|a| a == "-o").unwrap();
                fs::write(&invocation.args[i + 1], &self.object).unwrap();
            }
            Ok(reply)
        }
    }
    fn runner(replies: Vec<ToolOutput>) -> FakeRunner {
        FakeRunner {
            replies: replies.into(),
            calls: vec![],
            object: elf(62),
        }
    }

    #[test]
    fn verified_fast_object_is_committed_and_paths_are_separate_arguments() {
        let f = Fixture::new();
        let req = f.request(false);
        let mut r = runner(vec![
            provenance(),
            inspected("x86_64-unknown-linux-gnu"),
            ok(""),
        ]);
        let report = compile(&req, &mut r).unwrap();
        assert_eq!(report.backend, "tpde");
        assert!(report.fallback_reason.is_none());
        assert_eq!(fs::read(&req.output).unwrap(), elf(62));
        assert_eq!(r.calls[2].args[1], req.input.to_str().unwrap());
        assert_eq!(r.calls[2].program, req.bridge);
    }

    #[test]
    fn unsupported_fast_construct_uses_llvm_only_when_fallback_was_selected() {
        let f = Fixture::new();
        let req = f.request(true);
        let failure = ToolOutput {
            success: false,
            stdout: String::new(),
            stderr: "unsupported intrinsic".into(),
        };
        let mut r = runner(vec![
            provenance(),
            inspected("x86_64-unknown-linux-gnu"),
            failure,
            ok("LLVM version 22.1.8\n"),
            ok(""),
        ]);
        let report = compile(&req, &mut r).unwrap();
        assert_eq!(report.backend, "llvm");
        assert!(report
            .fallback_reason
            .unwrap()
            .contains("unsupported intrinsic"));
        assert_eq!(r.calls[4].args.last().unwrap(), req.input.to_str().unwrap());
    }

    #[test]
    fn required_fast_backend_never_silently_falls_back() {
        let f = Fixture::new();
        let req = f.request(false);
        let failure = ToolOutput {
            success: false,
            stdout: String::new(),
            stderr: "unsupported intrinsic".into(),
        };
        let mut r = runner(vec![
            provenance(),
            inspected("x86_64-unknown-linux-gnu"),
            failure,
        ]);
        assert!(compile(&req, &mut r)
            .unwrap_err()
            .contains("unsupported intrinsic"));
        assert_eq!(r.calls.len(), 3);
        assert!(!req.output.exists());
    }

    #[test]
    fn wrong_backend_provenance_is_rejected_before_compilation() {
        let f = Fixture::new();
        let req = f.request(true);
        let mut r = runner(vec![ok(
            "protocol=1\ntpde_revision=wrong\nllvm_version=22.1.8\n",
        )]);
        assert!(compile(&req, &mut r).unwrap_err().contains("provenance"));
        assert_eq!(r.calls.len(), 1);
        assert!(!req.output.exists());
    }

    #[test]
    fn wrong_object_machine_is_rejected_without_committing_output() {
        let f = Fixture::new();
        let req = f.request(false);
        let mut r = runner(vec![
            provenance(),
            inspected("x86_64-unknown-linux-gnu"),
            ok(""),
        ]);
        r.object = elf(183);
        assert!(compile(&req, &mut r).unwrap_err().contains("machine"));
        assert!(!req.output.exists());
    }

    #[test]
    fn truncated_object_and_existing_output_are_rejected() {
        let f = Fixture::new();
        let req = f.request(false);
        fs::write(&req.output, "existing").unwrap();
        let mut r = runner(vec![]);
        assert!(compile(&req, &mut r).unwrap_err().contains("exists"));
        assert_eq!(fs::read(&req.output).unwrap(), b"existing");
        fs::remove_file(&req.output).unwrap();
        fs::write(&req.output, b"\x7fELF").unwrap();
        assert!(validate_object(&req.output, "x86_64-unknown-linux-gnu").is_err());
    }

    #[test]
    fn invalid_ir_inspection_never_triggers_a_backend_fallback() {
        let f = Fixture::new();
        let req = f.request(true);
        let mut r = runner(vec![
            provenance(),
            ToolOutput {
                success: false,
                stdout: String::new(),
                stderr: "invalid IR".into(),
            },
        ]);
        assert!(compile(&req, &mut r).unwrap_err().contains("invalid IR"));
        assert_eq!(r.calls.len(), 2);
        assert!(!req.output.exists());
    }

    #[test]
    fn matching_distribution_llvm_version_is_accepted_for_fallback() {
        let f = Fixture::new();
        let req = f.request(true);
        let failure = ToolOutput {
            success: false,
            stdout: String::new(),
            stderr: "unsupported intrinsic".into(),
        };
        let mut r = runner(vec![
            provenance(),
            inspected("x86_64-unknown-linux-gnu"),
            failure,
            ok("Debian LLVM version 22.1.8\n  Optimized build.\n"),
            ok(""),
        ]);
        assert_eq!(compile(&req, &mut r).unwrap().backend, "llvm");
    }

    #[test]
    fn an_explicit_llvm_baseline_never_attempts_tpde_or_reports_a_fallback() {
        let f = Fixture::new();
        let mut req = f.request(false);
        req.backend = Backend::Llvm;
        let mut r = runner(vec![
            provenance(),
            inspected("x86_64-unknown-linux-gnu"),
            ok("LLVM version 22.1.8\n"),
            ok(""),
        ]);
        let report = compile(&req, &mut r).unwrap();
        assert_eq!(report.backend, "llvm");
        assert!(report.fallback_reason.is_none());
        assert_eq!(r.calls[2].args, vec!["--version"]);
    }

    #[test]
    fn selected_llvm_codegen_level_reaches_direct_and_fallback_commands() {
        for level in [3, 2, 1, 0] {
            for backend in [Backend::Llvm, Backend::Tpde] {
                let f = Fixture::new();
                let mut req = f.request(true);
                req.backend = backend;
                req.llvm_codegen_opt_level = level;
                let mut replies = vec![provenance(), inspected("x86_64-unknown-linux-gnu")];
                if backend == Backend::Tpde {
                    replies.push(ToolOutput {
                        success: false,
                        stdout: String::new(),
                        stderr: "unsupported intrinsic".into(),
                    });
                }
                replies.extend([ok("LLVM version 22.1.8\n"), ok("")]);
                let mut r = runner(replies);
                let report = compile(&req, &mut r).unwrap();
                let command = r.calls.last().unwrap();
                assert_eq!(command.program, req.llc);
                assert_eq!(command.args[1], format!("-O={level}"));
                let json = report.to_json();
                assert!(json.contains(&format!("\"llvm_codegen_opt_level\":{level}")));
                assert!(json
                    .contains("\"llvm_codegen_opt_scope\":\"llvm-target-machine-codegen-only\""));
            }
        }
    }

    #[test]
    fn llvm_level_does_not_change_successful_tpde_commands_or_quality_report() {
        let f = Fixture::new();
        let mut req = f.request(false);
        req.llvm_codegen_opt_level = 3;
        let mut r = runner(vec![
            provenance(),
            inspected("x86_64-unknown-linux-gnu"),
            ok(""),
        ]);
        let report = compile(&req, &mut r).unwrap();
        assert_eq!(r.calls.len(), 3);
        assert_eq!(r.calls[2].args[0], "--compile");
        assert_eq!(r.calls[2].args.len(), 3);
        let json = report.to_json();
        assert!(json.contains("\"llvm_codegen_opt_level\":null"));
        assert!(json.contains("\"llvm_codegen_opt_scope\":null"));
    }

    #[test]
    fn invalid_llvm_codegen_level_is_rejected_before_any_tool_runs() {
        let f = Fixture::new();
        let mut req = f.request(true);
        req.llvm_codegen_opt_level = 4;
        let mut r = runner(vec![]);
        assert!(compile(&req, &mut r)
            .unwrap_err()
            .contains("LLVM codegen optimization level must be 0..=3"));
        assert!(r.calls.is_empty());
        assert!(!req.output.exists());
    }

    #[cfg(unix)]
    #[test]
    fn real_process_runner_preserves_literal_arguments_and_enforces_timeout() {
        let mut r = ProcessRunner {
            timeout: Duration::from_secs(1),
        };
        let value = "spaces ; $() ' \" \\ newline\n";
        let result = r
            .run(&Invocation {
                program: PathBuf::from("/usr/bin/printf"),
                args: vec!["%s".into(), value.into()],
            })
            .unwrap();
        assert!(result.success);
        assert_eq!(result.stdout, value);
        r.timeout = Duration::from_millis(20);
        let result = r.run(&Invocation {
            program: PathBuf::from("/bin/sleep"),
            args: vec!["10".into()],
        });
        assert!(result.unwrap_err().contains("exceeded"));
    }
}
