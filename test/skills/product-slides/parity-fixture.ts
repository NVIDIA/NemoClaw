// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

type ManagedRole = "roadmap-executive" | "roadmap-capability" | "markitecture" | "weekly-release";

type BackendSlideFixture = {
  role: ManagedRole;
  instanceId?: string;
  nativeObjectKinds: string[];
  hyperlinkInventory: Array<{ text: string; url: string }>;
  connectorInventory: Array<{
    contentId: string;
    from: string;
    to: string;
    direction: string;
    lineStyle: string;
  }>;
  managedVisibleTextInventory: string[];
  inheritedVisibleTextInventory: string[];
  capabilityStructureInventory?: Record<string, unknown>;
  weeklyMilestoneStructureInventory?: Record<string, unknown>;
};

// These inventories are literal readbacks, not projections from the parity
// implementation. Keep the Google Slides and PowerPoint representations
// separate so either adapter can drift without moving the test oracle.
const GOOGLE_SLIDES_FIXTURE: BackendSlideFixture[] = [
  {
    role: "roadmap-executive",
    instanceId: "roadmap-executive.1",
    nativeObjectKinds: ["group", "line", "shape", "text"],
    hyperlinkInventory: [],
    connectorInventory: [],
    managedVisibleTextInventory: [
      "6 native GitHub Epics shown across 3 eligible milestone delivery windows.",
      "Community blueprints: Publish reviewed integration patterns for contribution and reuse.",
      "Feedback optimization: Turn operator feedback into measurable agent improvements.",
      "Guided onboarding: Start agents in OpenShell sandboxes with fewer manual steps.",
      "Native Runtimes and Feedback Optimization",
      "NemoClaw Feature Roadmap",
      "Onboarding and Voice Experiences",
      "Routing and Contribution Patterns",
      "Voice interaction: Use speech as a first-class interaction path.",
      "Window One",
      "Window Three",
      "Window Two",
      "Windows host path: Move OpenShell sandbox workflows to another host environment.",
      "✓ Agent routing: Route work to the selected model path.",
    ],
    inheritedVisibleTextInventory: ["‹#›", "‹#›"],
  },
  {
    role: "roadmap-capability",
    instanceId: "roadmap-capability.1",
    nativeObjectKinds: ["shape", "table", "text"],
    hyperlinkInventory: [
      { text: "#101", url: "https://github.com/NVIDIA/NemoClaw/issues/101" },
      { text: "#102", url: "https://github.com/NVIDIA/NemoClaw/issues/102" },
      { text: "#103", url: "https://github.com/NVIDIA/NemoClaw/issues/103" },
      { text: "#104", url: "https://github.com/NVIDIA/NemoClaw/issues/104" },
      { text: "#105", url: "https://github.com/NVIDIA/NemoClaw/issues/105" },
      { text: "#106", url: "https://github.com/NVIDIA/NemoClaw/issues/106" },
    ],
    connectorInventory: [],
    managedVisibleTextInventory: [
      "Acceleration and Optimization",
      "Agent Features",
      "Community blueprints (#104)",
      "Feedback optimization (#106)",
      "Guided onboarding (#101)",
      "Integrations and Blueprints",
      "NemoClaw Feature Roadmap",
      "Usability and Onboarding",
      "Voice interaction (#102)",
      "Window One",
      "Window Three",
      "Window Two",
      "Windows host path (#105)",
      "✓ Agent routing (#103)",
    ],
    inheritedVisibleTextInventory: ["‹#›"],
    capabilityStructureInventory: {
      table: {
        rowCount: 5,
        columnCount: 4,
        topRowText: ["", "", "", ""],
        dividers: {
          segmentCount: 49,
          color: "#FFFFFF",
          lineStyle: "solid",
          widthEmu: 228_600,
        },
      },
      milestoneTargets: [
        {
          tableColumnIndex: 1,
          text: "Window Three",
          shapeType: "HOME_PLATE",
          inTopRowCell: true,
        },
        {
          tableColumnIndex: 2,
          text: "Window One",
          shapeType: "HOME_PLATE",
          inTopRowCell: true,
        },
        {
          tableColumnIndex: 3,
          text: "Window Two",
          shapeType: "HOME_PLATE",
          inTopRowCell: true,
        },
      ],
      unusedTopRowMilestoneTargetCount: 0,
      unusedBodyCellNonemptyCount: 0,
      bottomMilestoneTargetCount: 0,
    },
  },
  {
    role: "markitecture",
    nativeObjectKinds: ["connector", "shape", "text"],
    hyperlinkInventory: [],
    connectorInventory: [
      {
        contentId: "connector.gateway-inference",
        from: "node.gateway",
        to: "node.inference",
        direction: "from-to",
        lineStyle: "solid",
      },
      {
        contentId: "connector.gateway-integrations",
        from: "node.gateway",
        to: "node.integrations",
        direction: "from-to",
        lineStyle: "solid",
      },
      {
        contentId: "connector.gateway-sandbox",
        from: "node.gateway",
        to: "node.sandbox",
        direction: "from-to",
        lineStyle: "solid",
      },
      {
        contentId: "connector.host-gateway",
        from: "node.host",
        to: "node.gateway",
        direction: "from-to",
        lineStyle: "solid",
      },
      {
        contentId: "connector.operator-host",
        from: "node.operator",
        to: "node.host",
        direction: "from-to",
        lineStyle: "solid",
      },
      {
        contentId: "connector.sandbox-gateway",
        from: "node.sandbox",
        to: "node.gateway",
        direction: "from-to",
        lineStyle: "solid",
      },
      {
        contentId: "connector.sandbox-state",
        from: "node.sandbox",
        to: "node.state",
        direction: "from-to",
        lineStyle: "dashed",
      },
    ],
    managedVisibleTextInventory: [
      "Agent runtime + NemoClaw integration",
      "Approved integrations",
      "Managed inference",
      "Managed state and artifacts",
      "NemoClaw host CLI and versioned blueprint",
      "NemoClaw system flow",
      "OpenShell gateway",
      "OpenShell sandbox",
      "Users and operators",
      "approved egress",
      "configure resources",
      "create and control",
      "managed requests",
      "operate",
      "preserve for rebuild, snapshot, restore",
      "routed inference",
    ],
    inheritedVisibleTextInventory: ["‹#›"],
  },
  {
    role: "weekly-release",
    nativeObjectKinds: ["shape", "text"],
    hyperlinkInventory: [],
    connectorInventory: [],
    managedVisibleTextInventory: [
      "3 OPENED  |  5 CLOSED",
      "Agent routing: Routing validation is in progress.",
      "Community blueprints: Blueprint contribution review is complete.",
      "Dependency: Dependency validation remains open.",
      "Feedback optimization: Feedback measurement work is planned.",
      "Guided onboarding: Guided setup validation is complete.",
      "LATEST RELEASE",
      "NemoClaw Weekly Executive Scorecard | Aug 6–13, 2026",
      "None",
      "ONE",
      "Qualification: Device qualification remains open.",
      "REPO MOMENTUM  |  TOTAL (+WOW)",
      "RISKS / BLOCKERS",
      "Stars 1,200 (+24)  |  Forks 210 (+8)  |  Merged PRs 680 (+31)",
      "THREE",
      "TWO",
      "UPDATES",
      "VDR / UAT ISSUES  |  LAST 7 DAYS",
      "Voice interaction: Voice workflow validation is in progress.",
      "WINDOW",
      "WINDOW",
      "WINDOW",
      "Windows host path: Host workflow validation is planned.",
      "v1.2.3",
    ],
    inheritedVisibleTextInventory: ["‹#›"],
    weeklyMilestoneStructureInventory: {
      rows: [
        {
          rowIndex: 0,
          title: "WINDOW\nTHREE",
          labelFillColor: "#76B900",
          labelTextColor: "#FFFFFF",
          labelIsLeftOfContent: true,
          updates: [
            {
              text: "Guided onboarding: Guided setup validation is complete.",
              bulletCharacter: "•",
            },
            {
              text: "Voice interaction: Voice workflow validation is in progress.",
              bulletCharacter: "•",
            },
          ],
          risks: [
            {
              text: "Qualification: Device qualification remains open.",
              bulletCharacter: "•",
            },
          ],
        },
        {
          rowIndex: 1,
          title: "WINDOW\nONE",
          labelFillColor: "#76B900",
          labelTextColor: "#FFFFFF",
          labelIsLeftOfContent: true,
          updates: [
            {
              text: "Agent routing: Routing validation is in progress.",
              bulletCharacter: "•",
            },
            {
              text: "Community blueprints: Blueprint contribution review is complete.",
              bulletCharacter: "•",
            },
          ],
          risks: [{ text: "None", bulletCharacter: "•" }],
        },
        {
          rowIndex: 2,
          title: "WINDOW\nTWO",
          labelFillColor: "#76B900",
          labelTextColor: "#FFFFFF",
          labelIsLeftOfContent: true,
          updates: [
            {
              text: "Windows host path: Host workflow validation is planned.",
              bulletCharacter: "•",
            },
            {
              text: "Feedback optimization: Feedback measurement work is planned.",
              bulletCharacter: "•",
            },
          ],
          risks: [
            {
              text: "Dependency: Dependency validation remains open.",
              bulletCharacter: "•",
            },
          ],
        },
      ],
    },
  },
];

