// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package provider

import (
	"context"
	"encoding/json/v2"
	"errors"
	"strconv"

	"github.com/NVIDIA/NemoClaw/internal/managed"
	oshell "github.com/NVIDIA/NemoClaw/internal/openshell"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

var managedDefinitions = []oshell.Definition{
	{Kind: managed.GatewayKind, Fields: []string{"spec", "running"}, Mutable: []string{"running"}},
	{Kind: managed.ServiceKind, Fields: []string{"spec", "running"}, Mutable: []string{"running"}},
	{Kind: managed.StorageKind, Fields: []string{"spec"}},
}

func managedSpec(row oshell.Row, kind string) (managed.Spec, error) {
	var s managed.Spec
	if json.Unmarshal([]byte(row["spec"]), &s) != nil || s.Kind != kind {
		return s, errors.New("invalid managed runtime specification")
	}
	return s, s.Validate()
}

func (r *Resource) managed(ctx context.Context, want oshell.Row, apply bool) (oshell.Row, error) {
	if r.definition.Kind == managed.StorageKind {
		var s managed.Storage
		if json.Unmarshal([]byte(want["spec"]), &s) != nil {
			return nil, errors.New("invalid model storage specification")
		}
		d, err := r.runtimeClient(s.Engine)
		if err != nil {
			return nil, err
		}
		defer d.Close()
		id, err := d.Storage(ctx, s, want["id"], apply)
		if err != nil || id == "" {
			return nil, err
		}
		return oshell.Row{"id": id, "spec": want["spec"]}, nil
	}
	s, err := managedSpec(want, r.definition.Kind)
	if err != nil {
		return nil, err
	}
	d, err := r.runtimeClient(s.Gateway.Engine)
	if err != nil {
		return nil, err
	}
	defer d.Close()
	var o *managed.Observation
	if apply {
		o, err = d.Ensure(ctx, s, want["id"])
	} else {
		o, err = d.Observe(ctx, s, want["id"])
	}
	if err != nil || o == nil {
		return nil, err
	}
	return oshell.Row{"id": o.ID, "spec": want["spec"], "running": strconv.FormatBool(o.Running)}, nil
}

func (r *Resource) runtimeClient(engine string) (*managed.Docker, error) {
	if r.runtimeFactory != nil {
		return r.runtimeFactory(engine)
	}
	return managed.New(engine)
}

// Running is observed, not a promise that startup cannot fail. Keep it unknown
// during create and a planned restart so an immediate process exit can still
// establish durable configuration without Terraform tainting the container.
func (r *Resource) ModifyPlan(ctx context.Context, q resource.ModifyPlanRequest, out *resource.ModifyPlanResponse) {
	if r.definition.Kind != managed.GatewayKind && r.definition.Kind != managed.ServiceKind {
		return
	}
	if q.State.Raw.IsNull() || q.Plan.Raw.IsNull() {
		return
	}
	var running types.String
	out.Diagnostics.Append(q.State.GetAttribute(ctx, path.Root("running"), &running)...)
	if running.ValueString() == "false" {
		out.Diagnostics.Append(out.Plan.SetAttribute(ctx, path.Root("running"), types.StringUnknown())...)
	}
}
