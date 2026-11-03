# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Registrations are scoped by image and harness: each of the three agents gets
# its own inference registration and its own web search registration, from the
# deployment, its sandbox, or itself. The unused integration is not registered.

run "fixtures" {
  command = plan

  module {
    source = "./cases/kubernetes-search-scopes"
  }

  plan_options {
    target = [data.fixture_state.setup]
  }
}

run "deploy" {
  module {
    source = "./cases/kubernetes-search-scopes"
  }
}

# Teardown's plan observes what deploy left.
run "teardown" {
  module {
    source = "./cases/kubernetes-search-scopes"
  }

  variables {
    permit_destroy = true
  }

  assert {
    condition     = length(module.observed.registrations) == 6
    error_message = "The deployment does not hold one inference and one web search registration for each harness."
  }

  assert {
    condition = sort(flatten([
      for registration in values(module.observed.registrations) : values(registration.credentials)
    ])) == tolist(["env:BRAVE_API_KEY", "env:BRAVE_API_KEY", "env:TAVILY_API_KEY"])
    error_message = "The registrations hold other credentials than the three referenced searches'; the unused integration may be registered."
  }

  assert {
    condition = (
      { for name, agent in module.observed.agents : name => length(agent.providers) } == { assistant = 2, hermes = 2, pi = 2 }
      && length(distinct(flatten([for agent in values(module.observed.agents) : agent.providers]))) == 6
    )
    error_message = "A sandbox does not attach exactly its own two registrations, or shares one with another harness."
  }

  assert {
    condition = {
      for name, agent in module.observed.agents : name => sort(flatten([
        for provider in agent.providers : values(module.observed.registrations[provider].credentials)
      ]))
      } == {
      assistant = tolist(["env:TAVILY_API_KEY"])
      hermes    = tolist(["env:BRAVE_API_KEY"])
      pi        = tolist(["env:BRAVE_API_KEY"])
    }
    error_message = "An agent's web search registration is not the one its document scope declares."
  }
}
