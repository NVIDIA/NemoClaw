// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Build-scoped scheduling for immutable scalar emission batches.
//!
//! Schema 1 is an integer, straight-line code-emission fixture, not resolved
//! Rust MIR. Its ABI records describe only scalar i64 arguments and results.
//! The CPU callback runs actual work. Simulated devices can test scheduling but
//! cannot satisfy required hardware placement or publish physical GPU evidence.
//! Client credits are explicitly supplied by the caller; this module does not
//! acquire Cargo jobserver tokens or provide an interprocess daemon.

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fmt,
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Condvar, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

pub const SCHEMA_VERSION: u32 = 1;
static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BatchIdentity {
    pub workload_id: String,
    pub toolchain_id: String,
    pub policy_id: String,
    pub target_abi: String,
    pub source_revision: String,
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct BatchKey {
    pub logical_id: String,
    pub generation: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum CallingConvention {
    SystemV = 0,
    AppleAarch64 = 1,
    WindowsX64 = 2,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Abi {
    pub calling_convention: CallingConvention,
    pub parameter_count: u32,
    pub returns_i64: bool,
    pub requires_unwind: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Symbol {
    pub name: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Function {
    pub symbol: u32,
    pub instruction_start: u32,
    pub instruction_count: u32,
    pub value_count: u32,
    pub abi: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Opcode {
    Argument = 0,
    Const = 1,
    Copy = 2,
    Add = 3,
    Sub = 4,
    Mul = 5,
    Return = 6,
}

/// Operand slots not used by the opcode must be zero. Arithmetic is wrapping
/// i64; Argument's immediate is the zero-based scalar argument index.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Instruction {
    pub opcode: Opcode,
    pub result: Option<u32>,
    pub operands: [u32; 2],
    pub immediate: i64,
}

/// Private owned arrays enforce validate-once, read-only submission. A caller
/// cannot mutate an accepted input or reuse its storage while work is pending.
#[derive(Debug)]
pub struct FlatBatch {
    identity: BatchIdentity,
    key: BatchKey,
    functions: Box<[Function]>,
    instructions: Box<[Instruction]>,
    symbols: Box<[Symbol]>,
    abis: Box<[Abi]>,
    validation: Duration,
    owned_bytes: usize,
}

impl FlatBatch {
    pub fn new(
        identity: BatchIdentity,
        key: BatchKey,
        functions: Vec<Function>,
        instructions: Vec<Instruction>,
        symbols: Vec<Symbol>,
        abis: Vec<Abi>,
    ) -> Result<Self, String> {
        let start = Instant::now();
        for value in [
            &identity.workload_id,
            &identity.toolchain_id,
            &identity.policy_id,
            &identity.target_abi,
            &identity.source_revision,
            &key.logical_id,
        ] {
            if value.is_empty() || value.len() > 4096 || value.contains('\0') {
                return Err("batch identity must be nonempty, bounded, and contain no NUL".into());
            }
        }
        if functions.is_empty()
            || instructions.is_empty()
            || symbols.len() != functions.len()
            || abis.is_empty()
        {
            return Err(
                "batch requires functions, instructions, one symbol per function, and ABI records"
                    .into(),
            );
        }
        for count in [
            functions.len(),
            instructions.len(),
            symbols.len(),
            abis.len(),
        ] {
            if u32::try_from(count).is_err() {
                return Err("schema index overflow".into());
            }
        }
        let mut names = HashSet::new();
        for symbol in &symbols {
            if symbol.name.is_empty()
                || symbol.name.len() > 4096
                || symbol.name.contains('\0')
                || !names.insert(symbol.name.as_str())
            {
                return Err("symbols must have unique nonempty bounded names".into());
            }
        }
        let mut function_symbols = HashSet::new();
        let mut next = 0usize;
        for function in &functions {
            if function.symbol as usize >= symbols.len()
                || !function_symbols.insert(function.symbol)
            {
                return Err("function symbol missing or duplicated".into());
            }
            let abi = abis
                .get(function.abi as usize)
                .ok_or("function ABI index is out of bounds")?;
            let begin = function.instruction_start as usize;
            let end = begin
                .checked_add(function.instruction_count as usize)
                .ok_or("instruction range overflow")?;
            if begin != next || end > instructions.len() || begin == end {
                return Err("function ranges must partition instructions in order".into());
            }
            if function.value_count as usize > function.instruction_count as usize {
                return Err("value count exceeds available definitions".into());
            }
            let mut defined = HashSet::new();
            for (offset, instruction) in instructions[begin..end].iter().enumerate() {
                let is_return = instruction.opcode == Opcode::Return;
                if is_return != (offset + 1 == end - begin) {
                    return Err("each function must end with its only Return".into());
                }
                let operand_count = match instruction.opcode {
                    Opcode::Argument | Opcode::Const => 0,
                    Opcode::Copy => 1,
                    Opcode::Add | Opcode::Sub | Opcode::Mul => 2,
                    Opcode::Return => usize::from(abi.returns_i64),
                };
                for &value in &instruction.operands[..operand_count] {
                    if value >= function.value_count || !defined.contains(&value) {
                        return Err("instruction uses an undefined value".into());
                    }
                }
                if instruction.operands[operand_count..]
                    .iter()
                    .any(|&v| v != 0)
                {
                    return Err("unused operand slots must be zero".into());
                }
                if is_return {
                    if instruction.result.is_some() {
                        return Err("Return cannot define a value".into());
                    }
                } else {
                    let value = instruction
                        .result
                        .ok_or("instruction must define a value")?;
                    if value >= function.value_count || !defined.insert(value) {
                        return Err("result index out of bounds or multiply defined".into());
                    }
                }
                match instruction.opcode {
                    Opcode::Argument
                        if instruction.immediate < 0
                            || instruction.immediate as u64 >= u64::from(abi.parameter_count) =>
                    {
                        return Err("Argument index is out of bounds".into())
                    }
                    Opcode::Const | Opcode::Argument => {}
                    _ if instruction.immediate != 0 => {
                        return Err("unused immediate must be zero".into())
                    }
                    _ => {}
                }
            }
            if defined.len() != function.value_count as usize {
                return Err("value table contains undefined entries".into());
            }
            next = end;
        }
        if next != instructions.len() {
            return Err("instructions outside function ranges".into());
        }
        let owned_bytes = std::mem::size_of::<Self>()
            .checked_add(functions.len() * std::mem::size_of::<Function>())
            .and_then(|n| n.checked_add(instructions.len() * std::mem::size_of::<Instruction>()))
            .and_then(|n| n.checked_add(symbols.len() * std::mem::size_of::<Symbol>()))
            .and_then(|n| n.checked_add(abis.len() * std::mem::size_of::<Abi>()))
            .and_then(|n| {
                symbols
                    .iter()
                    .try_fold(n, |n, s| n.checked_add(s.name.capacity()))
            })
            .and_then(|n| {
                [
                    &identity.workload_id,
                    &identity.toolchain_id,
                    &identity.policy_id,
                    &identity.target_abi,
                    &identity.source_revision,
                    &key.logical_id,
                ]
                .iter()
                .try_fold(n, |n, s| n.checked_add(s.capacity()))
            })
            .ok_or("owned input size overflow")?;
        Ok(Self {
            identity,
            key,
            functions: functions.into_boxed_slice(),
            instructions: instructions.into_boxed_slice(),
            symbols: symbols.into_boxed_slice(),
            abis: abis.into_boxed_slice(),
            validation: start.elapsed(),
            owned_bytes,
        })
    }
    pub fn identity(&self) -> &BatchIdentity {
        &self.identity
    }
    pub fn key(&self) -> &BatchKey {
        &self.key
    }
    pub fn functions(&self) -> &[Function] {
        &self.functions
    }
    pub fn instructions(&self) -> &[Instruction] {
        &self.instructions
    }
    pub fn symbols(&self) -> &[Symbol] {
        &self.symbols
    }
    pub fn abis(&self) -> &[Abi] {
        &self.abis
    }
    pub fn schema_version(&self) -> u32 {
        SCHEMA_VERSION
    }
    pub fn owned_bytes(&self) -> usize {
        self.owned_bytes
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GpuBackend {
    Metal,
    Cuda,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeviceKind {
    Cpu,
    Gpu(GpuBackend),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExecutionReality {
    Cpu,
    PhysicalGpu,
    Simulation,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DeviceCapabilities {
    pub device_id: String,
    pub kind: DeviceKind,
    pub reality: ExecutionReality,
    pub target_abis: Vec<String>,
    pub max_batch_bytes: usize,
    pub cpu_credit_cost: usize,
}

impl DeviceCapabilities {
    pub fn cpu(device_id: impl Into<String>) -> Self {
        Self {
            device_id: device_id.into(),
            kind: DeviceKind::Cpu,
            reality: ExecutionReality::Cpu,
            target_abis: vec![],
            max_batch_bytes: usize::MAX,
            cpu_credit_cost: 1,
        }
    }
    /// Only an adapter that actually uses this physical device may advertise it.
    /// This declaration is not GPU validation or multi-device scaling evidence.
    pub fn physical_gpu(backend: GpuBackend, device_id: impl Into<String>) -> Self {
        Self {
            kind: DeviceKind::Gpu(backend),
            reality: ExecutionReality::PhysicalGpu,
            ..Self::cpu(device_id)
        }
    }
    pub fn simulated_gpu(backend: GpuBackend, device_id: impl Into<String>) -> Self {
        Self {
            kind: DeviceKind::Gpu(backend),
            reality: ExecutionReality::Simulation,
            ..Self::cpu(device_id)
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExecutionRecord {
    Cpu,
    Simulated {
        backend: GpuBackend,
        device_id: String,
    },
    PhysicalGpu {
        backend: GpuBackend,
        device_id: String,
        kernel_dispatches: u64,
        kernel_output_used: bool,
    },
}
impl ExecutionRecord {
    pub fn is_physical_gpu(&self) -> bool {
        matches!(self, Self::PhysicalGpu { kernel_dispatches, kernel_output_used: true, .. } if *kernel_dispatches > 0)
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum RelocationKind {
    Absolute64,
    Relative32,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Relocation {
    pub offset: u32,
    pub target: u32,
    pub kind: RelocationKind,
    pub addend: i64,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FunctionEmission {
    pub symbol: u32,
    pub code: Vec<u8>,
    pub relocations: Vec<Relocation>,
    pub unwind: Vec<u8>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Emission {
    pub functions: Vec<FunctionEmission>,
    pub execution: ExecutionRecord,
}

/// A submitted execution owns all storage through completion. `wait` must not
/// return until kernels/copies are complete or device teardown proves quiescence.
/// Dropping this object, including during unwinding, must also preserve that
/// guarantee. Cancellation does not invoke Drop early or reclaim its buffers.
pub trait PendingExecution: Send {
    fn wait(self: Box<Self>) -> Result<Emission, String>;
}

pub trait BatchExecutor: Send {
    fn capabilities(&self) -> DeviceCapabilities;
    fn prepare(&mut self, _batch: &FlatBatch) -> Result<(), String> {
        Ok(())
    }
    /// An error means no submitted work still uses the batch. Return a pending
    /// handle instead when recovery must await outstanding device work.
    fn submit(&mut self, batch: Arc<FlatBatch>) -> Result<Box<dyn PendingExecution>, String>;
}

type Callback = dyn Fn(&FlatBatch) -> Result<Emission, String> + Send + Sync;
pub struct CpuCallbackExecutor {
    capabilities: DeviceCapabilities,
    callback: Arc<Callback>,
}
impl CpuCallbackExecutor {
    pub fn new(
        device_id: impl Into<String>,
        callback: impl Fn(&FlatBatch) -> Result<Emission, String> + Send + Sync + 'static,
    ) -> Self {
        Self {
            capabilities: DeviceCapabilities::cpu(device_id),
            callback: Arc::new(callback),
        }
    }
}
struct CallbackPending {
    batch: Arc<FlatBatch>,
    callback: Arc<Callback>,
}
impl PendingExecution for CallbackPending {
    fn wait(self: Box<Self>) -> Result<Emission, String> {
        (self.callback)(&self.batch)
    }
}
impl BatchExecutor for CpuCallbackExecutor {
    fn capabilities(&self) -> DeviceCapabilities {
        self.capabilities.clone()
    }
    fn submit(&mut self, batch: Arc<FlatBatch>) -> Result<Box<dyn PendingExecution>, String> {
        Ok(Box::new(CallbackPending {
            batch,
            callback: self.callback.clone(),
        }))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Placement {
    Automatic,
    Cpu,
    RequireGpu(GpuBackend),
    SimulatedGpu(GpuBackend),
}

#[derive(Clone, Debug)]
pub struct SubmitOptions {
    pub placement: Placement,
    pub prerequisites: Vec<BatchKey>,
    pub critical_path_cost: u64,
    pub estimated_work: u64,
}
impl Default for SubmitOptions {
    fn default() -> Self {
        Self {
            placement: Placement::Automatic,
            prerequisites: vec![],
            critical_path_cost: 0,
            estimated_work: 0,
        }
    }
}

#[derive(Clone, Debug)]
pub struct SessionConfig {
    pub max_queued_batches: usize,
    /// Bounds service-owned input storage, including pending/canceled work.
    /// Device scratch/output budgets belong to the executor's capability policy.
    pub max_owned_bytes: usize,
    pub starvation_after_dispatches: u64,
    pub cpu_credit_limit: usize,
}
impl Default for SessionConfig {
    fn default() -> Self {
        Self {
            max_queued_batches: 32,
            max_owned_bytes: 128 * 1024 * 1024,
            starvation_after_dispatches: 16,
            cpu_credit_limit: thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(1),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ServiceError {
    Invalid(String),
    Unavailable(String),
    Backpressure,
    UnknownClient,
    Duplicate,
    Stale,
    UnknownPrerequisite,
    DependencyFailed,
    Canceled,
    Shutdown,
    Execution(String),
    Output(String),
    WorkerPanicked,
}
impl fmt::Display for ServiceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for ServiceError {}

#[derive(Clone, Debug)]
pub struct RouteDecision {
    pub device_id: String,
    pub kind: DeviceKind,
    pub reality: ExecutionReality,
    pub reason: String,
}
#[derive(Clone, Debug, Default)]
pub struct StageCostLedger {
    pub validation: Duration,
    pub queue: Duration,
    pub prepare: Duration,
    pub submit: Duration,
    pub wait: Duration,
    pub assemble: Duration,
}
#[derive(Clone, Debug)]
pub struct CompletionReceipt {
    pub session_id: u64,
    pub batch_key: BatchKey,
    pub schema_version: u32,
    pub identity: BatchIdentity,
    pub route: RouteDecision,
    pub execution: ExecutionRecord,
    pub output: Emission,
    pub costs: StageCostLedger,
}

#[derive(Clone, Debug)]
pub struct Client {
    session: u64,
    id: String,
    registration: u64,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum JobStatus {
    Queued,
    Running,
    CancellationPending,
    Complete,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Cancellation {
    pub was_running: bool,
    pub resources_pending: bool,
}
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct QueueSnapshot {
    pub queued: usize,
    pub running: usize,
    pub owned_bytes: usize,
    pub dispatches: u64,
}

enum JobPhase {
    Queued,
    Running,
    Done(Result<Arc<CompletionReceipt>, ServiceError>),
    Retired(Result<(), ServiceError>),
}
struct Job {
    batch: Option<Arc<FlatBatch>>,
    client: String,
    options: SubmitOptions,
    eligible_devices: Vec<String>,
    phase: JobPhase,
    cancel: bool,
    enqueue_time: Instant,
    enqueue_dispatch: u64,
    sequence: u64,
    bytes: usize,
}
struct Credit {
    total: usize,
    free: usize,
    registration: u64,
}
struct State {
    session: u64,
    config: SessionConfig,
    devices: Vec<DeviceCapabilities>,
    clients: BTreeMap<String, Credit>,
    jobs: BTreeMap<BatchKey, Job>,
    latest: HashMap<String, u64>,
    queued: usize,
    owned_bytes: usize,
    dispatches: u64,
    sequence: u64,
    next_client: u64,
    shutdown: bool,
}
struct Shared {
    state: Mutex<State>,
    changed: Condvar,
}
pub struct BuildSession {
    shared: Arc<Shared>,
    workers: Vec<JoinHandle<()>>,
}
#[derive(Clone)]
pub struct Ticket {
    key: BatchKey,
    shared: Arc<Shared>,
    _ownership: Arc<TicketOwnership>,
}
struct TicketOwnership {
    key: BatchKey,
    shared: Arc<Shared>,
}

impl BuildSession {
    pub fn new(
        config: SessionConfig,
        executors: Vec<Box<dyn BatchExecutor>>,
    ) -> Result<Self, ServiceError> {
        if config.max_queued_batches == 0
            || config.max_owned_bytes == 0
            || config.cpu_credit_limit == 0
            || config.starvation_after_dispatches == 0
            || executors.is_empty()
        {
            return Err(ServiceError::Invalid(
                "positive budgets and at least one executor are required".into(),
            ));
        }
        let devices: Vec<_> = executors.iter().map(|e| e.capabilities()).collect();
        let mut ids = HashSet::new();
        for device in &devices {
            let coherent = matches!(
                (device.kind, device.reality),
                (DeviceKind::Cpu, ExecutionReality::Cpu)
                    | (
                        DeviceKind::Gpu(_),
                        ExecutionReality::PhysicalGpu | ExecutionReality::Simulation
                    )
            );
            if !coherent
                || device.device_id.is_empty()
                || !ids.insert(device.device_id.clone())
                || device.cpu_credit_cost == 0
                || device.cpu_credit_cost > config.cpu_credit_limit
                || device.max_batch_bytes == 0
            {
                return Err(ServiceError::Invalid(
                    "inconsistent or duplicate device capability record".into(),
                ));
            }
        }
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                session: NEXT_SESSION.fetch_add(1, Ordering::Relaxed),
                config,
                devices: devices.clone(),
                clients: BTreeMap::new(),
                jobs: BTreeMap::new(),
                latest: HashMap::new(),
                queued: 0,
                owned_bytes: 0,
                dispatches: 0,
                sequence: 0,
                next_client: 0,
                shutdown: false,
            }),
            changed: Condvar::new(),
        });
        let workers = executors
            .into_iter()
            .zip(devices)
            .map(|(executor, device)| {
                let shared = shared.clone();
                thread::spawn(move || worker(shared, device, executor))
            })
            .collect();
        Ok(Self { shared, workers })
    }
    pub fn capabilities(&self) -> Vec<DeviceCapabilities> {
        self.shared.state.lock().unwrap().devices.clone()
    }
    /// Checks lineage at this instant. The consumer must coordinate its final
    /// external commit with source invalidation; this is not a file transaction.
    pub fn is_current(&self, receipt: &CompletionReceipt) -> bool {
        let state = self.shared.state.lock().unwrap();
        receipt.session_id == state.session
            && state.latest.get(&receipt.batch_key.logical_id)
                == Some(&receipt.batch_key.generation)
            && state.jobs.get(&receipt.batch_key).is_some_and(|job| {
                matches!(job.phase, JobPhase::Done(Ok(_)) | JobPhase::Retired(Ok(())))
            })
    }
    /// Caller supplies credits already reserved for this build. They are held
    /// while an executor runs or awaits a device; no extra CPU threads are lent
    /// without an explicit credit. Registration does not claim jobserver access.
    pub fn register_client(
        &self,
        id: impl Into<String>,
        cpu_credits: usize,
    ) -> Result<Client, ServiceError> {
        let id = id.into();
        let mut state = self.shared.state.lock().unwrap();
        if state.shutdown {
            return Err(ServiceError::Shutdown);
        }
        let assigned: usize = state.clients.values().map(|c| c.total).sum();
        if id.is_empty()
            || state.clients.contains_key(&id)
            || cpu_credits == 0
            || cpu_credits > state.config.cpu_credit_limit.saturating_sub(assigned)
        {
            return Err(ServiceError::Invalid(
                "client identity or reserved CPU-credit budget invalid".into(),
            ));
        }
        let registration = state.next_client;
        state.next_client += 1;
        state.clients.insert(
            id.clone(),
            Credit {
                total: cpu_credits,
                free: cpu_credits,
                registration,
            },
        );
        Ok(Client {
            session: state.session,
            id,
            registration,
        })
    }
    pub fn client_credits(&self, client: &Client) -> Result<(usize, usize), ServiceError> {
        let state = self.shared.state.lock().unwrap();
        if state.session != client.session {
            return Err(ServiceError::UnknownClient);
        }
        state
            .clients
            .get(&client.id)
            .filter(|c| c.registration == client.registration)
            .map(|c| (c.total, c.free))
            .ok_or(ServiceError::UnknownClient)
    }
    pub fn unregister_client(&self, client: &Client) -> Result<(), ServiceError> {
        let mut state = self.shared.state.lock().unwrap();
        if state.session != client.session
            || state
                .clients
                .get(&client.id)
                .is_none_or(|c| c.registration != client.registration)
        {
            return Err(ServiceError::UnknownClient);
        }
        if state.jobs.values().any(|job| {
            job.client == client.id && matches!(job.phase, JobPhase::Queued | JobPhase::Running)
        }) {
            return Err(ServiceError::Invalid(
                "client still owns queued or pending work".into(),
            ));
        }
        state.clients.remove(&client.id);
        Ok(())
    }
    pub fn snapshot(&self) -> QueueSnapshot {
        let state = self.shared.state.lock().unwrap();
        QueueSnapshot {
            queued: state.queued,
            running: state
                .jobs
                .values()
                .filter(|j| matches!(j.phase, JobPhase::Running))
                .count(),
            owned_bytes: state.owned_bytes,
            dispatches: state.dispatches,
        }
    }
    pub fn submit(
        &self,
        client: &Client,
        batch: Arc<FlatBatch>,
        options: SubmitOptions,
    ) -> Result<Ticket, ServiceError> {
        let mut state = self.shared.state.lock().unwrap();
        if state.shutdown {
            return Err(ServiceError::Shutdown);
        }
        let credit = state
            .clients
            .get(&client.id)
            .filter(|credit| {
                client.session == state.session && credit.registration == client.registration
            })
            .ok_or(ServiceError::UnknownClient)?;
        let eligible_devices: Vec<_> = state
            .devices
            .iter()
            .filter(|d| {
                eligible(d, &options.placement)
                    && d.cpu_credit_cost <= credit.total
                    && batch.owned_bytes() <= d.max_batch_bytes
                    && (d.target_abis.is_empty()
                        || d.target_abis.contains(&batch.identity().target_abi))
            })
            .map(|d| d.device_id.clone())
            .collect();
        if eligible_devices.is_empty() {
            return Err(ServiceError::Unavailable(
                "no eligible executor for placement, target, input size, and CPU credit".into(),
            ));
        }
        if state.jobs.contains_key(batch.key()) {
            return Err(ServiceError::Duplicate);
        }
        if state
            .latest
            .get(&batch.key().logical_id)
            .is_some_and(|&generation| generation >= batch.key().generation)
        {
            return Err(ServiceError::Stale);
        }
        let mut prerequisites = HashSet::new();
        for key in &options.prerequisites {
            if key == batch.key() || !prerequisites.insert(key) || !state.jobs.contains_key(key) {
                return Err(ServiceError::UnknownPrerequisite);
            }
            if dependency_failed(state.jobs.get(key).unwrap()) {
                return Err(ServiceError::DependencyFailed);
            }
        }
        if state.queued >= state.config.max_queued_batches
            || batch.owned_bytes()
                > state
                    .config
                    .max_owned_bytes
                    .saturating_sub(state.owned_bytes)
        {
            return Err(ServiceError::Backpressure);
        }
        // Revisions supersede outputs from older queued and running requests.
        // Running requests retain their input until their completion fence.
        let superseded: Vec<_> = state
            .jobs
            .keys()
            .filter(|key| key.logical_id == batch.key().logical_id)
            .cloned()
            .collect();
        for key in superseded {
            cancel_job(&mut state, &key);
        }
        let key = batch.key().clone();
        let bytes = batch.owned_bytes();
        let enqueue_dispatch = state.dispatches;
        let sequence = state.sequence;
        state.sequence += 1;
        state.latest.insert(key.logical_id.clone(), key.generation);
        state.owned_bytes += bytes;
        state.queued += 1;
        state.jobs.insert(
            key.clone(),
            Job {
                batch: Some(batch),
                client: client.id.clone(),
                options,
                eligible_devices,
                phase: JobPhase::Queued,
                cancel: false,
                enqueue_time: Instant::now(),
                enqueue_dispatch,
                sequence,
                bytes,
            },
        );
        self.shared.changed.notify_all();
        Ok(Ticket {
            key: key.clone(),
            shared: self.shared.clone(),
            _ownership: Arc::new(TicketOwnership {
                key,
                shared: self.shared.clone(),
            }),
        })
    }
}

impl Drop for BuildSession {
    fn drop(&mut self) {
        {
            let mut state = self.shared.state.lock().unwrap();
            state.shutdown = true;
            let keys: Vec<_> = state.jobs.keys().cloned().collect();
            for key in keys {
                cancel_job(&mut state, &key);
            }
            self.shared.changed.notify_all();
        }
        // Join waits for real completion; cancellation cannot free device-owned
        // memory merely because the build-scoped service is being destroyed.
        for worker in self.workers.drain(..) {
            let _ = worker.join();
        }
    }
}

impl Ticket {
    pub fn key(&self) -> &BatchKey {
        &self.key
    }
    pub fn status(&self) -> JobStatus {
        let state = self.shared.state.lock().unwrap();
        let job = state.jobs.get(&self.key).unwrap();
        match job.phase {
            JobPhase::Queued => JobStatus::Queued,
            JobPhase::Running if job.cancel => JobStatus::CancellationPending,
            JobPhase::Running => JobStatus::Running,
            JobPhase::Done(_) | JobPhase::Retired(_) => JobStatus::Complete,
        }
    }
    pub fn cancel(&self) -> Cancellation {
        let mut state = self.shared.state.lock().unwrap();
        let result = cancel_job(&mut state, &self.key);
        self.shared.changed.notify_all();
        result
    }
    /// Returns only after ownership can be released, even when canceled.
    pub fn wait(&self) -> Result<Arc<CompletionReceipt>, ServiceError> {
        let mut state = self.shared.state.lock().unwrap();
        loop {
            if let JobPhase::Done(result) = &state.jobs.get(&self.key).unwrap().phase {
                return result.clone();
            }
            state = self.shared.changed.wait(state).unwrap();
        }
    }
}

impl Drop for TicketOwnership {
    fn drop(&mut self) {
        let mut state = self.shared.state.lock().unwrap();
        let job = state.jobs.get_mut(&self.key).unwrap();
        if let JobPhase::Done(result) = &job.phase {
            // Keep only the prerequisite outcome. Outputs remain alive while a
            // caller holds its receipt, without accumulating inside the session.
            job.phase = JobPhase::Retired(result.as_ref().map(|_| ()).map_err(Clone::clone));
        } else {
            cancel_job(&mut state, &self.key);
        }
        self.shared.changed.notify_all();
    }
}

fn eligible(device: &DeviceCapabilities, placement: &Placement) -> bool {
    match placement {
        Placement::Automatic | Placement::Cpu => {
            device.kind == DeviceKind::Cpu && device.reality == ExecutionReality::Cpu
        }
        Placement::RequireGpu(backend) => {
            device.kind == DeviceKind::Gpu(*backend)
                && device.reality == ExecutionReality::PhysicalGpu
        }
        Placement::SimulatedGpu(backend) => {
            device.kind == DeviceKind::Gpu(*backend)
                && device.reality == ExecutionReality::Simulation
        }
    }
}

fn dependency_failed(job: &Job) -> bool {
    job.cancel
        || matches!(
            job.phase,
            JobPhase::Done(Err(_)) | JobPhase::Retired(Err(_))
        )
}
fn cancel_job(state: &mut State, key: &BatchKey) -> Cancellation {
    let job = state.jobs.get_mut(key).unwrap();
    let running = matches!(job.phase, JobPhase::Running);
    if matches!(job.phase, JobPhase::Queued) {
        job.cancel = true;
        job.phase = JobPhase::Done(Err(ServiceError::Canceled));
        job.batch.take();
        state.queued -= 1;
        state.owned_bytes -= job.bytes;
    } else if running {
        job.cancel = true;
    }
    Cancellation {
        was_running: running,
        resources_pending: running,
    }
}

fn finish_failed_dependencies(state: &mut State) {
    loop {
        let failed: Vec<_> = state
            .jobs
            .iter()
            .filter(|(_, job)| {
                matches!(job.phase, JobPhase::Queued)
                    && job
                        .options
                        .prerequisites
                        .iter()
                        .any(|key| dependency_failed(state.jobs.get(key).unwrap()))
            })
            .map(|(key, _)| key.clone())
            .collect();
        if failed.is_empty() {
            return;
        }
        for key in failed {
            let job = state.jobs.get_mut(&key).unwrap();
            job.phase = JobPhase::Done(Err(ServiceError::DependencyFailed));
            job.batch.take();
            state.queued -= 1;
            state.owned_bytes -= job.bytes;
        }
    }
}

fn select_job(state: &State, device: &DeviceCapabilities) -> Option<BatchKey> {
    let eligible: Vec<_> = state
        .jobs
        .iter()
        .filter(|(_, job)| {
            matches!(job.phase, JobPhase::Queued)
                && job.eligible_devices.contains(&device.device_id)
                && state.clients[&job.client].free >= device.cpu_credit_cost
                && job.options.prerequisites.iter().all(|key| {
                    matches!(
                        state.jobs[key].phase,
                        JobPhase::Done(Ok(_)) | JobPhase::Retired(Ok(()))
                    )
                })
        })
        .collect();
    let starved = eligible
        .iter()
        .filter(|(_, job)| {
            state.dispatches.saturating_sub(job.enqueue_dispatch)
                >= state.config.starvation_after_dispatches
        })
        .min_by_key(|(_, job)| job.sequence);
    if let Some((key, _)) = starved {
        return Some((*key).clone());
    }
    eligible
        .into_iter()
        .max_by_key(|(_, job)| {
            (
                job.options.critical_path_cost,
                job.options.estimated_work,
                std::cmp::Reverse(job.sequence),
            )
        })
        .map(|(key, _)| key.clone())
}

fn worker(shared: Arc<Shared>, device: DeviceCapabilities, mut executor: Box<dyn BatchExecutor>) {
    loop {
        let (key, batch, queue_cost, client) = {
            let mut state = shared.state.lock().unwrap();
            loop {
                finish_failed_dependencies(&mut state);
                shared.changed.notify_all();
                if state.shutdown {
                    return;
                }
                if let Some(key) = select_job(&state, &device) {
                    let job = state.jobs.get_mut(&key).unwrap();
                    job.phase = JobPhase::Running;
                    let batch = job.batch.as_ref().unwrap().clone();
                    let queue_cost = job.enqueue_time.elapsed();
                    let client = job.client.clone();
                    state.clients.get_mut(&client).unwrap().free -= device.cpu_credit_cost;
                    state.queued -= 1;
                    state.dispatches += 1;
                    shared.changed.notify_all();
                    break (key, batch, queue_cost, client);
                }
                state = shared.changed.wait(state).unwrap();
            }
        };
        let mut costs = StageCostLedger {
            validation: batch.validation,
            queue: queue_cost,
            ..Default::default()
        };
        let result = catch_unwind(AssertUnwindSafe(|| {
            execute(executor.as_mut(), &device, batch.clone(), &mut costs)
        }));
        let result = result.unwrap_or(Err(ServiceError::WorkerPanicked));
        let identity = batch.identity().clone();
        let schema_version = batch.schema_version();
        // The service's worker ownership is dropped before returning credits.
        drop(batch);
        let mut state = shared.state.lock().unwrap();
        let session_id = state.session;
        let job = state.jobs.get_mut(&key).unwrap();
        let reason = match job.options.placement {
            Placement::Automatic => "uncalibrated automatic policy selects CPU",
            Placement::Cpu => "CPU explicitly selected",
            Placement::RequireGpu(_) => "physical GPU explicitly required",
            Placement::SimulatedGpu(_) => "simulation explicitly selected; not GPU evidence",
        };
        let result = if job.cancel {
            Err(ServiceError::Canceled)
        } else {
            result.map(|output| {
                Arc::new(CompletionReceipt {
                    session_id,
                    batch_key: key.clone(),
                    schema_version,
                    identity,
                    route: RouteDecision {
                        device_id: device.device_id.clone(),
                        kind: device.kind,
                        reality: device.reality,
                        reason: reason.into(),
                    },
                    execution: output.execution.clone(),
                    output,
                    costs,
                })
            })
        };
        job.phase = JobPhase::Done(result);
        job.batch.take();
        state.owned_bytes -= job.bytes;
        state.clients.get_mut(&client).unwrap().free += device.cpu_credit_cost;
        finish_failed_dependencies(&mut state);
        shared.changed.notify_all();
    }
}

fn execute(
    executor: &mut dyn BatchExecutor,
    device: &DeviceCapabilities,
    batch: Arc<FlatBatch>,
    costs: &mut StageCostLedger,
) -> Result<Emission, ServiceError> {
    let start = Instant::now();
    let prepared = executor.prepare(&batch);
    costs.prepare = start.elapsed();
    prepared.map_err(ServiceError::Execution)?;
    let start = Instant::now();
    let submitted = executor.submit(batch.clone());
    costs.submit = start.elapsed();
    let pending = submitted.map_err(ServiceError::Execution)?;
    let start = Instant::now();
    let waited = pending.wait();
    costs.wait = start.elapsed();
    let mut output = waited.map_err(ServiceError::Execution)?;
    let start = Instant::now();
    let result = validate_output(&batch, device, &mut output);
    costs.assemble = start.elapsed();
    result?;
    Ok(output)
}

fn validate_output(
    batch: &FlatBatch,
    device: &DeviceCapabilities,
    output: &mut Emission,
) -> Result<(), ServiceError> {
    let attribution_valid = match (&output.execution, device.kind, device.reality) {
        (ExecutionRecord::Cpu, DeviceKind::Cpu, ExecutionReality::Cpu) => true,
        (
            ExecutionRecord::Simulated { backend, device_id },
            DeviceKind::Gpu(expected),
            ExecutionReality::Simulation,
        ) => *backend == expected && *device_id == device.device_id,
        (
            ExecutionRecord::PhysicalGpu {
                backend,
                device_id,
                kernel_dispatches,
                kernel_output_used,
            },
            DeviceKind::Gpu(expected),
            ExecutionReality::PhysicalGpu,
        ) => {
            *backend == expected
                && *device_id == device.device_id
                && *kernel_dispatches > 0
                && *kernel_output_used
        }
        _ => false,
    };
    if !attribution_valid {
        return Err(ServiceError::Output(
            "execution record contradicts registered device or contains no used kernel output"
                .into(),
        ));
    }
    let mut symbols = HashSet::new();
    if output.functions.len() != batch.functions().len() {
        return Err(ServiceError::Output("partial function output".into()));
    }
    let mut inputs = vec![None; batch.symbols().len()];
    for function in batch.functions() {
        inputs[function.symbol as usize] = Some(function);
    }
    for function in &mut output.functions {
        let input = inputs
            .get(function.symbol as usize)
            .and_then(|f| *f)
            .ok_or_else(|| ServiceError::Output("output symbol is absent from batch".into()))?;
        if !symbols.insert(function.symbol) || function.code.is_empty() {
            return Err(ServiceError::Output(
                "empty code or duplicate function output".into(),
            ));
        }
        if batch.abis()[input.abi as usize].requires_unwind && function.unwind.is_empty() {
            return Err(ServiceError::Output(
                "required unwind record is missing".into(),
            ));
        }
        function
            .relocations
            .sort_by_key(|r| (r.offset, r.kind, r.target, r.addend));
        let mut end = 0;
        for relocation in &function.relocations {
            let width = match relocation.kind {
                RelocationKind::Absolute64 => 8,
                RelocationKind::Relative32 => 4,
            };
            let current_end = (relocation.offset as usize)
                .checked_add(width)
                .ok_or_else(|| ServiceError::Output("relocation range overflow".into()))?;
            if relocation.target as usize >= batch.symbols().len()
                || (relocation.offset as usize) < end
                || current_end > function.code.len()
            {
                return Err(ServiceError::Output(
                    "invalid or overlapping relocation".into(),
                ));
            }
            end = current_end;
        }
    }
    output.functions.sort_by(|a, b| {
        batch.symbols()[a.symbol as usize]
            .name
            .cmp(&batch.symbols()[b.symbol as usize].name)
    });
    Ok(())
}
