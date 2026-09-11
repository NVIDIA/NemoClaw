//go:build integration

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package engine

import (
	"context"
	"fmt"
	"net"
	"strings"
	"sync"
	"testing"

	dm "github.com/NVIDIA/OpenShell/sdk/go/proto/datamodelv1"
	ip "github.com/NVIDIA/OpenShell/sdk/go/proto/inferencev1"
	pb "github.com/NVIDIA/OpenShell/sdk/go/proto/openshellv1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

// This server exercises the released SDK protocol. It provides deterministic
// lost-response and identity-change cases; it is not a sandbox implementation.
type fixture struct {
	pb.UnimplementedOpenShellServer
	ip.UnimplementedInferenceServer
	mu            sync.Mutex
	workspaces    map[string]*dm.Workspace
	providers     map[string]*dm.Provider
	routes        map[string]*ip.SetInferenceRouteRequest
	sandboxes     map[string]*pb.Sandbox
	effects       int
	creates       map[string]int
	loseProvider  bool
	blockSandbox  chan struct{}
	sandboxPhase  pb.SandboxPhase
	endpoint      string
	execExit      int32
	inferenceExit int32
	readFailure   map[string]codes.Code
	partialRead   map[string]bool
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{workspaces: map[string]*dm.Workspace{}, providers: map[string]*dm.Provider{}, routes: map[string]*ip.SetInferenceRouteRequest{}, sandboxes: map[string]*pb.Sandbox{}, creates: map[string]int{}}
	f.readFailure = map[string]codes.Code{}
	f.partialRead = map[string]bool{}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := grpc.NewServer()
	pb.RegisterOpenShellServer(s, f)
	ip.RegisterInferenceServer(s, f)
	go func() { _ = s.Serve(l) }()
	t.Cleanup(s.Stop)
	f.endpoint = "http://" + l.Addr().String()
	return f
}
func missing() error { return status.Error(codes.NotFound, "absent") }
func (f *fixture) meta(name, workspace string, labels map[string]string) *dm.ObjectMeta {
	f.effects++
	return &dm.ObjectMeta{Id: fmt.Sprintf("id-%d", f.effects), Name: name, Workspace: workspace, Labels: labels, ResourceVersion: 1}
}
func (f *fixture) count() int { f.mu.Lock(); defer f.mu.Unlock(); return f.effects }
func (f *fixture) GetGatewayInfo(context.Context, *pb.GetGatewayInfoRequest) (*pb.GetGatewayInfoResponse, error) {
	return &pb.GetGatewayInfoResponse{GatewayVersion: "0.0.116", ComputeDrivers: []*pb.ComputeDriverInfo{{Name: "docker"}}}, nil
}
func (f *fixture) GetWorkspace(_ context.Context, q *pb.GetWorkspaceRequest) (*pb.GetWorkspaceResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if code := f.readFailure["workspace"]; code != codes.OK {
		return nil, status.Error(code, "sensitive-sentinel-42")
	}
	if f.partialRead["workspace"] {
		return &pb.GetWorkspaceResponse{}, nil
	}
	w := f.workspaces[q.Name]
	if w == nil {
		return nil, missing()
	}
	return &pb.GetWorkspaceResponse{Workspace: proto.Clone(w).(*dm.Workspace)}, nil
}
func (f *fixture) CreateWorkspace(_ context.Context, q *pb.CreateWorkspaceRequest) (*pb.CreateWorkspaceResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.workspaces[q.Name] != nil {
		return nil, status.Error(codes.AlreadyExists, "collision")
	}
	w := &dm.Workspace{Metadata: f.meta(q.Name, q.Name, q.Labels), Status: &dm.WorkspaceStatus{Phase: dm.WorkspacePhase_WORKSPACE_PHASE_ACTIVE}}
	f.workspaces[q.Name] = w
	f.creates["workspace"]++
	return &pb.CreateWorkspaceResponse{Workspace: proto.Clone(w).(*dm.Workspace)}, nil
}
func (f *fixture) GetProvider(_ context.Context, q *pb.GetProviderRequest) (*pb.ProviderResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if code := f.readFailure["provider"]; code != codes.OK {
		return nil, status.Error(code, "sensitive-sentinel-42")
	}
	if f.partialRead["provider"] {
		return &pb.ProviderResponse{}, nil
	}
	p := f.providers[q.Workspace+"/"+q.Name]
	if p == nil {
		return nil, missing()
	}
	return &pb.ProviderResponse{Provider: proto.Clone(p).(*dm.Provider)}, nil
}
func (f *fixture) CreateProvider(_ context.Context, q *pb.CreateProviderRequest) (*pb.ProviderResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	p := proto.Clone(q.Provider).(*dm.Provider)
	key := q.Workspace + "/" + p.Metadata.Name
	if f.providers[key] != nil {
		return nil, status.Error(codes.AlreadyExists, "collision")
	}
	p.Metadata = f.meta(p.Metadata.Name, q.Workspace, p.Metadata.Labels)
	f.providers[key] = p
	f.creates["provider"]++
	if f.loseProvider {
		f.loseProvider = false
		return nil, status.Error(codes.Unavailable, "response lost after external effect; fixture-secret")
	}
	return &pb.ProviderResponse{Provider: proto.Clone(p).(*dm.Provider)}, nil
}
func (f *fixture) UpdateProvider(_ context.Context, q *pb.UpdateProviderRequest) (*pb.ProviderResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	p := proto.Clone(q.Provider).(*dm.Provider)
	key := q.Workspace + "/" + p.Metadata.Name
	old := f.providers[key]
	if old == nil {
		return nil, missing()
	}
	if old.Metadata.Id != p.Metadata.Id || old.Metadata.ResourceVersion != p.Metadata.ResourceVersion {
		return nil, status.Error(codes.Aborted, "stale revision")
	}
	f.effects++
	p.Metadata.ResourceVersion++
	f.providers[key] = p
	return &pb.ProviderResponse{Provider: proto.Clone(p).(*dm.Provider)}, nil
}
func (f *fixture) GetInferenceRoute(_ context.Context, q *ip.GetInferenceRouteRequest) (*ip.GetInferenceRouteResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if code := f.readFailure["route"]; code != codes.OK {
		return nil, status.Error(code, "sensitive-sentinel-42")
	}
	if f.partialRead["route"] {
		return &ip.GetInferenceRouteResponse{}, nil
	}
	r := f.routes[q.Workspace]
	if r == nil {
		return nil, missing()
	}
	return &ip.GetInferenceRouteResponse{ProviderName: r.ProviderName, ModelId: r.ModelId, RouteName: r.RouteName, Workspace: q.Workspace, Version: 1, TimeoutSecs: r.TimeoutSecs}, nil
}
func (f *fixture) SetInferenceRoute(_ context.Context, q *ip.SetInferenceRouteRequest) (*ip.SetInferenceRouteResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if q.NoVerify {
		return nil, status.Error(codes.InvalidArgument, "verification cannot be skipped")
	}
	f.effects++
	f.routes[q.Workspace] = proto.Clone(q).(*ip.SetInferenceRouteRequest)
	return &ip.SetInferenceRouteResponse{ProviderName: q.ProviderName, ModelId: q.ModelId, RouteName: q.RouteName, Workspace: q.Workspace, Version: 1, TimeoutSecs: q.TimeoutSecs, ValidationPerformed: true}, nil
}
func (f *fixture) GetSandbox(_ context.Context, q *pb.GetSandboxRequest) (*pb.SandboxResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if code := f.readFailure["sandbox"]; code != codes.OK {
		return nil, status.Error(code, "sensitive-sentinel-42")
	}
	if f.partialRead["sandbox"] {
		return &pb.SandboxResponse{}, nil
	}
	s := f.sandboxes[q.Workspace+"/"+q.Name]
	if s == nil {
		return nil, missing()
	}
	return &pb.SandboxResponse{Sandbox: proto.Clone(s).(*pb.Sandbox)}, nil
}
func (f *fixture) CreateSandbox(ctx context.Context, q *pb.CreateSandboxRequest) (*pb.SandboxResponse, error) {
	f.mu.Lock()
	key := q.Workspace + "/" + q.Name
	if f.sandboxes[key] != nil {
		f.mu.Unlock()
		return nil, status.Error(codes.AlreadyExists, "collision")
	}
	s := &pb.Sandbox{Metadata: f.meta(q.Name, q.Workspace, q.Labels), Spec: proto.Clone(q.Spec).(*pb.SandboxSpec), Status: &pb.SandboxStatus{Phase: pb.SandboxPhase_SANDBOX_PHASE_READY}}
	if f.sandboxPhase != pb.SandboxPhase_SANDBOX_PHASE_UNSPECIFIED {
		s.Status.Phase = f.sandboxPhase
	}
	f.sandboxes[key] = s
	f.creates["sandbox"]++
	block := f.blockSandbox
	f.blockSandbox = nil
	out := proto.Clone(s).(*pb.Sandbox)
	f.mu.Unlock()
	if block != nil {
		close(block)
		<-ctx.Done()
		return nil, status.Error(codes.Canceled, "cancelled after create")
	}
	return &pb.SandboxResponse{Sandbox: out}, nil
}
func (f *fixture) ExecSandbox(q *pb.ExecSandboxRequest, s grpc.ServerStreamingServer[pb.ExecSandboxEvent]) error {
	f.mu.Lock()
	exit := f.execExit
	if strings.Contains(strings.Join(q.Command, " "), "/v1/chat/completions") {
		exit = f.inferenceExit
	}
	f.mu.Unlock()
	return s.Send(&pb.ExecSandboxEvent{Payload: &pb.ExecSandboxEvent_Exit{Exit: &pb.ExecSandboxExit{ExitCode: exit}}})
}

func (f *fixture) GetSandboxPolicyStatus(_ context.Context, q *pb.GetSandboxPolicyStatusRequest) (*pb.GetSandboxPolicyStatusResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if code := f.readFailure["policy"]; code != codes.OK {
		return nil, status.Error(code, "sensitive-sentinel-42")
	}
	s := f.sandboxes[q.Workspace+"/"+q.Name]
	if s == nil {
		return nil, missing()
	}
	return &pb.GetSandboxPolicyStatusResponse{ActiveVersion: 1, Revision: &pb.SandboxPolicyRevision{Version: 1, Status: pb.PolicyStatus_POLICY_STATUS_LOADED, Policy: s.Spec.Policy}}, nil
}
