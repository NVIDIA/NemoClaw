// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Small object emitter using the existing pinned Rust LLVM shared library.
//! Only LLVM's C API crosses the dynamic boundary. Contexts, buffers, modules,
//! layouts, and target machines are created and disposed in that same library.
//! This avoids carrying a second full llc executable in the compiler assets.

use std::{
    env,
    ffi::{CStr, CString, OsString},
    fs,
    os::raw::{c_char, c_int, c_uint, c_void},
    path::{Path, PathBuf},
    process::Command,
    ptr,
    sync::atomic::{AtomicU64, Ordering},
};

const EXPECTED_LLVM: (u32, u32, u32) = (22, 1, 8);
const EXPECTED_RUST: &str = "1.98.1";
static NEXT: AtomicU64 = AtomicU64::new(0);
type Ref = *mut c_void;

#[cfg(unix)]
mod dynamic {
    use super::*;
    use std::os::unix::ffi::OsStrExt;
    #[cfg_attr(target_os = "linux", link(name = "dl"))]
    extern "C" {
        fn dlopen(path: *const c_char, flags: c_int) -> *mut c_void;
        fn dlsym(handle: *mut c_void, name: *const c_char) -> *mut c_void;
        fn dlclose(handle: *mut c_void) -> c_int;
        fn dlerror() -> *const c_char;
    }
    pub fn cpath(path: &Path) -> Result<CString, String> {
        CString::new(path.as_os_str().as_bytes()).map_err(|_| "path contains a NUL byte".into())
    }
    pub struct Library {
        handle: Ref,
        pub path: PathBuf,
    }
    impl Library {
        pub fn open(path: PathBuf) -> Result<Self, String> {
            let path = fs::canonicalize(path).map_err(|e| format!("LLVM library path: {e}"))?;
            let name = cpath(&path)?;
            // RTLD_NOW resolves dependencies before any function is used.
            #[cfg(target_os = "macos")]
            let flags = 2 | 4; // NOW | LOCAL
            #[cfg(not(target_os = "macos"))]
            let flags = 2; // LOCAL is zero on Linux.
            let handle = unsafe { dlopen(name.as_ptr(), flags) };
            if handle.is_null() {
                return Err(format!("load existing Rust LLVM library: {}", last_error()));
            }
            Ok(Self { handle, path })
        }
        pub unsafe fn symbol<T: Copy>(&self, name: &str) -> Result<T, String> {
            if std::mem::size_of::<T>() != std::mem::size_of::<Ref>() {
                return Err("unsupported function-pointer ABI".into());
            }
            let name = CString::new(name).map_err(|_| "symbol name contains NUL")?;
            dlerror();
            let address = dlsym(self.handle, name.as_ptr());
            if address.is_null() {
                return Err(format!(
                    "required LLVM C API {} unavailable: {}",
                    name.to_string_lossy(),
                    last_error()
                ));
            }
            // T is instantiated only with the exact extern-C signatures from
            // pinned LLVM22 llvm-c headers; no Rust or LLVM C++ ABI is assumed.
            Ok(std::mem::transmute_copy(&address))
        }
    }
    impl Drop for Library {
        fn drop(&mut self) {
            unsafe {
                dlclose(self.handle);
            }
        }
    }
    fn last_error() -> String {
        unsafe {
            let error = dlerror();
            if error.is_null() {
                "dynamic loader returned no diagnostic".into()
            } else {
                CStr::from_ptr(error).to_string_lossy().into_owned()
            }
        }
    }
}
#[cfg(not(unix))]
compile_error!("rust-llvm-llc currently supports Unix dynamic loaders only");

