// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package provider

import (
	"context"
	"encoding/json/v2"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/NVIDIA/NemoClaw/internal/managed"
	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/tfsdk"
	"github.com/hashicorp/terraform-plugin-framework/types"
	"github.com/moby/moby/client"
)

func TestManagedProviderRefreshRetainsStateOnObservationFailure(t *testing.T) {
	for _, failure := range []string{"none", "authentication", "transport", "partial", "changed identity", "missing bound storage", "confirmed initial absence"} {
		t.Run(failure, func(t *testing.T) {
			spec := managed.Storage{Name: "nc-68d203b0c7e6083f-inference-data", Owner: "302ff5e1-088d-42ce-959f-4ff4c3570c13", Generation: strings.Repeat("a", 32), Engine: "unix:///var/run/docker.sock"}
			writes := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "GET" {
					writes++
					t.Error("refresh attempted a mutation")
					w.WriteHeader(500)
					return
				}
				if strings.HasSuffix(r.URL.Path, "/info") {
					fmt.Fprint(w, `{"ID":"engine"}`)
					return
				}
				switch failure {
				case "authentication":
					w.WriteHeader(403)
				case "transport":
					w.WriteHeader(503)
				case "partial":
					fmt.Fprint(w, `{}`)
				case "missing bound storage", "confirmed initial absence":
					w.WriteHeader(404)
					fmt.Fprint(w, `{"message":"absent"}`)
				default:
					created := "created"
					if failure == "changed identity" {
						created = "other"
					}
					json.MarshalWrite(w, map[string]any{"Name": spec.Name, "CreatedAt": created, "Driver": "local", "Labels": map[string]string{managed.OwnerLabel: spec.Owner, managed.GenerationLabel: spec.Generation}})
				}
			}))
			defer server.Close()
			r := Resource{definition: managedDefinitions[2], runtimeFactory: func(string) (*managed.Docker, error) {
				c, e := client.New(client.WithHost(server.URL), client.WithAPIVersion("1.53"))
				return &managed.Docker{API: c}, e
			}}
			var schema resource.SchemaResponse
			r.Schema(t.Context(), resource.SchemaRequest{}, &schema)
			b, _ := json.Marshal(spec)
			id := "engine/" + spec.Name + "/created"
			if failure == "confirmed initial absence" {
				id = ""
			}
			value, diags := types.ObjectValue(map[string]attr.Type{"id": types.StringType, "spec": types.StringType}, map[string]attr.Value{"id": types.StringValue(id), "spec": types.StringValue(string(b))})
			if diags.HasError() {
				t.Fatal(diags)
			}
			state := tfsdk.State{Schema: schema.Schema}
			if diags = state.Set(t.Context(), value); diags.HasError() {
				t.Fatal(diags)
			}
			out := resource.ReadResponse{}
			r.Read(context.Background(), resource.ReadRequest{State: state}, &out)
			switch failure {
			case "none":
				if out.Diagnostics.HasError() || !out.State.Raw.Equal(state.Raw) {
					t.Fatal("successful refresh changed binding", out.Diagnostics)
				}
			case "confirmed initial absence":
				if out.Diagnostics.HasError() || !out.State.Raw.IsNull() {
					t.Fatal("confirmed absence was not distinguished", out.Diagnostics)
				}
			default:
				if !out.Diagnostics.HasError() || !out.State.Raw.Equal(state.Raw) {
					t.Fatal("observation failure discarded state or permitted recreation", out.Diagnostics)
				}
			}
			if writes != 0 {
				t.Fatal("refresh mutated resources")
			}
		})
	}
}

func TestStoppedRuntimePlansRestartWithoutPromisingReadiness(t *testing.T) {
	for _, definition := range managedDefinitions[:2] {
		for _, running := range []string{"true", "false"} {
			t.Run(definition.Kind+"/"+running, func(t *testing.T) {
				r := Resource{definition: definition}
				var schema resource.SchemaResponse
				r.Schema(t.Context(), resource.SchemaRequest{}, &schema)
				if !schema.Schema.Attributes["running"].IsComputed() || schema.Schema.Attributes["running"].IsRequired() {
					t.Fatal("process readiness is a creation promise")
				}
				value, diags := types.ObjectValue(map[string]attr.Type{"id": types.StringType, "spec": types.StringType, "running": types.StringType}, map[string]attr.Value{"id": types.StringValue("durable-id"), "spec": types.StringValue("retained-spec"), "running": types.StringValue(running)})
				if diags.HasError() {
					t.Fatal(diags)
				}
				state := tfsdk.State{Schema: schema.Schema}
				if diags := state.Set(t.Context(), value); diags.HasError() {
					t.Fatal(diags)
				}
				plan := tfsdk.Plan{Schema: schema.Schema, Raw: state.Raw}
				out := resource.ModifyPlanResponse{Plan: plan}
				r.ModifyPlan(t.Context(), resource.ModifyPlanRequest{State: state, Plan: plan}, &out)
				var actual, id types.String
				out.Diagnostics.Append(out.Plan.GetAttribute(t.Context(), path.Root("running"), &actual)...)
				out.Diagnostics.Append(out.Plan.GetAttribute(t.Context(), path.Root("id"), &id)...)
				if out.Diagnostics.HasError() || actual.IsUnknown() != (running == "false") || id.ValueString() != "durable-id" || len(out.RequiresReplace) != 0 {
					t.Fatal("restart plan lost identity or could taint an immediately stopped process", out.Diagnostics)
				}
			})
		}
	}
}