const POWERPOINT_FIXTURE: BackendSlideFixture[] = [
  {
    role: "roadmap-executive",
    instanceId: "roadmap-executive.1",
    nativeObjectKinds: ["connector", "shape", "text"],
    hyperlinkInventory: [],
    connectorInventory: [],
    managedVisibleTextInventory: [
      "✓ Agent routing: Route work to the selected model path.",
      "Windows host path: Move OpenShell sandbox workflows to another host environment.",
      "Window Two",
      "Window Three",
      "Window One",
      "Voice interaction: Use speech as a first-class interaction path.",
      "Routing and Contribution Patterns",
      "Onboarding and Voice Experiences",
      "NemoClaw Feature Roadmap",
      "Native Runtimes and Feedback Optimization",
      "Guided onboarding: Start agents in OpenShell sandboxes with fewer manual steps.",
      "Feedback optimization: Turn operator feedback into measurable agent improvements.",
      "Community blueprints: Publish reviewed integration patterns for contribution and reuse.",
      "6 native GitHub Epics shown across 3 eligible milestone delivery windows.",
    ],
    inheritedVisibleTextInventory: ["‹#›", "‹#›"],
  },
  {
    role: "roadmap-capability",
    instanceId: "roadmap-capability.1",
    nativeObjectKinds: ["table", "text", "shape"],
    hyperlinkInventory: [
      { text: "#106\r\n", url: "https://github.com/NVIDIA/NemoClaw/issues/106" },
      { text: "#105\r\n", url: "https://github.com/NVIDIA/NemoClaw/issues/105" },
      { text: "#104\r\n", url: "https://github.com/NVIDIA/NemoClaw/issues/104" },
      { text: "#103\r\n", url: "https://github.com/NVIDIA/NemoClaw/issues/103" },
      { text: "#102\r\n", url: "https://github.com/NVIDIA/NemoClaw/issues/102" },
      { text: "#101\r\n", url: "https://github.com/NVIDIA/NemoClaw/issues/101" },
    ],
    connectorInventory: [],
    managedVisibleTextInventory: [
      "✓ Agent routing (#103)",
      "Windows host path (#105)",
      "Window Two",
      "Window Three",
      "Window One",
      "Voice interaction (#102)",
      "Usability and Onboarding",
      "NemoClaw Feature Roadmap",
      "Integrations and Blueprints",
      "Guided onboarding (#101)",
      "Feedback optimization (#106)",
      "Community blueprints (#104)",
      "Agent Features",
      "Acceleration and Optimization",
    ],
    inheritedVisibleTextInventory: ["‹#›"],
    capabilityStructureInventory: {
      table: {
        rowCount: 5,
        columnCount: 4,
        topRowText: ["", "", "", ""],
        dividers: {
          segmentCount: 49,
          color: "ffffff",
          lineStyle: "SOLID",
          widthEmu: 228_600,
        },
      },
      milestoneTargets: [
        {
          tableColumnIndex: 1,
          text: "Window Three",
          shapeType: "homePlate",
          inTopRowCell: true,
        },
        {
          tableColumnIndex: 2,
          text: "Window One",
          shapeType: "homePlate",
          inTopRowCell: true,
        },
        {
          tableColumnIndex: 3,
          text: "Window Two",
          shapeType: "homePlate",
          inTopRowCell: true,
        },
      ],
      unusedTopRowMilestoneTargetCount: 0,
      unusedBodyCellNonemptyCount: 0,
      bottomMilestoneTargetCount: 0,
    },
  },
  {
    role: "markitecture",
    nativeObjectKinds: ["line", "shape", "text"],
    hyperlinkInventory: [],
    connectorInventory: [
      {
        contentId: "connector.sandbox-state",
        from: "node.sandbox",
        to: "node.state",
        direction: "from-to",
        lineStyle: "dashed",
      },
      {
        contentId: "connector.sandbox-gateway",
        from: "node.sandbox",
        to: "node.gateway",
        direction: "from-to",
        lineStyle: "solid",
      },
      {
        contentId: "connector.operator-host",
        from: "node.operator",
        to: "node.host",
        direction: "from-to",
        lineStyle: "solid",
      },
      {
        contentId: "connector.host-gateway",
        from: "node.host",
        to: "node.gateway",
        direction: "from-to",
        lineStyle: "solid",
      },
      {
        contentId: "connector.gateway-sandbox",
        from: "node.gateway",
        to: "node.sandbox",
        direction: "from-to",
        lineStyle: "solid",
      },
      {
        contentId: "connector.gateway-integrations",
        from: "node.gateway",
        to: "node.integrations",
        direction: "from-to",
        lineStyle: "solid",
      },
      {
        contentId: "connector.gateway-inference",
        from: "node.gateway",
        to: "node.inference",
        direction: "from-to",
        lineStyle: "solid",
      },
    ],
    managedVisibleTextInventory: [
      "routed inference",
      "preserve for rebuild, snapshot, restore",
      "operate",
      "managed requests",
      "create and control",
      "configure resources",
      "approved egress",
      "Users and operators",
      "OpenShell sandbox",
      "OpenShell gateway",
      "NemoClaw system flow",
      "NemoClaw host CLI and versioned blueprint",
      "Managed state and artifacts",
      "Managed inference",
      "Approved integrations",
      "Agent runtime + NemoClaw integration",
    ],
    inheritedVisibleTextInventory: ["‹#›"],
  },
  {
    role: "weekly-release",
    nativeObjectKinds: ["text", "shape"],
    hyperlinkInventory: [],
    connectorInventory: [],
    managedVisibleTextInventory: [
      "v1.2.3",
      "Windows host path: Host workflow validation is planned.",
      "WINDOW",
      "WINDOW",
      "WINDOW",
      "Voice interaction: Voice workflow validation is in progress.",
      "VDR / UAT ISSUES  |  LAST 7 DAYS",
      "UPDATES",
      "TWO",
      "THREE",
      "Stars 1,200 (+24)  |  Forks 210 (+8)  |  Merged PRs 680 (+31)",
      "RISKS / BLOCKERS",
      "REPO MOMENTUM  |  TOTAL (+WOW)",
      "Qualification: Device qualification remains open.",
      "ONE",
      "None",
      "NemoClaw Weekly Executive Scorecard | Aug 6–13, 2026",
      "LATEST RELEASE",
      "Guided onboarding: Guided setup validation is complete.",
      "Feedback optimization: Feedback measurement work is planned.",
      "Dependency: Dependency validation remains open.",
      "Community blueprints: Blueprint contribution review is complete.",
      "Agent routing: Routing validation is in progress.",
      "3 OPENED  |  5 CLOSED",
    ],
    inheritedVisibleTextInventory: ["‹#›"],
    weeklyMilestoneStructureInventory: {
      rows: [
        {
          rowIndex: 0,
          title: "WINDOW\r\nTHREE",
          labelFillColor: "76b900",
          labelTextColor: "ffffff",
          labelIsLeftOfContent: true,
          updates: [
            {
              text: "Guided onboarding: Guided setup validation is complete.",
              bulletCharacter: "•",
            },
            {
              text: "Voice interaction: Voice workflow validation is in progress.",
              bulletCharacter: "•",
            },
          ],
          risks: [
            {
              text: "Qualification: Device qualification remains open.",
              bulletCharacter: "•",
            },
          ],
        },
        {
          rowIndex: 1,
          title: "WINDOW\r\nONE",
          labelFillColor: "76b900",
          labelTextColor: "ffffff",
          labelIsLeftOfContent: true,
          updates: [
            {
              text: "Agent routing: Routing validation is in progress.",
              bulletCharacter: "•",
            },
            {
              text: "Community blueprints: Blueprint contribution review is complete.",
              bulletCharacter: "•",
            },
          ],
          risks: [{ text: "None", bulletCharacter: "•" }],
        },
        {
          rowIndex: 2,
          title: "WINDOW\r\nTWO",
          labelFillColor: "76b900",
          labelTextColor: "ffffff",
          labelIsLeftOfContent: true,
          updates: [
            {
              text: "Windows host path: Host workflow validation is planned.",
              bulletCharacter: "•",
            },
            {
              text: "Feedback optimization: Feedback measurement work is planned.",
              bulletCharacter: "•",
            },
          ],
          risks: [
            {
              text: "Dependency: Dependency validation remains open.",
              bulletCharacter: "•",
            },
          ],
        },
      ],
    },
  },
];