struct Api {
    library: dynamic::Library,
    version: (u32, u32, u32),
    context_create: unsafe extern "C" fn() -> Ref,
    context_dispose: unsafe extern "C" fn(Ref),
    create_buffer: unsafe extern "C" fn(*const c_char, *mut Ref, *mut *mut c_char) -> c_int,
    buffer_dispose: unsafe extern "C" fn(Ref),
    parse_ir: unsafe extern "C" fn(Ref, Ref, *mut Ref, *mut *mut c_char) -> c_int,
    module_dispose: unsafe extern "C" fn(Ref),
    verify: unsafe extern "C" fn(Ref, c_int, *mut *mut c_char) -> c_int,
    message_dispose: unsafe extern "C" fn(*mut c_char),
    get_target: unsafe extern "C" fn(Ref) -> *const c_char,
    get_layout: unsafe extern "C" fn(Ref) -> *const c_char,
    set_layout: unsafe extern "C" fn(Ref, *const c_char),
    target_from_triple: unsafe extern "C" fn(*const c_char, *mut Ref, *mut *mut c_char) -> c_int,
    machine_create: unsafe extern "C" fn(
        Ref,
        *const c_char,
        *const c_char,
        *const c_char,
        c_int,
        c_int,
        c_int,
    ) -> Ref,
    machine_dispose: unsafe extern "C" fn(Ref),
    create_layout: unsafe extern "C" fn(Ref) -> Ref,
    layout_string: unsafe extern "C" fn(Ref) -> *mut c_char,
    layout_dispose: unsafe extern "C" fn(Ref),
    emit: unsafe extern "C" fn(Ref, Ref, *const c_char, c_int, *mut *mut c_char) -> c_int,
}
impl Api {
    fn load(path: PathBuf) -> Result<Self, String> {
        let library = dynamic::Library::open(path)?;
        let version = unsafe {
            let get: unsafe extern "C" fn(*mut c_uint, *mut c_uint, *mut c_uint) =
                library.symbol("LLVMGetVersion")?;
            let (mut major, mut minor, mut patch) = (0, 0, 0);
            get(&mut major, &mut minor, &mut patch);
            (major, minor, patch)
        };
        if version != EXPECTED_LLVM {
            return Err(format!(
                "existing library reports LLVM {}.{}.{}, expected 22.1.8",
                version.0, version.1, version.2
            ));
        }
        // LLVMParseIRInContext2 parses both textual IR and bitcode, and does
        // NOT consume its input buffer. Its LLVM22 header explicitly assigns
        // disposal to the caller. Older consuming ParseIRInContext is rejected.
        unsafe {
            Ok(Self {
                context_create: library.symbol("LLVMContextCreate")?,
                context_dispose: library.symbol("LLVMContextDispose")?,
                create_buffer: library.symbol("LLVMCreateMemoryBufferWithContentsOfFile")?,
                buffer_dispose: library.symbol("LLVMDisposeMemoryBuffer")?,
                parse_ir: library.symbol("LLVMParseIRInContext2")?,
                module_dispose: library.symbol("LLVMDisposeModule")?,
                verify: library.symbol("LLVMVerifyModule")?,
                message_dispose: library.symbol("LLVMDisposeMessage")?,
                get_target: library.symbol("LLVMGetTarget")?,
                get_layout: library.symbol("LLVMGetDataLayoutStr")?,
                set_layout: library.symbol("LLVMSetDataLayout")?,
                target_from_triple: library.symbol("LLVMGetTargetFromTriple")?,
                machine_create: library.symbol("LLVMCreateTargetMachine")?,
                machine_dispose: library.symbol("LLVMDisposeTargetMachine")?,
                create_layout: library.symbol("LLVMCreateTargetDataLayout")?,
                layout_string: library.symbol("LLVMCopyStringRepOfTargetData")?,
                layout_dispose: library.symbol("LLVMDisposeTargetData")?,
                emit: library.symbol("LLVMTargetMachineEmitToFile")?,
                library,
                version,
            })
        }
    }
    unsafe fn message(&self, message: *mut c_char) -> String {
        if message.is_null() {
            return "LLVM returned no diagnostic".into();
        }
        let text = CStr::from_ptr(message).to_string_lossy().into_owned();
        (self.message_dispose)(message);
        text
    }
    fn initialize(&self, triple: &str) -> Result<(), String> {
        let family = if triple.starts_with("x86_64-") || triple.starts_with("x86_64h-") {
            "X86"
        } else if triple.starts_with("aarch64-") || triple.starts_with("arm64-") {
            "AArch64"
        } else {
            return Err(format!(
                "unsupported architecture in module target {triple}"
            ));
        };
        for suffix in [
            "TargetInfo",
            "Target",
            "TargetMC",
            "AsmPrinter",
            "AsmParser",
        ] {
            unsafe {
                let initialize: unsafe extern "C" fn() = self
                    .library
                    .symbol(&format!("LLVMInitialize{family}{suffix}"))?;
                initialize();
            }
        }
        Ok(())
    }
    fn emit_file(&self, input: &Path, output: &Path, codegen_level: c_int) -> Result<(), String> {
        if !(0..=3).contains(&codegen_level) {
            return Err("code-generation optimization level must be 0..3".into());
        }
        let mut owned = Owned {
            api: self,
            context: ptr::null_mut(),
            buffer: ptr::null_mut(),
            module: ptr::null_mut(),
            machine: ptr::null_mut(),
        };
        unsafe {
            owned.context = (self.context_create)();
            if owned.context.is_null() {
                return Err("LLVM context allocation failed".into());
            }
            let input = dynamic::cpath(input)?;
            let mut message = ptr::null_mut();
            if (self.create_buffer)(input.as_ptr(), &mut owned.buffer, &mut message) != 0 {
                return Err(format!("read LLVM input: {}", self.message(message)));
            }
            if owned.buffer.is_null() {
                return Err("LLVM input buffer allocation failed".into());
            }
            if !message.is_null() {
                (self.message_dispose)(message);
            }
            message = ptr::null_mut();
            if (self.parse_ir)(owned.context, owned.buffer, &mut owned.module, &mut message) != 0 {
                return Err(format!("parse LLVM input: {}", self.message(message)));
            }
            if !message.is_null() {
                (self.message_dispose)(message);
            }
            message = ptr::null_mut();
            if owned.module.is_null() {
                return Err("LLVM parser returned no module".into());
            }
            // ReturnStatusAction=2 avoids aborting on malformed verifier input.
            if (self.verify)(owned.module, 2, &mut message) != 0 {
                return Err(format!("verify LLVM module: {}", self.message(message)));
            }
            if !message.is_null() {
                (self.message_dispose)(message);
            }
            message = ptr::null_mut();
            let target = (self.get_target)(owned.module);
            if target.is_null() {
                return Err("module has no target triple".into());
            }
            let triple = CStr::from_ptr(target)
                .to_str()
                .map_err(|_| "module target is not UTF-8")?
                .to_owned();
            if triple.is_empty() {
                return Err("module target triple is empty".into());
            }
            self.initialize(&triple)?;
            let mut registered = ptr::null_mut();
            if (self.target_from_triple)(target, &mut registered, &mut message) != 0 {
                return Err(format!("resolve module target: {}", self.message(message)));
            }
            if !message.is_null() {
                (self.message_dispose)(message);
            }
            message = ptr::null_mut();
            if registered.is_null() {
                return Err("LLVM target resolution returned no target".into());
            }
            let cpu = CString::new("generic").unwrap();
            let features = CString::new("").unwrap();
            // Exact LLVM22 C enums: None/Less/Default/Aggressive=0/1/2/3,
            // PIC=2, Small=3. This selects machine code generation, not an IR
            // optimizer pipeline. Function-level CPU,
            // feature, unwind and ABI attributes remain in the parsed module.
            owned.machine = (self.machine_create)(
                registered,
                target,
                cpu.as_ptr(),
                features.as_ptr(),
                codegen_level,
                2,
                3,
            );
            if owned.machine.is_null() {
                return Err("LLVM target machine allocation failed".into());
            }
            let layout = (self.get_layout)(owned.module);
            if layout.is_null() || CStr::from_ptr(layout).to_bytes().is_empty() {
                let data = (self.create_layout)(owned.machine);
                if data.is_null() {
                    return Err("LLVM target data layout allocation failed".into());
                }
                let text = (self.layout_string)(data);
                if text.is_null() {
                    (self.layout_dispose)(data);
                    return Err("LLVM target data layout string unavailable".into());
                }
                (self.set_layout)(owned.module, text);
                (self.message_dispose)(text);
                (self.layout_dispose)(data);
            }
            let output = dynamic::cpath(output)?;
            // ObjectFile=1. The pinned LLVM22 API takes a const filename.
            if (self.emit)(
                owned.machine,
                owned.module,
                output.as_ptr(),
                1,
                &mut message,
            ) != 0
            {
                return Err(format!("emit native object: {}", self.message(message)));
            }
            if !message.is_null() {
                (self.message_dispose)(message);
            }
        }
        Ok(())
    }
}
struct Owned<'a> {
    api: &'a Api,
    context: Ref,
    buffer: Ref,
    module: Ref,
    machine: Ref,
}
impl Drop for Owned<'_> {
    fn drop(&mut self) {
        unsafe {
            // Dispose the target machine before its context, matching rustc's
            // documented ordering. Keep the input buffer through module disposal.
            if !self.machine.is_null() {
                (self.api.machine_dispose)(self.machine);
            }
            if !self.module.is_null() {
                (self.api.module_dispose)(self.module);
            }
            if !self.buffer.is_null() {
                (self.api.buffer_dispose)(self.buffer);
            }
            if !self.context.is_null() {
                (self.api.context_dispose)(self.context);
            }
        }
    }
}

