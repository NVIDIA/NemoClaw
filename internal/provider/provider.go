// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package provider

import (
	"context"
	"fmt"
	"slices"
	"time"

	"github.com/NVIDIA/NemoClaw/internal/config"
	"github.com/NVIDIA/NemoClaw/internal/managed"
	"github.com/NVIDIA/NemoClaw/internal/ollama"
	oshell "github.com/NVIDIA/NemoClaw/internal/openshell"
	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	framework "github.com/hashicorp/terraform-plugin-framework/provider"
	ps "github.com/hashicorp/terraform-plugin-framework/provider/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/tfsdk"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

const Address = "registry.opentofu.org/nvidia/nemoclaw"

var Version = "0.1.0"

type Provider struct{}

func New() framework.Provider { return &Provider{} }
func (*Provider) Metadata(_ context.Context, _ framework.MetadataRequest, r *framework.MetadataResponse) {
	r.TypeName = "nemoclaw"
	r.Version = Version
}
func (*Provider) Schema(_ context.Context, _ framework.SchemaRequest, r *framework.SchemaResponse) {
	a := map[string]ps.Attribute{"endpoint": ps.StringAttribute{Required: true}}
	for _, n := range []string{"credential_env", "tls_ca_env", "tls_certificate_env", "tls_key_env", "ollama_engine"} {
		a[n] = ps.StringAttribute{Optional: true}
	}
	r.Schema = ps.Schema{Attributes: a}
}
func (*Provider) Configure(ctx context.Context, q framework.ConfigureRequest, r *framework.ConfigureResponse) {
	get := func(n string) string {
		var v types.String
		r.Diagnostics.Append(q.Config.GetAttribute(ctx, path.Root(n), &v)...)
		return v.ValueString()
	}
	g := config.Gateway{Management: "external", Endpoint: get("endpoint")}
	if n := get("credential_env"); n != "" {
		g.Credential = &config.Credential{Env: n}
	}
	if n := get("tls_ca_env"); n != "" {
		g.TLS = &config.TLS{CA: config.Credential{Env: n}, Certificate: config.Credential{Env: get("tls_certificate_env")}, Key: config.Credential{Env: get("tls_key_env")}}
	}
	if r.Diagnostics.HasError() {
		return
	}
	c, err := oshell.Connect(g)
	if err != nil {
		r.Diagnostics.AddError("Gateway connection", err.Error())
		return
	}
	clients := resourceClients{gateway: c}
	if endpoint := get("ollama_engine"); endpoint != "" {
		clients.docker, err = ollama.NewDocker(endpoint)
		if err != nil {
			r.Diagnostics.AddError("Ollama engine", err.Error())
			return
		}
	}
	r.ResourceData = clients
}
func (*Provider) Resources(context.Context) []func() resource.Resource {
	var result []func() resource.Resource
	for _, d := range oshell.Definitions {
		result = append(result, func() resource.Resource { return &Resource{definition: d} })
	}
	for _, d := range ollamaDefinitions {
		result = append(result, func() resource.Resource { return &Resource{definition: d} })
	}
	for _, d := range managedDefinitions {
		result = append(result, func() resource.Resource { return &Resource{definition: d} })
	}
	return result
}
func (*Provider) DataSources(context.Context) []func() datasource.DataSource { return nil }

type Resource struct {
	definition     oshell.Definition
	client         oshell.Client
	docker         *ollama.Docker
	runtimeFactory func(string) (*managed.Docker, error)
}

type resourceClients struct {
	gateway oshell.Client
	docker  *ollama.Docker
}

func (r *Resource) Metadata(_ context.Context, _ resource.MetadataRequest, out *resource.MetadataResponse) {
	out.TypeName = "nemoclaw_" + r.definition.Kind
}
func (r *Resource) Schema(_ context.Context, _ resource.SchemaRequest, out *resource.SchemaResponse) {
	a := map[string]schema.Attribute{"id": schema.StringAttribute{Computed: true, PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()}}}
	for _, n := range r.definition.Fields {
		attr := schema.StringAttribute{Required: true}
		if n == "running" && (r.definition.Kind == managed.GatewayKind || r.definition.Kind == managed.ServiceKind) {
			a[n] = schema.StringAttribute{Computed: true}
			continue
		}
		if !slices.Contains(r.definition.Mutable, n) {
			attr.PlanModifiers = []planmodifier.String{stringplanmodifier.RequiresReplace()}
		}
		a[n] = attr
	}
	if r.definition.Kind == "ollama_model" {
		a["digest"] = schema.StringAttribute{Computed: true}
	}
	out.Schema = schema.Schema{Attributes: a}
}
func (r *Resource) Configure(_ context.Context, q resource.ConfigureRequest, out *resource.ConfigureResponse) {
	if q.ProviderData == nil {
		return
	}
	c, ok := q.ProviderData.(resourceClients)
	if !ok {
		out.Diagnostics.AddError("Provider configuration", "invalid gateway client")
		return
	}
	r.client = c.gateway
	r.docker = c.docker
}

type attributeReader interface {
	GetAttribute(context.Context, path.Path, any) diag.Diagnostics
}