function slideIdentity(slide: { role: ManagedRole; instanceId?: unknown }): string {
  return typeof slide.instanceId === "string" && slide.instanceId.length > 0
    ? slide.instanceId
    : slide.role;
}

function readbackFromFixture(
  model: Record<string, unknown>,
  fixture: BackendSlideFixture[],
): Record<string, unknown> {
  const modelSlides = model.slides as Array<Record<string, unknown> & { role: ManagedRole }>;
  const modelByIdentity = new Map(modelSlides.map((slide) => [slideIdentity(slide), slide]));
  return {
    schemaVersion: 1,
    modelSha256: model.modelSha256,
    snapshotSha256: model.snapshotSha256,
    templateFingerprint: model.templateFingerprint,
    slides: fixture.map((fixtureSlide) => {
      const identity = slideIdentity(fixtureSlide);
      const modelSlide = modelByIdentity.get(identity);
      if (!modelSlide)
        throw new Error(`Independent parity fixture has no model slide: ${identity}`);
      const { managedNotes, sources, ...content } = modelSlide;
      const managedVisibleTextInventory = structuredClone(fixtureSlide.managedVisibleTextInventory);
      const inheritedVisibleTextInventory = structuredClone(
        fixtureSlide.inheritedVisibleTextInventory,
      );
      return {
        role: fixtureSlide.role,
        ...(fixtureSlide.instanceId ? { instanceId: fixtureSlide.instanceId } : {}),
        nativeObjectKinds: structuredClone(fixtureSlide.nativeObjectKinds),
        hyperlinkInventory: structuredClone(fixtureSlide.hyperlinkInventory),
        connectorInventory: structuredClone(fixtureSlide.connectorInventory),
        ...(fixtureSlide.capabilityStructureInventory
          ? {
              capabilityStructureInventory: structuredClone(
                fixtureSlide.capabilityStructureInventory,
              ),
            }
          : {}),
        ...(fixtureSlide.weeklyMilestoneStructureInventory
          ? {
              weeklyMilestoneStructureInventory: structuredClone(
                fixtureSlide.weeklyMilestoneStructureInventory,
              ),
            }
          : {}),
        managedVisibleTextInventory,
        protectedVisibleTextInventory: [],
        inheritedVisibleTextInventory,
        visibleTextInventory: [...managedVisibleTextInventory, ...inheritedVisibleTextInventory],
        content,
        managedNotes,
        sources,
      };
    }),
  };
}

export function independentlyAuthoredParityReadbacks(model: Record<string, unknown>): {
  google: Record<string, unknown>;
  pptx: Record<string, unknown>;
} {
  return {
    google: readbackFromFixture(model, GOOGLE_SLIDES_FIXTURE),
    pptx: readbackFromFixture(model, POWERPOINT_FIXTURE),
  };
}