fn llvm_library_filename(name: &str) -> bool {
    name == "libLLVM.dylib"
        || (name.starts_with("libLLVM") && (name.ends_with(".so") || name.contains(".so.")))
}

fn library_path() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("RUST_LLVM_LIBRARY") {
        if path.is_empty() {
            return Err("RUST_LLVM_LIBRARY is empty".into());
        }
        return Ok(path.into());
    }
    let output = Command::new("rustup")
        .args(["run", EXPECTED_RUST, "rustc", "--print", "sysroot"])
        .output()
        .map_err(|e| format!("find pinned Rust sysroot: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "find pinned Rust sysroot: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let text = String::from_utf8(output.stdout).map_err(|_| "pinned sysroot path is not UTF-8")?;
    let directory = PathBuf::from(text.trim()).join("lib");
    let mut candidates = vec![];
    for entry in fs::read_dir(&directory).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if llvm_library_filename(&name) {
            let path = fs::canonicalize(entry.path()).map_err(|e| e.to_string())?;
            if !candidates.contains(&path) {
                candidates.push(path);
            }
        }
    }
    if candidates.len() != 1 {
        return Err(format!(
            "expected one Rust LLVM shared library in {}; set RUST_LLVM_LIBRARY explicitly",
            directory.display()
        ));
    }
    Ok(candidates.remove(0))
}

