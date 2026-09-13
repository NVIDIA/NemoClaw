// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package openshell

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"
	"time"

	v1 "github.com/NVIDIA/OpenShell/sdk/go/openshell/v1"
)

const OwnerLabel = "nemoclaw.nvidia.com/uid"
const GenerationLabel = "nemoclaw.nvidia.com/generation"
const CredentialLabel = "nemoclaw.nvidia.com/credential-env"
const AgentRuntimeLabel = "nemoclaw.nvidia.com/agent-runtime"
const AgentLabel = "nemoclaw.nvidia.com/agent"

// Row contains the non-secret attributes shared by resource readers, provider
// state, mutation reconciliation, and export.
type Row map[string]string
type Definition struct {
	Kind            string
	Fields, Mutable []string
}

var Definitions = []Definition{
	{"workspace", []string{"name", "owner", "generation"}, nil},
	{"provider", []string{"workspace", "name", "owner", "generation", "endpoint", "credential_env", "provider_type"}, []string{"endpoint", "credential_env"}},
	{"route", []string{"workspace", "name", "owner", "generation", "provider_name", "model"}, []string{"provider_name", "model"}},
	{"sandbox", []string{"workspace", "name", "owner", "generation", "image", "agent_name", "agent_runtime"}, nil},
}

type Client interface {
	Workspaces() v1.WorkspaceInterface
	Providers() v1.ProviderInterface
	Inference() v1.InferenceInterface
	Sandboxes() v1.SandboxInterface
	Exec() v1.ExecInterface
	Health() v1.HealthInterface
	Policy() v1.PolicyInterface
}

func DefinitionFor(kind string) Definition {
	if i := slices.IndexFunc(Definitions, func(d Definition) bool { return d.Kind == kind }); i >= 0 {
		return Definitions[i]
	}
	panic("unknown internal resource kind")
}

func base(name, id string, labels map[string]string) Row {
	return Row{"name": name, "id": id, "owner": labels[OwnerLabel], "generation": labels[GenerationLabel]}
}
func labels(r Row) map[string]string {
	return map[string]string{OwnerLabel: r["owner"], GenerationLabel: r["generation"]}
}

// Observe reads configuration through the owning API. Only an explicit NotFound
// for the resource (or a route's workspace) returns nil, nil. Failed or incomplete
// reads return an error and must never authorize state removal or export.
func Observe(ctx context.Context, c Client, kind, workspace, name string) (Row, error) {
	return observe(ctx, c, kind, workspace, name, false)
}

// ObserveRemoval accepts an established object's terminating lifecycle while
// retaining the same configuration and ownership checks used by refresh.
func ObserveRemoval(ctx context.Context, c Client, kind, workspace, name string) (Row, error) {
	return observe(ctx, c, kind, workspace, name, true)
}

