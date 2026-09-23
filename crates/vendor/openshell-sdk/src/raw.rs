// SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Escape hatch — direct access to the generated tonic clients and protobuf
//! types.
//!
//! Use this module when the curated high-level surface in
//! [`crate::client::OpenShellClient`] doesn't expose the RPC or field you
//! need. The high-level surface is sandbox-focused for MVP; providers,
//! policy, logs, settings, SSH, and forwarding all live here.
//!
//! ```ignore
//! use openshell_sdk::{ClientConfig, OpenShellClient};
//! use openshell_sdk::raw::ListProvidersRequest;
//!
//! let client = OpenShellClient::connect(ClientConfig::new("http://127.0.0.1:8080")).await?;
//! let mut grpc = client.raw_grpc();
//! let providers = grpc.list_providers(ListProvidersRequest::default()).await?;
//! ```

pub use openshell_core::proto;
pub use openshell_core::proto::open_shell_client::OpenShellClient as GrpcClient;
pub use openshell_core::proto::{
    CreateSandboxRequest, CreateSandboxTemplateRequest, CreateWorkspaceRequest,
    DeleteSandboxRequest, DeleteSandboxTemplateRequest, DeleteWorkspaceRequest, ExecSandboxRequest,
    GetSandboxProviderStatusRequest, GetSandboxProviderStatusResponse, GetSandboxRequest,
    GetSandboxTemplateRequest, GetWorkspaceRequest, HealthRequest, ListProvidersRequest,
    ListSandboxTemplatesRequest, ListSandboxesRequest, ListWorkspacesRequest,
    ProviderDesiredIdentity, ProviderMutationKind, ProviderMutationReceipt,
    ProviderReadinessObservation, ProviderReadinessReason, ProviderReadinessState,
    ProviderReadinessStatus, Sandbox, SandboxPhase as ProtoSandboxPhase, SandboxResources,
    SandboxServiceLevel, SandboxSpec as ProtoSandboxSpec, SandboxStartup, SandboxTemplate,
    SandboxTemplateResponse, SandboxWorkloadConfig, SandboxWorkloadTemplate,
    SandboxWorkloadTemplateProvenance, SandboxWorkloadTemplateSpec,
    ServiceStatus as ProtoServiceStatus, StartSandboxRequest, StopSandboxRequest, Workspace,
};

/// Type alias for the gRPC client wrapped in the SDK's auth interceptor.
pub type AuthedGrpcClient = GrpcClient<
    tonic::service::interceptor::InterceptedService<
        tonic::transport::Channel,
        crate::EdgeAuthInterceptor,
    >,
>;
