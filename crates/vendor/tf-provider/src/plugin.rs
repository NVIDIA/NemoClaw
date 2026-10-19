// This file is part of the tf-provider project
//
// Copyright (C) ANEO, 2024-2024. All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License")
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

//! Implementation of all the TF plugin gRPC services

use std::pin::Pin;
use std::{fmt::Write, sync::Arc};

use futures::{Stream, StreamExt};
use tokio::sync::broadcast;
use tonic::{Request, Response, Status};

use crate::server::Server;

tonic::include_proto!("plugin");

#[tonic::async_trait]
impl grpc_broker_server::GrpcBroker for Arc<Server> {
    type StartStreamStream = Pin<Box<dyn Stream<Item = Result<ConnInfo, Status>> + Send + 'static>>;
    async fn start_stream(
        &self,
        request: Request<tonic::Streaming<ConnInfo>>,
    ) -> Result<Response<Self::StartStreamStream>, Status> {
        let mut stream = request.into_inner();
        let token = self.cancellation_token.clone();

        let io = self.io.clone();
        let output = async_stream::try_stream! {
            loop {
                tokio::select!{
                    Some(conn_info) = stream.next() => match conn_info {
                        Ok(conn_info) => {
                            writeln!(io.stdout(), "relay {}", conn_info).unwrap_or(());
                            yield conn_info.clone();
                        },
                        Err(status) => {
                            writeln!(io.stderr(), "stream error {}", status).unwrap_or(());
                        },
                    },
                    _ = token.cancelled() => break,
                };
            }
        };

        Ok(Response::new(Box::pin(output) as Self::StartStreamStream))
    }
}

impl core::fmt::Display for ConnInfo {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> Result<(), std::fmt::Error> {
        write!(
            f,
            "ConnInfo{{service_id: {}, network: {}, address: {} }}",
            self.service_id, self.network, self.address
        )
    }
}

#[tonic::async_trait]
impl grpc_controller_server::GrpcController for Arc<Server> {
    async fn shutdown(
        &self,
        _request: tonic::Request<Empty>,
    ) -> Result<tonic::Response<Empty>, tonic::Status> {
        self.cancellation_token.cancel();

        Ok(Response::new(Empty {}))
    }
}

#[tonic::async_trait]
impl grpc_stdio_server::GrpcStdio for Arc<Server> {
    type StreamStdioStream =
        Pin<Box<dyn Stream<Item = Result<StdioData, Status>> + Send + 'static>>;
    async fn stream_stdio(
        &self,
        _request: tonic::Request<()>,
    ) -> Result<tonic::Response<Self::StreamStdioStream>, tonic::Status> {
        let mut rx = self.io.tx.subscribe();
        let token = self.cancellation_token.clone();

        let output = async_stream::try_stream! {
            loop {
                tokio::select! {
                    iodata = rx.recv() =>
                        if let Ok(iodata) = iodata {
                            yield iodata.clone();
                        } else if let Err(broadcast::error::RecvError::Lagged(n)) = iodata {
                            eprintln!("IO over grpc lags behind by {n} messages!");
                        } else {
                            break;
                        },
                    _ = token.cancelled() => break,
                };
            }
        };

        Ok(Response::new(Box::pin(output) as Self::StreamStdioStream))
    }
}

#[derive(Debug, Clone)]
pub struct GrpcIoStream<'a> {
    pub tx: &'a broadcast::Sender<StdioData>,
    pub channel: i32,
}

impl std::fmt::Write for GrpcIoStream<'_> {
    fn write_str(&mut self, s: &str) -> Result<(), std::fmt::Error> {
        match self.tx.send(StdioData {
            channel: self.channel,
            data: s.as_bytes().to_vec(),
        }) {
            Ok(_) => Ok(()),
            Err(_) => Ok(()),
        }
    }
}

#[derive(Debug, Clone)]
pub struct GrpcIo {
    pub tx: broadcast::Sender<StdioData>,
}

impl GrpcIo {
    pub fn new(capacity: usize) -> Self {
        let (tx, _) = broadcast::channel(capacity);
        Self { tx }
    }
    pub fn stdout(&self) -> GrpcIoStream<'_> {
        GrpcIoStream {
            tx: &self.tx,
            channel: 1,
        }
    }
    pub fn stderr(&self) -> GrpcIoStream<'_> {
        GrpcIoStream {
            tx: &self.tx,
            channel: 2,
        }
    }
}

impl Default for GrpcIo {
    fn default() -> Self {
        Self::new(10)
    }
}