func observe(ctx context.Context, c Client, kind, workspace, name string, removing bool) (Row, error) {
	if name == "" || (kind == "workspace") != (workspace == "") || strings.ContainsAny(name+workspace, "\x00") {
		return nil, errors.New("invalid resource observation key")
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	var row Row
	switch kind {
	case "workspace":
		w, err := c.Workspaces().Get(ctx, name)
		if v1.IsNotFound(err) {
			return nil, nil
		}
		if err != nil {
			return nil, remoteError("read workspace", err)
		}
		if w == nil {
			return nil, errors.New("incomplete workspace response")
		}
		if (!removing && w.DeletionTimestamp != nil) || (w.Phase != v1.WorkspaceActive && !(removing && w.Phase == v1.WorkspaceTerminating)) {
			return nil, errors.New("workspace is not active")
		}
		row = base(w.Name, w.ID, w.Labels)
	case "provider":
		p, err := c.Providers().Get(ctx, workspace, name)
		if v1.IsNotFound(err) {
			return nil, nil
		}
		if err != nil {
			return nil, remoteError("read provider", err)
		}
		if p == nil {
			return nil, errors.New("incomplete provider response")
		}
		if (!removing && p.DeletionTimestamp != nil) || (p.Type != "openai" && p.Type != "anthropic") {
			return nil, errors.New("provider type or lifecycle changed")
		}
		row = base(p.Name, p.ID, p.Labels)
		row["endpoint"] = p.Spec.Config["OPENAI_BASE_URL"]
		if p.Type == "anthropic" {
			row["provider_type"] = "anthropic"
			row["endpoint"] = p.Spec.Config["ANTHROPIC_BASE_URL"]
		}
		row["credential_env"] = p.Labels[CredentialLabel]
	case "route":
		w, err := observe(ctx, c, "workspace", "", workspace, removing)
		if err != nil || w == nil {
			return nil, err
		}
		r, err := c.Inference().GetRoute(ctx, workspace, "")
		if v1.IsNotFound(err) {
			return nil, nil
		}
		if err != nil {
			return nil, remoteError("read inference route", err)
		}
		if r == nil || r.ProviderName == "" {
			return nil, errors.New("incomplete inference route response")
		}
		row = Row{"name": name, "id": w["id"] + "/primary", "owner": w["owner"], "generation": w["generation"], "provider_name": r.ProviderName, "model": r.ModelID}
	case "sandbox":
		s, err := c.Sandboxes().Get(ctx, workspace, name)
		if v1.IsNotFound(err) {
			return nil, nil
		}
		if err != nil {
			return nil, remoteError("read sandbox", err)
		}
		if s == nil {
			return nil, errors.New("incomplete sandbox response")
		}
		if s.Spec.Template == nil || (!removing && s.DeletionTimestamp != nil) {
			return nil, errors.New("sandbox template or lifecycle is unavailable")
		}
		row = base(s.Name, s.ID, s.Labels)
		row["image"] = s.Spec.Template.Image
		row["agent_name"] = s.Labels[AgentLabel]
		row["agent_runtime"] = s.Labels[AgentRuntimeLabel]
		if row["agent_runtime"] != "" && !isFabric([]string{row["agent_runtime"]}) {
			return nil, errors.New("unsupported sandbox agent runtime")
		}
		row["phase"] = string(s.Status.Phase)
		if row["phase"] == "" {
			return nil, errors.New("incomplete sandbox phase")
		}
		if !slices.Equal(s.Spec.Command, Command(row["agent_runtime"])) || !maps.Equal(s.Spec.Environment, Environment(row["agent_name"], row["agent_runtime"])) {
			return nil, errors.New("sandbox launch specification drifted")
		}
		if !policyEqual(s.Spec.Policy, Policy()) {
			return nil, errors.New("sandbox declared policy is missing or drifted")
		}
		if s.Status.Phase == v1.SandboxReady && s.DeletionTimestamp == nil {
			status, err := c.Policy().GetStatus(ctx, workspace, name)
			if err != nil {
				return nil, remoteError("read active sandbox policy", err)
			}
			if status == nil || status.ActiveVersion == 0 || status.ActiveVersion != status.Revision.Version || status.Revision.Status != v1.PolicyLoadStatusLoaded || !policyEqual(status.Revision.Policy, Policy()) {
				return nil, errors.New("sandbox policy is not the expected active policy")
			}
		}
	default:
		return nil, errors.New("unknown resource type")
	}
	if kind != "workspace" {
		row["workspace"] = workspace
	}
	for _, field := range append(slices.Clone(DefinitionFor(kind).Fields), "id") {
		if field != "credential_env" && field != "agent_runtime" && field != "provider_type" && row[field] == "" {
			return nil, fmt.Errorf("incomplete %s response", kind)
		}
	}
	if row["name"] != name {
		return nil, errors.New("resource response identity does not match the request")
	}
	return row, nil
}

func VerifyIdentity(expected, observed Row) error {
	if observed == nil {
		return errors.New("resource is absent")
	}
	for _, k := range []string{"owner", "generation"} {
		if expected[k] == "" || expected[k] != observed[k] {
			return fmt.Errorf("resource %s conflict; automatic adoption is forbidden", k)
		}
	}
	if expected["id"] != "" && expected["id"] != observed["id"] {
		return errors.New("resource identity changed; recovery requires inspection")
	}
	return nil
}

func Ensure(ctx context.Context, c Client, kind string, want Row) (Row, error) {
	if kind != "workspace" {
		w, err := Observe(ctx, c, "workspace", "", want["workspace"])
		if err != nil {
			return nil, err
		}
		if w == nil || w["owner"] != want["owner"] {
			return nil, errors.New("deployment workspace ownership conflict")
		}
	}
	live, err := Observe(ctx, c, kind, want["workspace"], want["name"])
	if err != nil {
		return nil, err
	}
	if live != nil {
		if err := VerifyIdentity(want, live); err != nil {
			return nil, err
		}
	}
	if live == nil && want["id"] != "" {
		return nil, errors.New("managed resource disappeared; automatic replacement is forbidden")
	}
	if live == nil {
		switch kind {
		case "workspace":
			_, err = c.Workspaces().Create(ctx, want["name"], labels(want))
		case "provider":
			p, e := provider(want)
			if e != nil {
				return nil, e
			}
			_, err = c.Providers().Create(ctx, want["workspace"], p)
		case "route":
			_, err = c.Inference().SetRoute(ctx, want["workspace"], &v1.InferenceRouteConfig{ProviderName: want["provider_name"], ModelID: want["model"], TimeoutSecs: 120})
		case "sandbox":
			l := labels(want)
			l[AgentLabel] = want["agent_name"]
			if want["agent_runtime"] != "" {
				l[AgentRuntimeLabel] = want["agent_runtime"]
			}
			_, err = c.Sandboxes().Create(ctx, want["workspace"], want["name"], &v1.SandboxSpec{Template: &v1.SandboxTemplate{Image: want["image"]}, Environment: Environment(want["agent_name"], want["agent_runtime"]), Command: Command(want["agent_runtime"]), Policy: Policy()}, l)
		}
		if err != nil {
			return nil, remoteError("create "+kind, err)
		}
	} else {
		switch kind {
		case "provider":
			if live["provider_type"] != want["provider_type"] {
				return nil, errors.New("provider type is immutable; teardown is required")
			}
			if live["endpoint"] != want["endpoint"] || live["credential_env"] != want["credential_env"] {
				p, e := provider(want)
				if e != nil {
					return nil, e
				}
				current, e := c.Providers().Get(ctx, want["workspace"], want["name"])
				if e != nil {
					return nil, remoteError("reread provider", e)
				}
				if e = VerifyIdentity(want, base(current.Name, current.ID, current.Labels)); e != nil {
					return nil, e
				}
				p.ID = current.ID
				p.ResourceVersion = current.ResourceVersion
				_, err = c.Providers().Update(ctx, want["workspace"], p)
			}
		case "route":
			if live["provider_name"] != want["provider_name"] || live["model"] != want["model"] {
				_, err = c.Inference().SetRoute(ctx, want["workspace"], &v1.InferenceRouteConfig{ProviderName: want["provider_name"], ModelID: want["model"], TimeoutSecs: 120})
			}
		}
		if err != nil {
			return nil, remoteError("update "+kind, err)
		}
	}
	got, err := Observe(ctx, c, kind, want["workspace"], want["name"])
	if err != nil {
		return nil, err
	}
	if err := VerifyIdentity(want, got); err != nil {
		return nil, err
	}
	for _, k := range DefinitionFor(kind).Fields {
		if want[k] != got[k] {
			return nil, fmt.Errorf("%s %s did not reach the requested value", kind, k)
		}
	}
	return got, nil
}

func provider(r Row) (*v1.Provider, error) {
	credential := "empty"
	if r["credential_env"] != "" {
		var err error
		credential, err = Resolve(r["credential_env"])
		if err != nil {
			return nil, err
		}
	}
	l := labels(r)
	l[CredentialLabel] = r["credential_env"]
	providerType, baseKey, credentialKey := "openai", "OPENAI_BASE_URL", "OPENAI_API_KEY"
	if r["provider_type"] == "anthropic" {
		providerType, baseKey, credentialKey = "anthropic", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY"
	} else if r["provider_type"] != "" {
		return nil, errors.New("unsupported provider type")
	}
	return &v1.Provider{Name: r["name"], Type: providerType, Labels: l, Spec: v1.ProviderSpec{Config: map[string]string{baseKey: r["endpoint"]}, Credentials: map[string]string{credentialKey: credential}}}, nil
}