func (r *Resource) values(ctx context.Context, source attributeReader, diags *diag.Diagnostics) oshell.Row {
	row := oshell.Row{}
	for _, n := range append(slices.Clone(r.definition.Fields), "id") {
		var v types.String
		diags.Append(source.GetAttribute(ctx, path.Root(n), &v)...)
		row[n] = v.ValueString()
	}
	return row
}
func (r *Resource) put(ctx context.Context, state *tfsdk.State, row oshell.Row, diags *diag.Diagnostics) {
	for _, n := range append(slices.Clone(r.definition.Fields), "id") {
		diags.Append(state.SetAttribute(ctx, path.Root(n), types.StringValue(row[n]))...)
	}
	if r.definition.Kind == "ollama_model" {
		diags.Append(state.SetAttribute(ctx, path.Root("digest"), types.StringValue(row["digest"]))...)
	}
}
func (r *Resource) Read(ctx context.Context, q resource.ReadRequest, out *resource.ReadResponse) {
	// Retain the last known identity on every failed observation.
	out.State = q.State
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	want := r.values(ctx, q.State, &out.Diagnostics)
	if out.Diagnostics.HasError() {
		return
	}
	if r.definition.Kind == managed.GatewayKind || r.definition.Kind == managed.ServiceKind || r.definition.Kind == managed.StorageKind || r.definition.Kind == managed.GatewayStorageKind {
		got, err := r.managed(ctx, want, false)
		if err != nil {
			out.Diagnostics.AddError("Resource observation", err.Error())
			return
		}
		if got == nil {
			out.State.RemoveResource(ctx)
			return
		}
		r.put(ctx, &out.State, got, &out.Diagnostics)
		return
	}
	if r.definition.Kind == "ollama" || r.definition.Kind == "ollama_model" {
		got, err := r.readOllama(ctx, want)
		if err != nil {
			out.Diagnostics.AddError("Resource observation", err.Error())
			return
		}
		if got == nil {
			out.State.RemoveResource(ctx)
			return
		}
		r.put(ctx, &out.State, got, &out.Diagnostics)
		return
	}
	got, err := oshell.Observe(ctx, r.client, r.definition.Kind, want["workspace"], want["name"])
	if err != nil {
		out.Diagnostics.AddError("Resource observation", err.Error())
		return
	}
	if got == nil {
		out.State.RemoveResource(ctx)
		return
	}
	if err = oshell.VerifyIdentity(want, got); err != nil {
		out.Diagnostics.AddError("Resource observation", err.Error())
		return
	}
	r.put(ctx, &out.State, got, &out.Diagnostics)
}
func (r *Resource) Create(ctx context.Context, q resource.CreateRequest, out *resource.CreateResponse) {
	want := r.values(ctx, q.Plan, &out.Diagnostics)
	if out.Diagnostics.HasError() {
		return
	}
	r.apply(ctx, want, q.Plan, &out.State, &out.Diagnostics)
}
func (r *Resource) Update(ctx context.Context, q resource.UpdateRequest, out *resource.UpdateResponse) {
	want := r.values(ctx, q.Plan, &out.Diagnostics)
	if out.Diagnostics.HasError() {
		return
	}
	out.State = q.State
	r.apply(ctx, want, q.Plan, &out.State, &out.Diagnostics)
}
func (r *Resource) apply(ctx context.Context, want oshell.Row, plan tfsdk.Plan, state *tfsdk.State, diags *diag.Diagnostics) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	var got oshell.Row
	var err error
	if r.definition.Kind == managed.GatewayKind || r.definition.Kind == managed.ServiceKind || r.definition.Kind == managed.StorageKind || r.definition.Kind == managed.GatewayStorageKind {
		got, err = r.managed(ctx, want, true)
	} else if r.definition.Kind == "ollama" || r.definition.Kind == "ollama_model" {
		got, err = r.applyOllama(ctx, want)
	} else {
		got, err = oshell.Ensure(ctx, r.client, r.definition.Kind, want)
	}
	if err != nil {
		diags.AddError("Apply incomplete", err.Error()+"; retain the state directory and reapply the same YAML to reconcile")
		return
	}
	state.Raw = plan.Raw
	state.Schema = plan.Schema
	r.put(ctx, state, got, diags)
}
func (r *Resource) Delete(ctx context.Context, q resource.DeleteRequest, out *resource.DeleteResponse) {
	if r.definition.Kind == managed.ServiceKind || r.definition.Kind == managed.GatewayKind {
		want := r.values(ctx, q.State, &out.Diagnostics)
		if out.Diagnostics.HasError() {
			return
		}
		s, err := managedSpec(want, r.definition.Kind)
		if err != nil {
			out.Diagnostics.AddError("Replacement rejected", err.Error())
			return
		}
		d, err := r.runtimeClient(s.Gateway.Engine)
		if err != nil {
			out.Diagnostics.AddError("Replacement rejected", err.Error())
			return
		}
		defer d.Close()
		if err = d.ReplaceContainer(ctx, s, want["id"]); err != nil {
			out.Diagnostics.AddError("Replacement incomplete", err.Error())
		}
		return
	}
	out.Diagnostics.AddError("Deletion forbidden", fmt.Sprintf("ordinary apply cannot delete or replace a %s", r.definition.Kind))
}
