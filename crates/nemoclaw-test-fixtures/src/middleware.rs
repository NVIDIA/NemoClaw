// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The `docker-dummy` live case's external middleware and HTTP destination.
//! Each counts the requests it sees by path and rewrites the counts to a file
//! that the case's assertions read. Dropping the fixture stops both listeners.
use openshell_core::{
    extension_protocol::{ExtensionFamily, extension_metadata},
    middleware::WebSocketResponseStream,
    proto::{
        Decision, HttpRequestEvaluation, HttpRequestResult, MiddlewareBinding,
        MiddlewareDescribeRequest, MiddlewareManifest, SupervisorMiddlewareOperation,
        SupervisorMiddlewarePhase, ValidateConfigRequest, ValidateConfigResponse,
        WebSocketSessionEvent,
        middleware::v1::supervisor_middleware_server::{
            SupervisorMiddleware, SupervisorMiddlewareServer,
        },
    },
};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio_stream::wrappers::TcpListenerStream;
use tonic::{Request, Response, Status};

/// Requests seen by path: `{"middleware": {PATH: N}, "destination": {PATH: N}}`.
#[derive(Clone)]
struct Effects {
    file: PathBuf,
    counts: Arc<Mutex<Value>>,
}

impl Effects {
    fn record(&self, side: &str, path: &str) {
        let mut counts = self.counts.lock().unwrap();
        let count = &mut counts[side][path];
        *count = json!(count.as_u64().unwrap_or(0) + 1);
        std::fs::write(&self.file, counts.to_string()).unwrap();
    }
}

/// Allows every request except one to `/deny`, which it denies, and one to
/// `/fail`, which it answers with a service error, as a middleware that can't
/// complete its check does.
#[derive(Clone)]
struct Guard(Effects);

#[tonic::async_trait]
impl SupervisorMiddleware for Guard {
    type EvaluateWebSocketSessionStream = WebSocketResponseStream;

    async fn describe(
        &self,
        _: Request<MiddlewareDescribeRequest>,
    ) -> Result<Response<MiddlewareManifest>, Status> {
        Ok(Response::new(MiddlewareManifest {
            name: "nemoclaw-live-guard".into(),
            bindings: vec![MiddlewareBinding {
                operation: SupervisorMiddlewareOperation::HttpRequest as i32,
                phase: SupervisorMiddlewarePhase::PreCredentials as i32,
                max_payload_bytes: 4096,
                ..Default::default()
            }],
            extension: Some(extension_metadata(
                ExtensionFamily::SupervisorMiddleware,
                "nemoclaw-live-guard",
                openshell_core::VERSION,
                [],
            )),
            ..Default::default()
        }))
    }

    async fn validate_config(
        &self,
        _: Request<ValidateConfigRequest>,
    ) -> Result<Response<ValidateConfigResponse>, Status> {
        Ok(Response::new(ValidateConfigResponse {
            valid: true,
            reason: String::new(),
        }))
    }

    async fn evaluate_http_request(
        &self,
        request: Request<HttpRequestEvaluation>,
    ) -> Result<Response<HttpRequestResult>, Status> {
        let target = request
            .into_inner()
            .target
            .ok_or_else(|| Status::invalid_argument("missing target"))?;
        self.0.record("middleware", &target.path);
        if target.path == "/fail" {
            return Err(Status::internal("the live guard fails this request"));
        }
        Ok(Response::new(HttpRequestResult {
            decision: if target.path == "/deny" {
                Decision::Deny
            } else {
                Decision::Allow
            } as i32,
            ..Default::default()
        }))
    }

    async fn evaluate_web_socket_session(
        &self,
        _: Request<tonic::Streaming<WebSocketSessionEvent>>,
    ) -> Result<Response<Self::EvaluateWebSocketSessionStream>, Status> {
        Err(Status::unimplemented("the live case uses HTTP requests"))
    }
}

pub struct Fixture {
    _http: crate::http::Fixture,
    grpc: tokio::task::JoinHandle<()>,
}

impl Fixture {
    /// Listen on every address of the test host, which the gateway and sandbox
    /// reach through their bridges, and record effects in `file`.
    pub async fn start(grpc_port: u16, http_port: u16, file: PathBuf) -> Self {
        let effects = Effects {
            file,
            counts: Arc::new(Mutex::new(json!({"middleware": {}, "destination": {}}))),
        };
        std::fs::write(&effects.file, effects.counts.lock().unwrap().to_string()).unwrap();
        let guard = Guard(effects.clone());
        let listener = tokio::net::TcpListener::bind(("0.0.0.0", grpc_port))
            .await
            .unwrap();
        let grpc = tokio::spawn(async move {
            tonic::transport::Server::builder()
                .add_service(SupervisorMiddlewareServer::new(guard))
                .serve_with_incoming(TcpListenerStream::new(listener))
                .await
                .unwrap();
        });
        let http =
            crate::http::Fixture::start_tcp_at(&format!("0.0.0.0:{http_port}"), move |request| {
                effects.record("destination", &request.path);
                Some((200, Vec::new()))
            })
            .await;
        Self { _http: http, grpc }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.grpc.abort();
    }
}
