<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Principles of Scalable Asset Structure in OpenUSD

> **Canonical URL:** https://docs.omniverse.nvidia.com/usd/latest/learn-openusd/independent/asset-structure-principles.html
>
> If you have network access, read the live URL — it may be more current than this local copy.

---

See also

Learn OpenUSD provides a guided learning experience that covers the topics covered in this guide with a hands-on approach in the [Asset Structure Principles and Content Aggregation](https://docs.nvidia.com/learn-openusd/latest/asset-structure/index.html) module.

This guide is for programmers looking to how to develop structures for their teams, some practical best practices, and potential future work related to asset structures in OpenUSD. Background in media and entertainment tooling not required; readers should have experience with the OpenUSD python API and familiarity with exploring scenes in tools like `usdview`.

For those familiar with asset structures and pipelines and looking for a lighter read, consider checking out the [Principles Quick Reference](#principles-quick-reference) and [Annotated Asset Structures](#annotated-asset-structures) at the end of this document.

Tip

the OpenUSD Terms & Concepts page may prove useful to you as a quick reference of USD concepts.

## Overview
*“Asset Structures are never finished, only abandoned”*

### What is an asset?
An asset is a **named**, **versioned**, and **structured** container of one or more resources which may include composable OpenUSD layers, textures, volumetric data, and more. Assets come with an expectation of persistence and may require maintenance to stay up to date with current standards, repair defects observed downstream, or honor requests for upgrades (an updated design, more variation, or increased resolution). Assets structure facilitates reuse of this persistent data.

OpenUSD provides an `asset` path field type for the `Ar` asset resolver library and plugin system. `asset` path valued fields are generally identifiers to resources within a structured container asset.

It’s not uncommon to see terminology like “asset”, “model”, “assembly”, “element”, “component”, “set”, “shot”, “file”, and “package” when talking about structuring production data. For some users, these are all roughly synonymous. For others, some of these terms may have precise definitions that aren’t always consistent across domains and sites. This document strives for internal consistency with its definitions to minimize confusion, but some ambiguity may be unavoidable in this overloaded space.

### Are all scenes described by OpenUSD assets?
Not all scenes described by OpenUSD are assets. When OpenUSD is used to interchange or generate scene description for particular process or a session’s set of processes, layers used may be ephemeral and used without any expectations of reuse. Pipelines may make different structural tradeoffs when describing *session artifacts* that aren’t persistent, but some of these principles may apply as well. These session artifacts often have dependencies on assets.

For those with visual effects production backgrounds, this document considers “shots”, “sequences”, “props”, “sets”, “characters”, “environments” and “motion clips” to all be assets requiring naming, versioning, and structure. However, different asset categories may have different needs and therefore different structures, naming, and versioning semantics even at the same site.

### What makes asset structure necessary?
Asset structure empowers the scalability of an organization and ecosystem. Just as software architects need levels of abstraction from individual lines of code and functions to reason about how a system works together, a pipeline architect uses asset structure to model the flow of content through production.

The challenges of structuring assets in the OpenUSD ecosystem are not dissimilar from the challenges of structuring a collaborative code base. Inconsistent conventions and patterns can add friction to developer collaboration and debugging. No conventions can lead to [bikeshedding](https://en.wikipedia.org/wiki/Law_of_triviality) around when to use snake vs. camel case. An overly rigid structure can lead to complex anti-patterns.

Just as there is no universal way to organize code or structure a composite image, there’s no best way to structure an OpenUSD asset for all usage and domains. An asset structure achieves scalability by accelerating collaboration through *parallel and modular workstreams*, *minimizing conceptual bloat*, and *effective balance of openness and resilience to change*.

## Background
Readers should be familiar with the following terminology and concepts.

- 
[Asset Resolution](https://openusd.org/release/glossary.html#usdglossary-assetresolution)
[asset (resource)](https://openusd.org/release/glossary.html#asset)

- 
[Model Hierarchy](https://openusd.org/release/glossary.html#usdglossary-modelhierarchy)
[kind (metadata)](https://openusd.org/release/glossary.html#usdglossary-kind)

- [assembly (model hierarchy)](https://openusd.org/release/glossary.html#assembly)

- [component (model hierarchy)](https://openusd.org/release/glossary.html#component)

- 
[Composition Arcs](https://openusd.org/release/glossary.html#usdglossary-compositionarcs)
[Root Layer Stack](https://openusd.org/release/glossary.html#usdglossary-rootlayerstack)

- [Class (prim specifier)](https://openusd.org/release/glossary.html#class)

- [active (metadata)](https://openusd.org/release/glossary.html#active-inactive)

- [instanceable (metadata)](https://openusd.org/release/glossary.html#instanceable)

- [subLayers (composition arc)](https://openusd.org/release/glossary.html#usdglossary-sublayers)

- [references (composition arc)](https://openusd.org/release/glossary.html#usdglossary-references)

- [payload (composition arc)](https://openusd.org/release/glossary.html#usdglossary-payload)

- [variantSets (composition arc)](https://openusd.org/release/glossary.html#usdglossary-variantset)

- [inherits (composition arc)](https://openusd.org/release/glossary.html#usdglossary-inherits)

- [primvar](https://openusd.org/release/glossary.html#usdglossary-primvar)

- [purpose](https://openusd.org/release/glossary.html#usdglossary-purpose)

- [Crate File Format](https://openusd.org/release/glossary.html#crate-file-format)

## Planning an Asset Structure
A scalable asset structure flows from the needs of your **clients** and your **collaborators**. A scalable asset structure should be **legible**, **modular**, **performant**, and **navigable**.

### Understanding Your Clients
To resurface our coding analogy, open source code libraries may organize around long term stability of APIs while a user facing application may organize around rapid fix and feature deployment.

If OpenUSD is an intermediate stage in generating your final deliverable content (like an image or video), there’s usually more flexibility in your structure. But if the asset is the deliverable or a part of an interactive experience, the structure will be dictated in part by both the client’s specified and anticipated needs.

Be mindful that clients frequently precipitate change as their needs become clearer or evolve over the course of a project. A modular asset structure will allow for iterative asset revisions and updates at various stages in a pipeline.

### Understanding Your Collaborators
Collaboration is core in OpenUSD. Asset structures need to accommodate the scale of teams and how they organize. A scalable asset structure should enable parallel workstreams across multiple axes.

When building your pipeline, collaborators may include people who never directly interact with OpenUSD data or APIs. Systems engineers responsible for managing storage and network resources are important partners in designing a scalable asset pipeline. Producers and managers need to build schedules and plans around asset deliveries and resourcing separate from the specifics of OpenUSD layer and prim path structure. A full-featured but complex structure that complicates scheduling and planning may not outperform a pipeline with simpler constructs.

The need for incorporation of third party assets should be considered in your asset structure. Just as it’s hard for a developer to impose their own coding conventions on third party libraries, an asset structure that’s too rigid may complicate ingestion and incorporation of third party work.

## Principles of Asset Structure
When developing an asset structure, the following principles can guide toward a scalable structure.

### Legibility
*Do prim, property, and resource identifiers effectively represent the intent and type of their representation?*

Identifiers are frequently embedded (queries, logs, arguments, warnings, etc.), and their clarity can guide triage and communication before a `OpenUSD` stage is even opened. Legibility may mean different things in different domains. Sometimes, a simple visual description (ie. `LargeCardboardBox`) would be preferable way to name an asset or prim. In other contexts, explicit product codes (ie. `ID_2023_5678`) might be the most readable.

### Modularity
*Does a structure facilitate iterative improvement of reusable content?*

Be mindful that reuse saves not just on user time spent but also can allow for storage and resources to be shared when in distributed computing contexts.

### Performance
*Does a structure accelerate content read and write speeds for users and processes?*

A performant asset structure can mean a wide variety of things. It can mean the interactive performance and speed with which an individual user can work with an asset. It can also mean the speed at which a new asset (say a film sequence) can be setup or a fix can be robustly deployed across a variety of contexts.

### Navigability
*Does a structure facilitate discovery of elements while retaining flexibility?*

Assets often are structured around multiple hierarchical paths (resource identifiers, file paths, prim paths, model hierarchy, etc.). A navigable asset structure simplifies discovery of objects through inspection.

## Structuring an Asset Interface
Every asset intended to be `UsdStage.Open`-ed or added to a scene via `references` has a root layer. As the primarily way an asset is interacted with, this root layer functions as the *asset interface layer*.

This document also considers important descendant prims (like `Material` or `subcomponent` prims) that maintainers have advertised as stable for downstream overrides as part of an asset’s interface as well, a public *asset prim interface*.

- Model the **user** and **computational workstreams** as layers that contribute opinions to the asset

- Provide one or more **parameterized entrypoint** prims as referencing targets and sources for metadata and hints

- Organize prim hierarchy into **partitions** and with **public** and **internal** roles

- Keep lightweight and important fields **lofted** above payloads

### Modeling Workstreams with Layer Stacks
Applications and libraries developed by organizations rarely consist of a single file. Work is organized into logical maintainable units. Assets should similarly model workstreams into layers.

#### User Workstreams
Simple assets can be broken up into flat layer stacks. Different tools, users, and departments might be responsible for contributing different prims to the final composed scene graph (such as geometry and materials). Splitting workflows into parallel streams can reap performance benefits as well. The same geometry layer can be used while a material layer is iterated on (and vice versa), reducing storage needs and publishing time.

[
 @./geometry.usd@,
 @./material.usd@
]

Layer stacks are sometimes better modeled with an encapsulated nesting structure. In the example below, consider layers common to the sequence: `gaffer.usd`, `lenses.usd`, and `location.usd`.

[
 @uri:/project/sequences/10/shots/5/lights.usd@,
 @uri:/project/sequences/10/shots/5/camera.usd@,
 @uri:/project/sequences/10/shots/5/action.usd@,
 @uri:/project/sequences/10/gaffer.usd@,
 @uri:/project/sequences/10/lenses.usd@,
 @uri:/project/sequences/10/location.usd@
]

These layers could be encapsulated into a shared.usd layer to avoid needing to explicitly list them and allow the sequence to evolved its set of shared layers.

[
 @uri:/project/sequences/10/shots/5/lights.usd@,
 @uri:/project/sequences/10/shots/5/camera.usd@,
 @uri:/project/sequences/10/shots/5/action.usd@,
 @uri:/project/sequences/10/shared.usd@
]

#### Computational Workstreams
Assets may be broken up into compute workstreams as well. For example, a synthetic data simulation may be partitioned across processes or machines. A layer stack can be used to stich the results back together.

[
 @uri:/project/dataset/simulation/5/poses/SmallRobot_pose.usd@,
 @uri:/project/dataset/simulation/5/poses/LargeRobot_pose.usd@,
 @uri:/project/dataset/simulation/5/poses/MediumRobot_pose.usd@
]

Computational workstreams may be dynamic and may not be consistent from evaluation to evaluation. Consider the following layer stack where workloads have been partitioned dynamically across multiple processes.

[
 @./pid_1001.usd@,
 @./pid_2112.usd@,
 @./pid_5550.usd@
]

Some workstreams are hybrids between computation and user. A layer may contribute synthesized motion on top of the hand authored initial state of a user.

[
 @uri:/project/dataset/computed/actor_simulation.usd@,
 @uri:/project/dataset/authored/actor_initial_state.usd@,
 @uri:/project/dataset/authored/environment.usd@
]

Keep layer stacks simple and manageable. Layer stacks are not an alternative to asset versioning systems.

# Avoid modeling workstreams in layer stacks that might grow procedurally
# over time, as there's a cost to resolving and opening each layer.
[
 @./asset_2023_05_07.usd@,
 @./asset_2023_05_05.usd@,
 @./asset_2023_05_03.usd@,
 ...
 @./asset_2021_12_01.usd@
]

#### Sublayers and Mirroring Resolvers
There are performance and workflow implications to choosing how layer stacks are integrated into a stage. When revisiting the example of our `SmallRobot`, `LargeRobot`, and `MediumRobot` simulation. If their respective pose layers are included as either direct or indirect sublayers of a root layer, they will always be opened and composed, even if their contents are otherwise masked or deactivated.

The OpenUSD “crate” binary file format is highly optimized for this and reads only the minimal set of data required for composition. However, some asset resolvers are “mirroring” and “greedily download” the resolved resource. If a mirroring resolver is used, the binary file must be completely synced to accessible storage before opening. When strictly using sublayers, `SmallRobot`, `LargeRobot`, and `MediumRobot` pose data will be copied even when their contents are not ever composed. This can be avoided if sublayers introduce some indirection so that the heavy pose data in a layer is packaged behind references and/or payloads.

over "actors" {
 # If ancestors are inactive or SmallRobot is masked, the pose data
 # will not be mirrored.
 over "SmallRobot" (references=@./SmallRobot_pose.usd@) { ... }
}

OpenUSD’s “AR 2.0” provides the initial interface to help asset resolvers avoid mirroring, but as mirroring resolvers are still common, the implications of synchronizing the full layer stack must be considered. Mirroring resolvers don’t just complicate deferred loading of layer content, but also textures and volumetric fields which often use tiling and mip-mapping to defer their reads.

### Prims as Asset Entrypoints
Most assets are structured around one or more defined entrypoint prims. Entrypoints can be viewed as an interface for downstream users of the composed stage and provides a handshake about what prims are expected to be the target of `references`.

A single asset entrypoint can be generally specified using root layer `defaultPrim` metadata. OpenUSD’s composition engine will respect this metadata when referencing. Different domains (like `renderSettingsPrimPath`) may introduce other ways to identify domain specific entrypoints.

(
 defaultPrim = "MyAsset"
)

def "MyAsset" { ... }

Library assets (like a palette of related materials) may not have a single entrypoint. Each defined material may be individually referenced into a downstream asset.

def Material "Aluminum" { ... }
def Material "Chrome" { ... }
def Material "Copper" { ... }

`Scope` prims can be used to organize libraries with large numbers of entrypoints. Ancestors of entrypoint prims should generally be devoid of properties as those properties can’t be read downstream.

def Scope "BasicMetals" {
 def Material "Aluminum" { ... }
 def Material "Chrome" { ... }
 def Material "Copper" { ... }
}

def Scope "RustedMetals" {
 def Material "RustedAluminum" { ... }
 def Material "RustedChrome" { ... }
 def Material "RustedCopper" { ... }
}

Sometimes, an entrypoint is just a convention for a particular type of assets to avoid bikeshedding. `/World` has no special role; it’s just the agreed upon parent that keeps the scene outside of the root namespace.

def Scope "World" {
 def "City" (references = @uri:/project/city.usd@) {}
 def "TaxiCab" (references = @uri:/project/taxi_cab.usd@) {}
}

#### Asset Parameterization
Asset parameterization empowers the reuse of content by allowing certain fields and properties to vary downstream. There are two primary ways assets can be parameterized: primvars and variants.

The entrypoint will be the first place where a user goes to figure out if prims have discrete variants. Asset structures may enforce naming conventions and the presence of specific variants. For example, it may be expected that assets provide `color_variant` to describe supported albedo variations.

def Xform "RaceCar" (variantSets = ["color_variant"]) {
 variantSet "colorVariant" = {
 "red" { ... }
 "blue" { ... }
 "green" { ... }
 }
}

Some variation cannot be effectively or efficiently discretized into variants. For these cases, primvars can be used as another form of asset parameterization. Primvars are extra interpolatable parameters primarily for `Gprim` prims to provide additional data to shading contexts. In OpenUSD, primvars have inheritance semantics and can be authored on parent scopes, including the entrypoint of an asset. Materials can be constructed to read `primvars:asset_base_color` or other entrypoint primvars. In the event that multiple prims in a hierarchy author the same primvar, keep in mind that child opinions are stronger than parents. Below, we use `asset_` as a prefix to avoid namespace collisions.

def Xform "RaceCar" {
 color3f primvars:asset_base_color (
 doc = "primary paint color"
 )
 color3f primvars:asset_accent_color (
 doc = "color of accent stripe"
 )
}

Unless otherwise documented or annotated as internal, variants and primvars authored on an asset entrypoint should be generally considered “public” and safe for downstream contexts to edit and set with an expectation of stability.

Both variant selection and primvars on the asset entrypoint are compatible with scene graph instancing. Variations of variant selections will generate new prototypes for downstream contexts while primvars will not. This generally makes parameterization through primvars the lighter choice for single property parameters, providing upfront memory savings at the cost of additional lookups in materials.

#### “reference-payload” Pattern
Instead of expecting users to know whether a complex asset requires payloading, many assets adopt the “reference-payload” pattern. Their interface file is expected to be referenced with payload structure internal to the asset.

Important and inexpensive fields like variant sets, inherits, and more are considered to be lofted above the payload when they’re moved out of the contents layer and into the interface layer.

# A lofted class does not contribute any opinions. It
# just provides a target for the arc.
class "prop_MyAsset" {}

def Xform "MyAsset" (
 variantSets = ["color_variant", "level_of_detail"]
 variants = {
 string color_variant = "red"
 string level_of_detail = "medium"
 }
 inherits = </prop_MyAsset>
 payloads = [@./contents.usd@]
) {
 # The lofted variants do not contribute any opinions.
 # They just advertise the sets and selections specified
 # by the underlying contents payload.
 variantSet "color_variant" {
 "red" {}
 "blue" {}
 }
 variantSet "level_of_detail" {
 "high" {}
 "medium" {}
 "low" {}
 }
}

Lofting fields can avoid the need to load a payload in some contexts, improving overall performance. As there’s no general utility, lofting is usually achieved through site or project specific post-scripts associated with asset generation and publishing. Fields found in the `UsdModelAPI` and `UsdGeomModelAPI` like `extentsHint` are good candidates for “lofting”. `UsdGeomModelAPI` provides a set of fields that enable previewing of payloaded content before loading. Newer releases of OpenUSD have added `UsdMediaAssetPreviewsAPI` as a schema for describing asset thumbnails.

The references to payload pattern can be used to recast a payloads opinion ordering strength.

(
 defaultPrim = "entrypoint"
)

# If entrypoint is `referenced` all opinions contained by its payload
# will be ordered with the strength of the reference
def "entrypoint" (payload=</inline_payload>) {}

def "inline_payload" {
 ...
}

While the example above uses an inline payload for brevity, if a mirroring resolver is used, it becomes important to keep the payload contents in separate layers.

#### “inherits-instanceable” Pattern
OpenUSD’s composition engine by default will provide unique prims for every element in the scene graph. While OpenUSD can compose large stages efficiently (in both time and space) by just ingesting the scene graph topology, clients (like renderers) may need to process the full prim definition. Minimizing traversal over what are effectively duplicate prim hierarchies can be a large savings.

Scene graph instancing disables sparse overrides for a subgraph of the stage, redirecting clients to a shared read-only hierarchy. It’s applied by setting the `instanceable` metadata– commonly, on referenced `component` models in an `assembly` context.

The `inherits` arc and `instanceable` metadata are often used in tandem to because only the entrypoint prim of an `instanceable` reference is editable. Making an edit to an asset’s inherited class will apply the edit to all instanced and non-instanced references to that asset.

class "_asset_classes" {
 class "MyAsset" {
 over "Materials" {
 over "Metal" {
 float inputs:roughness = 0.1
 }
 }
 }
}

def "MyAsset_ref_1" (references = @uri:/project/assets/MyAsset.usd@
 instanceable = True) {
}

def "MyAsset_ref_2" (references = @uri:/project/assets/MyAsset.usd@
 instanceable = False) {
}

def "MyAsset_ref_3" (references = @uri:/project/assets/MyAsset.usd@
 instanceable = True) {
}

Classes can also control whether an asset is instanceable.

class "_asset_classes" {
 class "MyAsset" (instanceable=True) {}
}

`instanceable` can be overridden and disabled on a per-instance basis.

#### Collections and Relationships
As part of the asset prim interface, collections and relationships can be used to advertise membership and roles of certain prims. Consider a workflow built around practical lights. Most assets won’t contain lights, but some will.

def Xform "BuildingInterior" {
 rel userProperties:practical_lights = [
 </Floor1/Lights/Light1>,
 </Floor1/Lights/Light3>,
 </Floor1/Lights/Light5>,
 </Floor2/Lights/Light8>,
 </Floor2/Lights/Light9>
 ]
}

Aggregation workflows can be built around the “forwarding” semantics of relationships and collections.

# Use relationships to advertise that the payload contains practical
# lights.
def Xform "BuildingInterior" {
 rel userProperties:practical_lights = [
 </Floor1/Lights.userProperties:payload_practical_lights>
 ]
}

### Organizing Prim Hierarchy

#### Scene Graph Partitioning
For navigability, it’s common to partition asset structures. Partitioning a hierarchy can avoid unintentional namespace collisions between collaborators and ambiguous semantics. (ie. what does it mean for a Sphere to be parented to a Material?)

def Xform "Asset" {
 def Scope "Geometry" {
 }
 def Scope "Materials" {
 }
}

`Scope` is generally the best prim type for these organizational primitives as they have no additional semantics (like `Xform` does with `xformOps`).

Similarly, it may make sense to group actors and environments under partitioning scopes. In addition to aiding navigability, it’s easy for a user to quickly deactivate all the actors or environments by deactivating the root scope.

def Scope "World" {
 def Scope "environments" { ... }
 def Scope "actors" { ... }
}

#### Naming Conventions
All prim names must be valid `ASCII` (soon to be `UTF-8`) identifiers. A legible prim hierarchy should promote consistency for readability. Common naming conventions include `snake_case`, `UpperCamelCase` (or `PascalCase`), and `lowerCamelCase`.

Just like modules, classes, functions, and variables may have different naming conventions, naming conventions can vary based on prim’s purpose. For example `Material` prims may have a different naming convention than their descendant `Shader` prims to ensure their visibility in paths is more prominent.

A good naming convention should make sure important prims are discoverable in prim paths. For example, in `/NationalPark/pine_trees/LargePineTree_fallen_0007`, the usage of upper camel case can suggest that `NationalPark` is related to a `NationalPark` asset. `LargePineTree_Fallen_0007` suggests a `LargePineTree` asset with some additional context about how it’s integrated into the park.

Developers should mostly avoid keying logic off naming conventions. A `Mesh` should never render differently based on a particular prim or an ancestor’s prim name. However, workflow-based naming conventions may often be the most practical approach when performant discovery is important. The `UsdRender` domain requires settings prims live under the `/Render` scope to promote efficient discoverability for tooling is an example of this principle applied the schema level.

#### Access Semantics
There’s no restrictions on the fields that can be overridden on a prim so it’s important that collaborators establish conventions for stable editing.

Model hierarchy will be discussed in detail later, but setting `kind=subcomponent` can promote the discoverability of prims and suggest that it has the semantics of a nested entrypoint to an asset (ie. transformable and parameterizable).

def Xform "Building" {
 def Scope "Geometry" {
 def Xform "Door" (kind = "subcomponent") { ... }
 def Scope "bricks" { ... }
 def Scope "windows" { ... }
 }
}

Naming conventions can be a helpful way to communicate asset interface prims as well. Consider a gumball machine with a couple of dozen spheres going through a process to randomize color assignment.

def Xform "GumballMachine" {
 def Scope "Geometry" {
 def Scope "gumballs" {
 # Use upper case primitive names to suggest stability and
 # importance.
 def Sphere "Gumball1" {}
 ...
 def Sphere "Gumball100" {}
 }
 }
}

A single `_` prefix can be a good hint that a scope and its descendants are internal to the asset, discouraging users from authoring overrides.

Double underscore `__` prefixes are reserved for internal use by OpenUSD and should generally be avoided.

This convention for internal prims can be complicated when tooling using `TfMakeIdentifier` replaces any invalid characters with `_`. Integration of `UTF-8` identifiers and better identifier constructions aim to address this.

Metadata like `hidden` might be an alternative to relying on naming conventions to signal internal prims, but as a UI hint, it wouldn’t be visible in logs, scripts, or error messages.

Prefixing variant sets or applied schema instances with `_` can also be used to signal that something is internal to a user or department. Occasionally, this is appropriate for properties, but as it complicates schema-ification, it’s less common.

`Sdf` supports a `permission` field with `public` and `private` values. These are currently unused in OpenUSD’s composition mechanism and should not be used.

#### Embedded Context
Assets intended to be included by reference sometimes need context for thumbnail generation, profiling, and other presentation purposes. It may be useful to embed this context in assets directly. the layer below is opened directly, a ground plane and light rig will be available. Render settings for thumbnails could similarly be embedded in the asset interface.

When the below layer is referenced via its `defaultPrim` entrypoint, the `context` layers will not be resolved, opened, or read without any special deactivations or composition arcs even without payloads.

#usda 1.0
(
 defaultPrim = "Asset"
)

def "Asset" { ... }

# If using a mirroring resolver, avoid embedding context through
# `subLayers`
def "context" {
 def "lights" (references = @uri:/project/context/noon_lights.usd@) {}
 def "ground" (references = @uri:/project/context/cement_ground.usd@) {}
}

Be mindful this strategy only works when referencing `Asset`. If the asset was included via sublayers, the context prims will be resolved and opened.

## Structuring a Model Hierarchy
Through composition, OpenUSD can build up complicated hierarchies of scenes. At levels of complexity required for a film production shot or a synthetic data simulation, a single scene graph can become unnavigable for some algorithms and users. Model hierarchy (aka `kind` metadata) provides separate higher level view of the underlying scene graph.

Supporting model hierarchy is optional and there is an additional composition cost to using it. Leverage it only when the complexity of scenes benefit from the additional navigation aid. Small projects in particular won’t reap benefits from this alternate view of the stage and may get caught up trying to properly maintain the rules.

- Model hierarchies are structured around the traversal pruning **component model boundary**

- Assembly and component model kinds indicate **complete** referenceable packages

- Model hierarchies should be **shallow** compared to the full prim hierarchy to amortize additional composition cost

- Model hierarchies should be **consistent** across contexts

- Minimize usage of kind **extensibility** in favor of custom properties or schemas

### Defining the `component` Model Boundary
Model hierarchy is designed to prune traversal at a relatively shallow point in the composed scene graph. This pruning point is the `component` model boundary. *All ancestral prims of ``component`` models (when correctly grouped) are part of the model hierarchy. All descendants are not.*

Component is an overloaded word in many domains. It’s helpful to think of component models as roughly corresponding to consumer facing products. A consumer can purchase a pen. A consumer can purchase a house. Even though they have very different scales and internal complexity, both of these would be logical `component` models in a hierarchy. One complexity of model hierarchy maintenance is that all ancestors of a `component` model must have their `kind` metadata set to `group` or a subkind of `group` (like `assembly`). This requirement is primarily to make sure `component` discovery is efficient for composition.

As `component` model kind is “pruning”, `component` models cannot contain other `component` models as descendants. OpenUSD provides `subcomponent` as an annotation for important prims outside of the model hierarchy to facilitate `kind`-based workflows. `subcomponent` prims can contain other `subcomponent` prims.

Assemblies are important groups that usually correspond to aggregate assets. If a house is a `component` model, then its neighborhood and city could be `assembly` models. In this example, a neighborhood may contain multiple intermediate `group` scopes in between the `assembly` and `component` for organizational purposes (say grouping trees, street lights, and architecture separately). `assembly` models can contain other `assembly` models as well as `component` models.

### Operational
`component` and `assembly` models should be referenceable into other contexts and they shouldn’t be missing important dependencies (like material bindings or skeleton setups) that downstream users are expecting.

Operational is site and pipeline dependent. For example, pipelines may support geometry only-component models that are intended to be shaded in downstream `assembly` models.

### Shallowness
Asset structure should promote shallowness of the model hierarchy. The `kind` metadata is explicitly read during composition for all members of the model hierarchy. This cost is mostly amortized away when the model hierarchy is shallow . A deep model hierarchy adds a small but measurable overhead to composition while also forgoing the performance benefits of pruning traversals. A `Gprim` tagged as a `component` is a sign of that a model hierarchy is “deep”.

### Consistency
As language evolves in an ecosystem about what the expectations are of `component`, `subcomponent`, and `assembly` are, it becomes important that an asset consistently models one of those concepts. For example, it’s common to expect `component` models to be packaged and renderable with their geometry and materials fully specified and partitioned into `Geometry` and `Materials` scopes.

The pattern of referencing `component` models into other `component` models and re-kinding them as `subcomponent` prims can complicate asset navigability as material prims are now nested underneath the `Geometry` scope.

If this is a concern, consider publishing assets with multiple flavors– a fully packaged `component` and individual “parts” to be referenced into other components. Future versions of or siblings to this document hope to include “part” example asset structures.

### Extensibility
The `Kind` library that ships with OpenUSD is extensible via plugin info. This allows users to define their own extensions to `component`, `assembly`, and `subcomponent` kinds. For example, a pipeline might want to distinguish between different levels of assemblies (say “location” vs “world”) or types of subcomponents.

The rules of model hierarchy are strict (and unlike most fields) are core to OpenUSD’s composition engine. Entangling internal taxonomies with model hierarchy may yield unintended complexity. Additionally, without your plugin info containing your extensions, clients may not be able to interpret your kind structure or reconcile it with their own, leading to invalid model hierarchies.

Prefer custom properties, user properties, or schemas for describing your taxonomies and rarely (if ever) surface these to the `Kind` library.

When extending the core kinds, a naming convention, like prefixing `component` extensions with `c_` and `assembly` extensions with `a_` can leave a breadcrumb for users recovering the core kind from an extension. (As an analogy, OpenUSD requires API schemas to be suffixed with `API` so they can disambiguated from typed schemas just by the class name.)

## Naming and Versioning Assets

- Prefer asset naming and versioning conventions that are legible when **embedded** in file paths, resources identifiers, database queries, and prim paths

- Ensure asset names and versions are **unique** and not re-used within the context of a project or site

- Consider whether versions should have special **semantics** like “test” or “staging” to communicate intent

- Medium to large sites and projects should manage **version context** through their asset resolvers.

- Use **branching** and/or **forking** when asset revisions cannot be managed through versioning and variants / parameters

### Embedability
Asset names and versions are frequently embedded in other strings (resource identifiers, prim names, abstract prim classes, script arguments, database queries, etc.). Allowing `/` (for example) in the name of your assets can make it hard for users to inspect a path in content and in logs and quickly discern the asset name. Restricting asset names to a subset of `UTF-8` or `ASCII` identifiers would be a good starting place if you’re setting up new rules.

#### `displayName`
If there’s an expectation that asset names appear in prim paths, you are currently restricted to ASCII identifiers (UTF-8 are expected in a future release). Some tools respect arbitrary UTF-8 encoded `displayName` string metadata on the prim in user interfaces that can be used to work around this.

### Scoped Uniqueness
Uniqueness is important to avoid collisions in queries, reports, and more. Consider at what scope uniqueness is important for your collaborators and clients for tracking.

Uniqueness should be considered across time as well. If an asset name has been retired, consider under what circumstances (if ever) you’ll allow reuse.

### Version Semantics
Most asset versioning semantics are simple sequential integers– `1`, `2`, …, `99`, `100`. A version should not be reused or repaired once published.

Software libraries have introduced semantics with their version numbers. A library’s major, minor, and patch version imply certain types of compatibility. Future documents may explore OpenUSD standardization of versioning semantics to help users more easily track when asset upgrades may break scene graph topologies.

Software libraries sometimes have special versions (“test”, “beta”, “staging”, etc.) that aren’t official releases. Consider if such labels are useful for describing asset versions in your pipeline and how they may be supported.

### Version Context
OpenUSD composes assets into other assets primarily through “referencing”. The version of the referenced asset can be embedded directly in the asset identifier or be specified through external context through the `Ar` asset resolver library.

# version is embedded in asset identifier
references = @MyAsset_v2.usd@

# version derived from Ar-defined context
references = @uri:/project/department/MyAsset.usd@

It’s important to decide whether asset versions are tracked internal to scene description as part of asset identifier or externally to OpenUSD as part of a context. Embedding the version in asset identifier is often the simplest approach. While simple for small projects or layers generated on demand, this generally adds friction and complexity when updating versions and is not recommended for larger projects that require more robust asset tracking and management.

However, versions are managed by an external system often require a custom asset resolver plugin that interfaces with that external system. Asset resolvers are only implementable in C++. There are ongoing efforts and white papers regarding standard asset identifier structure and resolving.

### Introspection
`assetInfo` exists as metadata in OpenUSD as a way for assets to advertise their name and other information to their consuming contexts in a consistent way. When references are fully or partially flattened, it provides a breadcrumb as to what asset was referenced.

assetInfo = {
 string name = "MyAsset"
}

While `assetInfo` *can* be useful for introspection, it’s a field that’s override-able like any other field. It’s worth noting that `assetInfo` existed before prim composition queries existed in the OpenUSD API. Some usage patterns that necessitated the introduction of `assetInfo` (like getting referenced `identifier`) may be handled with this new API.

#### Payload Asset Dependencies
USD also uses `assetInfo` to encapsulate payload asset dependencies. A model with a payload can list layers and other assets that are required to allow dependency analysis to complete without loading an asset’s payloads. Note that in the general case, maintenance of this field is complicated. The field cannot be accurate when external dependencies can update their dependency list without recursive interrogation of the external dependencies.

### Branches and Forks
The name / version paradigm as currently described suggests that assets are in state of continual sequential improvement. However, there are situations where, the needs of an asset may “branch”. On a film production, smaller refinements may be required for sequences in production while a non-backwards compatible restructure is required for new sequences. There may be cases where it makes sense to have “branches” of assets for these parallel workstreams. Localization of content might be another motivator for maintaining branches of assets.

An alternative to supporting branching in a versioning system is to “fork” the originating asset into a new named asset. `MyMainCharacter` could get “forked” into `MyMainCharacter_ThirdAct` to accommodate the breaking restructure. In a “fork”, the workstreams share a common history but are now versioned and managed independently.

Both branches and forks both add complexity in different ways. Asset development can anticipate some change and leave room for future refinements with variant sets and other structural choices to avoid the need to branch or fork. However, planning for every eventuality often adds complexity through bloat. A thoughtful branching and/or forking policy can provide a release valve when maintaining a single asset workstream is no longer viable.

## Dependency Encapsulation

- To reference an external dependency, prefer a **resource identifier resolver** (URI / IRI)

- To make an asset relocatable, express direct dependencies through **anchoring** paths

- Assets with simple public interfaces can accept new versions in a **push** pipeline

- Assets with more complex topology-specific edits should prefer an explicit **pull** pipelines

An asset structures not just layer, prim, and model hierarchy but also dependent `asset` valued fields like textures.

### Resource Identifiers
For medium to large-scale projects and sites, it’s recommended that the underlying storage be abstracted away with a resource identifier based asset resolver. Common components of a resource identifier include the project, department, asset name, and resource type.

site-resolver:/project/dept/asset/type/resource.ext

A simple resolver implementation will apply a simple remapping of the resource identifier to local or network storage, but opens the door to additional features and integration with cloud storage.

Resource identifiers are dispatched by their scheme field (what’s before the `:`) as specified by the URI or IRI field.

Resource identifier resolvers can complicate relocating assets across sites; standardizing resolver and identifier semantics across sites may be a useful area for exploration for the OpenUSD community.

Smaller sites and projects may choose to leverage file system paths or the search paths provided by OpenUSD’s default resolver.

### Anchored Assets
As mentioned earlier, there are complications with relocating assets under search path, resource identifier, and file system based schemes. Each require the partner site to have similar environments.

Assets identifiers defined with `./` or `../` trigger “anchoring” behavior in an OpenUSD resolver. An asset prefixed with `./` will be joined with the containing layer’s directory. (`../` can be used to access the containing directory’s parent).

Consider `./textures/albedo.exr` authored as a material property in `site-resolver:/project/dept/asset/material/material.usd`. OpenUSD’s asset resolver will interpret `./textures/albedo.exr` as `site-resolver:/project/dept/asset/material/textures/albedo.exr`. The layer is dropped and anchored path is joined.

Anchoring dependencies internal to an asset version improves relocatability and avoid baking version specific context into an asset that can defeat storage deduplication and complicate differencing.

#### Packaging
Packaging assets into `usdz` files can achieve similar results to anchoring once development is complete. There is a potential storage cost if tweaks to one dependency triggers a repackaging during active development, but can be a great way to handle final content delivery.

### Pushing and Pulling Updates
When an asset maintains a simple public interface, it becomes easy to push out updates to clients and collaborators. In considering the color variant, while the specific hue of red or how the selection affects the underlying prim hierarchy may change over time, the variant set name and selection are stable.

Some assets like actors with time sampled poses in shots are better managed through explicit pulling to ensure that the poses can be updated and synchronized.

Even assets with simple public interfaces may transition over time to explicit pulls. For example, a complex rigid body simulation may need to apply detailed edits that break the simple asset interface, and asset updates need to be synchronized with a resimulation.

## Summary of Performance Tradeoffs
There’s a variety of features at one’s disposal when organizing the layers of an asset. The optimal choices are often determined by a combination of the cost of **resolving a layer**, the cost of **opening the file format**, and the cost of **applying the composition operator**.

As discussed in the [Sublayers and Mirroring Resolvers](#sublayers-and-mirroring-resolvers) section, when Crate files are used, most heavy I/O operations are deferred, reducing the overall weight of any particular operator to reading a brief layer “table of contents”. However, a mirroring asset resolver requiring an entire file to be synchronized during a resolve complicating this optimization.

Underlying storage systems may have the ability to deduplicate identical content. Keeping workstreams in separate layers can help control storage and network traffic.

Making known to be lightweight layers use the text file format (USDA) can aid legibility and compatibility with common text-based differencing, editing, and searching tool. The contents of text layers are always read fully into memory when opened, but are unlikely to cause performance issues for lightweight interface layers. However, it’s best to use the `.usd` extension for production data since it allows revisions to move between the text (USDA) and binary (USDC) file formats if a layer’s complexity evolves.

Layers are often considered the cheapest composition operator but will always be resolved, opened, and composed as part of a root layer stack. References and payloads have the additional cost of re-pathing prims, relationship targets, and connections. References and payloads can be deactivated or masked to avoid the cost of composing their subgraphs. When an ancestor is deactivated, the references and payloads of descendants will additionally not be resolved or opened. It’s worth noting a deactivated prim will still compose its references, necessitating resolving and opening asset interface layers, while a deactivated payload will not. The reference-payload pattern discussed earlier can be used to keep inactive as well as unloaded prims lightweight. Commonly referenced prims that don’t require subgraph sparse overrides can be made `instanceable` to keep the scene graph light.

A good starting point for a new asset structure would be to make a `reference`-able text interface layer containing a `payload` containing binary `subLayers`, letting site specific needs drive variations of that structure. Sites may elide payloads from their `assembly` asset structures since they often complicate navigability and discovery, leading to users and tools loading all payloads to find what they’re looking for. Other sites with mirroring resolvers may find wins when putting more content behind payloads. Some content can be efficiently described with a simple single stack of `subLayers`. More advanced interface layers may find creative uses of `inherits` and `variantSets` to manage the set of resolved, opened, and composed layers.

## Annotated Asset Structures
### Atomic Model Structure: `FlowerPot`
Atomic models are entirely self contained and have no external dependencies. Atomic models are usually `component` models in the model hierarchy. There may be use cases for atomic `assembly` models, but it’s rare.

#### `FlowerPot.usd`
#usda 1.0
(
 # Set the default prim
 defaultPrim = "FlowerPot"

 # Set the asset's spatial metrics
 metersPerUnit = 1.0
 upAxis = "Y"
)

# Provide a class for downstream instance-compatible asset level edits
class "asset_classes" {
 class "FlowerPot" {}
}

def "FlowerPot" (
 # Apply `GeomModelAPI` to specify `extentsHint`
 apiSchemas = ["GeomModelAPI"]

 # Annotate FlowerPot is a component model
 kind = "component"

 # Advertise the name of the asset through the assetInfo dictionary
 # (but not the identifier or version string)
 assetInfo = {
 string name = "FlowerPot"
 }

 # Set the payload contents using an anchored path to promote asset
 # relocatability
 payloads = @./payload/contents.usd@

 # This asset provides an age_variant as part of its interface
 prepend variantSets = ["age_variant"]

 variants = {
 # Provide the lofted default variant selection
 string age_variant = "blooming"
 }

 inherits = </asset_classes/FlowerPot>
) {
 # This component model structure encapsulates all its
 # dependencies within a version and can reliably publish
 # the model's extentsHint.
 float3[] extentsHint = [(-10.0, -10.0, 0.0), (10.0, 10.0, 5.0)]

 # Expose petal color as part of the asset's public interface.
 # Prefix with `asset` to avoid collision with any primvars specified
 # on the gprim.
 color3f[] primvars:asset_petal_color = [(0.6, 0.6, 0.2)] (
 interpolation = "constant"
 )
 # Defensively block indices
 color3f[] primvars:asset_petal_color:indices = None
}

#### `./payload/contents.usd`
#usda 1.0
(
 # Respecify the `defaultPrim` and units
 defaultPrim = "FlowerPot"
 metersPerUnit = 1.0
 upAxis = "Y"

 # Specify the contents of the payload. This intermediate contents
 # layer preserves the ability to mute the `materials` and `geometry`
 # layers. Targets of references and payloads are considered root
 # layers and if muted, trigger a composition error.
 # This contents layer can be elided in favor of explicitly setting
 # payloads = [@./payload/geometry.usd@, @./payload/geometry.usd@]
 # on the main interface layer.
 subLayers = [
 @./materials.usd@,
 @./geometry.usd@
 ]
)

#### `./payload/geometry.usd`
#usda 1.0
(
 # Respecify the `defaultPrim` and units for clarity
 defaultPrim = "FlowerPot"
 metersPerUnit = 1.0
 upAxis = "Y"
)

def Xform "FlowerPot" (
 # Specify the variant sets this layer has opinions about
 prepend variantSets = ["age_variant"]
 variants = {
 string age_variant = "blooming"
 }
) {
 variantSet "age_variant" {
 "blooming" {
 over "Geometry" {
 over "petals" {
 # Deactivate the wilted geometry in the blooming
 # variant
 over "_wilted_proxy" (active = false) {}
 over "_wilted_render" (active = false) {}
 }
 }
 }
 "wilted" {
 over Scope "Geometry" {
 over Scope "petals" {
 # Deactivate the blooming geometry in the wilted
 # variant
 over Scope "_blooming_proxy" (active = false) {}
 over Scope "_blooming_render" (active = false) {}
 }
 }
 }
 }

 # The default hierarchy. Be mindful that these are opinions are
 # considered local and are stronger than opinions in the variants.
 # Since the variant fields are disjoint, this isn't an issue, but
 # sometimes an internal reference is used to specify opinions
 # weaker than the variant set opinions.
 def Scope "Geometry" {
 def Mesh "planter" { ... }
 def Mesh "stem" { ... }
 def Scope "petals" {
 # Use `_` to signify that a scope is internal to the asset.
 # The motivation for making this prim internal is that since
 # it is a proxy, any edits would not apply to its
 # corresponding render scopes (and vice versa)
 def Scope "_wilted_proxy" {
 token purpose = "proxy"
 ...
 }
 def Scope "_wilted_render" {
 token purpose = "render"
 ...
 }
 def Scope "_default_proxy" {
 token purpose = "proxy"
 ...
 }
 def Scope "_default_render" {
 token purpose = "render"
 ...
 }
 }
 }
}

### Package Model Structure: `ApartmentBuilding_pkg`
Sometimes it’s useful for otherwise simple assets to reference other assets. These are sometimes modeled by referencing `component` models into other `component` models and overriding their `kind` to `subcomponent` to avoid violating model hierarchy rules. However, this complicates discovery of materials and other workflows built around `component` models which may be nested deep with a geometry hierarchy. This document presents the package pattern as an alternative which preserves the `component`-ness. Packages may be considered “light” `assembly` models.

#### `ApartmentBuilding.usd`
#usda 1.0
(
 defaultPrim = "ApartmentBuilding_pkg"
 metersPerUnit = 1.0
 upAxis = "Y"
)

# Provide a class for downstream instance-compatible asset level edits
class "asset_classes" {
 class "ApartmentBuilding_pkg" {}
 class "ApartmentBuilding" {}
}

# The package scope may have a more complicated interface with
# variants. Packages and other assemblies may use payloads as well.
# However, some tooling (and some of the OpenUSD APIs) are designed around
# a presumption of a single level of payloads in a prim hierarchy so
# we elide it in favor of a structure where payloads only exist
# at the component level
def Xform "ApartmentBuilding_pkg" (
 kind = "assembly"
 assetInfo = {
 string name = "ApartmentBuilding_pkg"
 }
 # The package scope doesn't add `extentsHint` or the `GeomModelAPI`
 # because its adornments are external references whose size and
 # appearance may vary outside of the versioning cadence of the
 # package.
) {
 # The ApartmentBuilding scope has a similar interface to the
 # FlowerPot prim, setting the component kind, a payload.
 # It may have its own variants and asset primvars as well.
 def Scope "ApartmentBuilding" (
 kind = "component"
 payloads = @./payload/contents.usd@
 prepend apiSchemas = ["GeomModelAPI"]
 )

 float3[] extentsHint = [(-10.0, 0.0, -5.0), (10.0, 12.0, 5.0)]

 # Adornments could exist on their own layer or as another entrypoint
 # to the contents layer. Adornments `component`-ness are preserved
 def Scope "adornments" (kind = "group") {
 def Scope "porch" (kind = "group") {
 def Xform "FlowerPot" (
 references = @uri:/project/props/FlowerPot/FlowerPot.usd@
 # Marking the FlowerPot as instanceable will share the
 # definition with others
 instanceable = True
 ) {
 token[] xformOpOrder = ["xformOps:translate", "xformOps:rotateXYZ"]
 double3 xformOps:translate = (10, 5, 2)
 float3 xformOps:rotateXYZ = (20, 15, 30)
 }
 }
 }
}

### Selector Model Structure: `StreetLamp_sel`
Sometimes, when constructing a virtual world, the asset library is incomplete, but production must begin. “Selector models” let you slot in a concept and refine or randomize specific asset selection downstream. The asset interface layer can be updated as additional library contents come online.

Maintaining a consistent asset prim interface from version to version can be challenging for a single asset, let alone multiple assets. The street lamp selector example below places each asset into distinct prims, overriding the root to be `Scope` so that transforms are handled exclusively by the selector prim, and letting each `component` model have their own prim hierarchy for edits. Other properties and variant sets could be similarly “lofted” from the selection to the selector. If the asset prim interfaces are consistent for all models in a selector, the intermediate scope can be reasonably elided.

#### `StreetLamp_sel.usd`
#usda 1.0
(
 defaultPrim = "StreetLamp_sel"
 metersPerUnit = 1.0
 upAxis = "Y"
)

def Xform "StreetLamp_sel" (
 variantSets = ["model_selection"]
 variants = {
 string model_selection = "StreetLampStandard"
 }
 # This selector model is an assembly, as each descendant
 # are component models. A selector model may be reasonably
 # published as a `group`.
 kind = "assembly"
 assetInfo = {
 string name = "StreetLamp"
 }
){
 variantSet "model_selection" = {
 variant "StreetLampStandard" {
 # Give each asset their own scope if the asset prim interfaces
 # do not match.
 def Scope "StreetLampStandard" (
 references = @uri:/project/assets/StreetLampStandard.usd@
 ) {
 }
 }
 variant "StreetLampVintage" {
 def Scope "StreetLampVintage" (
 references = @uri:/project/assets/StreetLampVintage.usd@
 ) {
 }
 }
 variant "StreetLampModern" {
 def Scope "StreetLampModern" (
 references = @uri:/project/assets/StreetLampModern.usd@
 ) {
 }
 }
 variant "StreetLampPostModern" {
 def Scope "StreetLampPostModern" (
 references = @uri:/project/assets/StreetLampPostModern.usd@
 ) {
 }
 }
 }
}

### Aggregate Model Structure: `Neighborhood`
Aggregate models are “pure” assemblies. They rarely have their own geometry and material definitions and contain references and public interface overrides.

#### `Neighborhood.usd`
#usda 1.0
(
 defaultPrim = "Neighborhood"
 metersPerUnit = 1.0
 upAxis = "Y"
)

# The simplest entrypoint for a model consists of just its `kind`
# and its name. An aggregate model can be just a single layer or
# separate out the interface and contents into multiple layers.
# Payloads may be used to defer loading of asset contents but
# but may complicate descendant discovery.
def Xform "Neighborhood" (
 kind = "assembly"
 assetInfo = {
 string name = "Neighborhood"
 }
) {
 # Ancestors of component models must be tagged as groups (or assemblies)
 def Scope "buildings" (kind = "group") {
 def "ApartmentBuilding_pkg_1" (
 references=@uri:/project/buildings/ApartmentBuilding.usd@
 ) {
 token[] xformOpOrder = ["xformOps:translate", "xformOps:rotateXYZ"]
 double3 xformOps:translate = (10, 5, 7)
 double3 xformOps:rotateXYZ = (20, 10, 30)

 # Override default FlowerPot position.
 over "adornments" {
 over "porch" {
 over "FlowerPot" {
 token[] xformOpOrder = ["xformOps:translate", "xformOps:rotateXYZ"]
 double3 xformOps:translate = (5, 5, 7)
 float3 xformOps:rotateXYZ = (20, 10, 30)
 }
 }
 }
 }
 }

 def Scope "street_lamps" (kind = "group") {
 def "StreetLamp_1" (
 references=@uri:/project/props/StreetLamp.usd@
 instanceable = True
 ) {
 token[] xformOpOrder = ["xformOps:translate", "xformOps:rotateXYZ"]
 double3 xformOps:translate = (10, 5, 7)
 float3 xformOps:rotateXYZ = (20, 10, 30)
 }
 }
}

## Principles Quick Reference
A scalable asset structure promotes the scalability needs of an organization by being **legible**, **modular**, **performant**, and **navigable**.

### Legibility
*A legible asset structure should be easy to inspect and onboard new users familiar with a domain.*

- Choose naming conventions (like `ASCII` or `UTF-8` identifiers) that embed well in database queries, file paths, resource identifiers, and command line arguments

- Avoid overuse of composition arcs and features that produce conceptual bloat and make it hard for users to reason about

- Use naming conventions to communicate importance and intent to downstream users (capitalized prim names are “public”, underscored prim names are “internal”)

### Modularity
*A modular structure promotes iterative improvement and reuse of assets.*

- Model parallel workstreams with layer stacks to allow collaboration

- Use well defined entrypoints to provide stable interfaces

- Encapsulate local dependencies with anchored paths

- Consider localizing library and part instances within a version and leveraging the linking / aliasing / deduplication features of your storage and asset resolver to make assets atomic

### Performance
*Use the needs of your clients and collaborators to define measurable performance metrics.*

- The performance of reading an asset is driven by the cost of *resolving*, *opening*, and *composing* the set of used layers by a stage

- Use the reference/payload pairs to provide boundaries between an asset’s lightweight entrypoint interface and the more complicated prim hierarchies and properties

- While crate (`.usdc`) files are generally I/O efficient across network and file systems, a mirroring asset resolver that localizes a layer before reading can thwart its optimizations. Use variants, references, and payloads to avoid synchronization

- Avoid adding timestamps, UUIDs, and versions to layers that might complicate storage deduplication

- Use instancing to keep composed prim count manageable for clients (ie. avoid millions of prims)

### Navigability
*Hierarchy structures should promote discoverability of the individual elements while retaining flexibility.*

- Structure prim hierarchies, resource identifiers, model hierarchies, and file path that promote discoverability

- Use relationships and collections to promote discoverability without naming conventions

- Keep model hierarchy component model boundaries shallow and consistent

## Terms and Concepts
To view definitions of terms and concepts discussed in this document, please visit our OpenUSD Terms & Concepts page.