enum Request {
    Version,
    Emit {
        input: PathBuf,
        output: PathBuf,
        codegen_level: c_int,
    },
    Help,
}
fn parse(arguments: Vec<OsString>) -> Result<Request, String> {
    if arguments == [OsString::from("--version")] {
        return Ok(Request::Version);
    }
    if arguments == [OsString::from("--help")] {
        return Ok(Request::Help);
    }
    let mut input = None;
    let mut output = None;
    let mut index = 0;
    let mut separated = false;
    let mut codegen_level = 0;
    let mut codegen_supplied = false;
    while index < arguments.len() {
        let argument = &arguments[index];
        if !separated && argument == "--" {
            separated = true;
            index += 1;
            continue;
        }
        if !separated && argument == "-o" {
            if output.is_some() {
                return Err("duplicate -o".into());
            }
            index += 1;
            output = Some(PathBuf::from(
                arguments.get(index).ok_or("-o requires a filename")?,
            ));
        } else if !separated && argument == "-filetype=obj" {
        } else if !separated && argument.to_string_lossy().starts_with("-O=") {
            if codegen_supplied {
                return Err("duplicate code-generation optimization option".into());
            }
            codegen_level = match argument.to_str() {
                Some("-O=0") => 0,
                Some("-O=1") => 1,
                Some("-O=2") => 2,
                Some("-O=3") => 3,
                _ => {
                    return Err(format!(
                        "unsupported LLVM emitter option: {}",
                        argument.to_string_lossy()
                    ))
                }
            };
            codegen_supplied = true;
        } else if !separated && argument.to_string_lossy().starts_with('-') {
            return Err(format!(
                "unsupported LLVM emitter option: {}",
                argument.to_string_lossy()
            ));
        } else if input.replace(PathBuf::from(argument)).is_some() {
            return Err("exactly one LLVM input is required".into());
        }
        index += 1;
    }
    let input = input.ok_or("LLVM input is required")?;
    let output = output.ok_or("-o output is required")?;
    if output.exists() {
        return Err("output already exists; refusing to replace it".into());
    }
    if input == output {
        return Err("input and output must differ".into());
    }
    Ok(Request::Emit {
        input,
        output,
        codegen_level,
    })
}
struct Stage(PathBuf);
impl Stage {
    fn new(output: &Path) -> Result<Self, String> {
        let parent = output
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        for _ in 0..32 {
            let directory = parent.join(format!(
                ".rust-llvm-llc-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&directory) {
                Ok(()) => return Ok(Self(directory)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e.to_string()),
            }
        }
        Err("cannot create owned LLVM emission staging".into())
    }
}
impl Drop for Stage {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn run() -> Result<(), String> {
    let request = parse(env::args_os().skip(1).collect())?;
    if matches!(request, Request::Help) {
        println!("rust-llvm-llc --version | -filetype=obj [-O=0|1|2|3] -o OBJECT -- LLVM_INPUT\nDefault code generation level is 0. Input IR is not reoptimized. Uses the existing pinned Rust1.98.1 LLVM22.1.8 library. Set RUST_LLVM_LIBRARY to its absolute path.");
        return Ok(());
    }
    let api = Api::load(library_path()?)?;
    match request {
        Request::Version => {
            println!("Rust LLVM C-API object emitter\nLLVM version {}.{}.{}\nExisting Rust LLVM library: {}\nLibrary bytes: {}\nSupported codegen levels: 0,1,2,3 (default 0)\nPolicy: preserve module target and attributes; PIC/Small; machine-code optimization only, no IR optimizer pipeline",api.version.0,api.version.1,api.version.2,api.library.path.display(),fs::metadata(&api.library.path).map_err(|e|e.to_string())?.len());
        }
        Request::Emit {
            input,
            output,
            codegen_level,
        } => {
            let stage = Stage::new(&output)?;
            let candidate = stage.0.join("object.o");
            api.emit_file(&input, &candidate, codegen_level)?;
            if fs::metadata(&candidate).map_err(|e| e.to_string())?.len() == 0 {
                return Err("LLVM emitted an empty object".into());
            }
            // create-only publication protects both a prior artifact and a
            // racing writer. Failed or partial LLVM output never becomes final.
            fs::hard_link(candidate, output)
                .map_err(|e| format!("publish native object without replacement: {e}"))?;
        }
        Request::Help => unreachable!(),
    }
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("rust-llvm-llc: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn rust_linux_llvm_shared_library_names_support_both_suffix_orders() {
        for name in [
            "libLLVM.so",
            "libLLVM.so.22.1-rust-1.98.1-stable",
            "libLLVM-22-rust-1.98.1-stable.so",
            "libLLVM.dylib",
        ] {
            assert!(super::llvm_library_filename(name), "{name}");
        }
        for name in [
            "libLLVM.a",
            "libLLVMCore.a",
            "notLLVM.so",
            "libLLVM.dylib.a",
        ] {
            assert!(!super::llvm_library_filename(name), "{name}");
        }
    }
}
