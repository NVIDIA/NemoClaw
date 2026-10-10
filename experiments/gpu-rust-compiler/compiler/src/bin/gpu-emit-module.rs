// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use gpu_rust_compiler::{
    codegen_service::*,
    machine_codegen::{self, MachineTarget},
    native_codegen::NativeExecutor,
};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, env, fs, io::Write, path::PathBuf, sync::Arc, time::Instant};
fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

// Own only files successfully created by this invocation. Any later error must
// discard both outputs so an object cannot outlive its qualification receipt.
struct Publication {
    files: Vec<PathBuf>,
    committed: bool,
}
impl Publication {
    fn new() -> Self {
        Self {
            files: Vec::new(),
            committed: false,
        }
    }
    fn write(&mut self, path: &PathBuf, bytes: &[u8]) -> Result<(), String> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|e| e.to_string())?;
        self.files.push(path.clone());
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())
    }
}
impl Drop for Publication {
    fn drop(&mut self) {
        if !self.committed {
            for path in &self.files {
                let _ = fs::remove_file(path);
            }
        }
    }
}
struct Reader<'a> {
    bytes: &'a [u8],
    position: usize,
}
impl Reader<'_> {
    fn bytes(&mut self, count: usize) -> Result<&[u8], String> {
        let end = self
            .position
            .checked_add(count)
            .ok_or("packet size overflow")?;
        let value = self
            .bytes
            .get(self.position..end)
            .ok_or("truncated GEM1 packet")?;
        self.position = end;
        Ok(value)
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.bytes(4)?.try_into().unwrap()))
    }
    fn i64(&mut self) -> Result<i64, String> {
        Ok(i64::from_le_bytes(self.bytes(8)?.try_into().unwrap()))
    }
    fn string(&mut self) -> Result<String, String> {
        let size = self.u32()? as usize;
        if size == 0 || size > 4096 {
            return Err("invalid packet string length".into());
        }
        String::from_utf8(self.bytes(size)?.to_vec())
            .map_err(|_| "packet string is not UTF-8".into())
    }
}
fn decode(bytes: &[u8]) -> Result<(Arc<FlatBatch>, MachineTarget), String> {
    if bytes.len() > 128 * 1024 * 1024 {
        return Err("GEM1 input exceeds 128 MiB".into());
    }
    let mut reader = Reader { bytes, position: 0 };
    if reader.bytes(4)? != b"GEM1" {
        return Err("unsupported leaf packet schema".into());
    }
    let triple = reader.string()?;
    let target = if triple.starts_with("x86_64-") {
        MachineTarget::X86_64
    } else if triple.starts_with("aarch64-") || triple.starts_with("arm64-") {
        MachineTarget::Aarch64
    } else {
        return Err("unsupported machine architecture".into());
    };
    // Rust target names and LLVM's Darwin triples name the same scalar ABI.
    // Preserve the original LLVM spelling in the receipt; only the ABI key is
    // normalized. No module target or target instructions are rewritten.
    let abi_triple =
        if triple.starts_with("arm64-apple-macosx") || triple.starts_with("aarch64-apple-macosx") {
            "aarch64-apple-darwin".to_string()
        } else if triple.starts_with("x86_64-apple-macosx") {
            "x86_64-apple-darwin".to_string()
        } else {
            triple.clone()
        };
    let count = reader.u32()? as usize;
    if count == 0 || count > 65536 {
        return Err("packet function count is out of bounds".into());
    }
    let mut functions = Vec::new();
    let mut instructions = Vec::new();
    let mut symbols = Vec::new();
    let mut abis = Vec::new();
    for index in 0..count {
        let name = reader.string()?;
        let params = reader.u32()?;
        let unwind = reader.u32()?;
        let values = reader.u32()?;
        let ops = reader.u32()?;
        if params > 1 || unwind > 1 || values == 0 || values > 256 || ops == 0 || ops > 4096 {
            return Err("leaf function dimensions are out of bounds".into());
        }
        let start = u32::try_from(instructions.len()).map_err(|_| "instruction count overflow")?;
        for _ in 0..ops {
            let opcode = match reader.u32()? {
                0 => Opcode::Argument,
                1 => Opcode::Const,
                2 => Opcode::Copy,
                3 => Opcode::Add,
                4 => Opcode::Sub,
                5 => Opcode::Mul,
                6 => Opcode::Return,
                _ => return Err("unsupported leaf opcode".into()),
            };
            let result = reader.u32()?;
            let a = reader.u32()?;
            let b = reader.u32()?;
            let immediate = reader.i64()?;
            instructions.push(Instruction {
                opcode,
                result: (result != u32::MAX).then_some(result),
                operands: [a, b],
                immediate,
            });
        }
        functions.push(Function {
            symbol: index as u32,
            instruction_start: start,
            instruction_count: ops,
            value_count: values,
            abi: index as u32,
        });
        symbols.push(Symbol { name });
        abis.push(Abi {
            calling_convention: if target == MachineTarget::Aarch64 && abi_triple.contains("apple")
            {
                CallingConvention::AppleAarch64
            } else {
                CallingConvention::SystemV
            },
            parameter_count: params,
            returns_i64: true,
            requires_unwind: unwind == 1,
        });
    }
    if reader.position != bytes.len() {
        return Err("trailing bytes in GEM1 packet".into());
    }
    let batch = Arc::new(FlatBatch::new(
        BatchIdentity {
            workload_id: hash(bytes),
            toolchain_id: "rust1.98.1-llvm22.1.8-GEM1".into(),
            policy_id: "fast-leaf-fixedframe-v1".into(),
            target_abi: abi_triple,
            source_revision: hash(include_bytes!("../machine_codegen.rs")),
        },
        BatchKey {
            logical_id: "llvm-module".into(),
            generation: 1,
        },
        functions,
        instructions,
        symbols,
        abis,
    )?);
    machine_codegen::pack(&batch, target)?;
    Ok((batch, target))
}
fn run() -> Result<(), String> {
    let mut options = BTreeMap::new();
    let mut args = env::args().skip(1);
    while let Some(key) = args.next() {
        if key == "--help" {
            println!("gpu-emit-module --input GEM1 --output OBJECT --backend metal|cuda --library FILE [--shader FILE] [--device N] --report JSON\nStrict LLVM leaf-module lowering only; other Rust modules require explicit fallback.");
            return Ok(());
        }
        if ![
            "--input",
            "--output",
            "--backend",
            "--library",
            "--shader",
            "--device",
            "--report",
        ]
        .contains(&key.as_str())
        {
            return Err(format!("unknown option{key}"));
        }
        let value = args
            .next()
            .ok_or_else(|| format!("missing value for{key}"))?;
        if options.insert(key.clone(), value).is_some() {
            return Err(format!("duplicate option{key}"));
        }
    }
    let required = |key: &str| {
        options
            .get(key)
            .cloned()
            .ok_or_else(|| format!("missing{key}"))
    };
    let input = PathBuf::from(required("--input")?);
    let output = PathBuf::from(required("--output")?);
    let report = PathBuf::from(required("--report")?);
    if output.exists() || report.exists() || output == report {
        return Err("output/report must be distinct new files".into());
    }
    let backend = match required("--backend")?.as_str() {
        "metal" => GpuBackend::Metal,
        "cuda" => GpuBackend::Cuda,
        _ => return Err("backend must be metal or cuda".into()),
    };
    let library = PathBuf::from(required("--library")?);
    let shader = options.get("--shader").map(PathBuf::from);
    let device = options
        .get("--device")
        .map_or(Ok(0), |s| s.parse::<u32>().map_err(|_| "invalid device"))?;
    let all = Instant::now();
    let data = fs::read(&input).map_err(|e| e.to_string())?;
    let (batch, target) = decode(&data)?;
    let init = Instant::now();
    let executor = NativeExecutor::new(backend, target, &library, shader.as_deref(), device)?;
    let stats = executor.stats();
    let session = BuildSession::new(
        SessionConfig {
            cpu_credit_limit: 1,
            ..Default::default()
        },
        vec![Box::new(executor)],
    )
    .map_err(|e| e.to_string())?;
    let client = session
        .register_client("rust-leaf-module", 1)
        .map_err(|e| e.to_string())?;
    let initialization_ms = init.elapsed().as_secs_f64() * 1000.;
    let ticket = session
        .submit(
            &client,
            batch.clone(),
            SubmitOptions {
                placement: Placement::RequireGpu(backend),
                ..Default::default()
            },
        )
        .map_err(|e| e.to_string())?;
    let receipt = ticket.wait().map_err(|e| e.to_string())?;
    if !session.is_current(&receipt) {
        return Err("stale GPU module cannot be published".into());
    }
    // Verification is included in total elapsed time, never hidden as a GPU win.
    let oracle = machine_codegen::cpu_emit(&batch, target)?;
    let mut expected = oracle.functions;
    expected.sort_by_key(|f| f.symbol);
    let mut actual = receipt.output.functions.clone();
    actual.sort_by_key(|f| f.symbol);
    if actual != expected {
        return Err("GPU module differs from CPU encoding oracle".into());
    }
    let bytes = machine_codegen::write_object(&batch, target, &receipt.output)?;
    let file = object::File::parse(bytes.as_slice()).map_err(|e| e.to_string())?;
    use object::Object as _;
    if file.kind() != object::ObjectKind::Relocatable {
        return Err("GPU output is not a relocatable object".into());
    }
    let mut publication = Publication::new();
    publication.write(&output, &bytes)?;
    let native_stats = stats.lock().unwrap().clone();
    let dispatches = native_stats
        .iter()
        .map(|s| s.kernel_dispatches)
        .sum::<u64>();
    let mut original = Reader {
        bytes: &data,
        position: 4,
    };
    let llvm_input_target = original.string()?;
    let json = serde_json::json!({"schema":"gpu-emit-module","version":1,"backend":match backend{GpuBackend::Metal=>"metal",GpuBackend::Cuda=>"cuda"},"physical_gpu":receipt.execution.is_physical_gpu(),"device_id":receipt.route.device_id,"kernel_dispatches":dispatches,"kernel_output_used":true,"gpu_executed":true,"performance_speedup_demonstrated":false,"scope":"strict whole LLVM leaf module to native object; CPU generates required unwind metadata; unsupported Rust modules must use explicit fallback","input_packet_sha256":hash(&data),"object_bytes":bytes.len(),"object_sha256":hash(&bytes),"function_count":batch.functions().len(),"target":batch.identity().target_abi,"llvm_input_target":llvm_input_target,"total_elapsed_ms":all.elapsed().as_secs_f64()*1000.,"initialization_ms":initialization_ms,"cpu_byte_oracle_verified":true,"unwind_metadata_required":batch.abis().iter().any(|a|a.requires_unwind),"native_library_sha256":hash(&fs::read(&library).map_err(|e|e.to_string())?),"native_stats":native_stats,"timing_scope":"includes packet decode/validation, GPU setup, GPU work/wait, CPU byte oracle, unwind/object serialization and output write; no original LLVM native object emission"});
    let text = serde_json::to_vec_pretty(&json).map_err(|e| e.to_string())?;
    publication.write(&report, &text)?;
    publication.committed = true;
    println!("{}", String::from_utf8_lossy(&text));
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("gpu-emit-module: {error}");
        std::process::exit(1);
    }
}
