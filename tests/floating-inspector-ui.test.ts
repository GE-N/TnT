import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, useState } from "react";
import { writeChecks } from "../shared/canvas-authoring.js";
import type { CanvasGraph, CanvasTest } from "../server/canvas.js";
import type { Rect } from "../src/inspector-placement.js";

// Compare DOM nodes by identity: assert's diff of a jsdom node exhausts the heap.
const same = (actual: unknown, expected: unknown, message = "same node") =>
  assert.ok(actual === expected, message);
const absent = (actual: unknown, message = "expected no node") =>
  assert.ok(actual == null, message);

const reference = {
  kind: "step" as const,
  file: "flow.yaml",
  index: 0,
  fingerprint: "draft",
};
const tap = (id: string, value: string): CanvasTest => ({
  id,
  label: value,
  role: "action",
  reference,
  tap: { target: "text", match: "exact", value },
});
const check = (id: string, value: string): CanvasTest => ({
  id,
  label: value,
  role: "assertion",
  reference,
  check: { visibility: "visible", target: "text", match: "exact", value },
});
const canvas: CanvasGraph = {
  screens: [
    {
      id: "home",
      title: "Home",
      x: 0,
      y: 0,
      tests: [check("home-ready", "Home"), tap("avatar", "Avatar")],
    },
    {
      id: "profile",
      title: "Profile",
      x: 400,
      y: 0,
      tests: [check("profile-ready", "Profile"), tap("gear", "Gear")],
    },
    {
      id: "settings",
      title: "Settings",
      x: 800,
      y: 0,
      tests: [check("settings-ready", "Settings"), tap("close", "Close")],
    },
  ],
  edges: [
    {
      id: "home-profile",
      from: "home",
      to: "profile",
      actionTestId: "avatar",
      assertionTestId: "profile-ready",
      responseCondition: "tap Avatar",
    },
    {
      id: "profile-settings",
      from: "profile",
      to: "settings",
      actionTestId: "gear",
      assertionTestId: "settings-ready",
      responseCondition: "tap Gear",
    },
    {
      id: "settings-profile",
      from: "settings",
      to: "profile",
      actionTestId: "close",
      assertionTestId: "profile-ready",
      responseCondition: "tap Close",
    },
  ],
  paths: [
    {
      id: "route",
      name: "Main",
      scenarioId: "main",
      screenId: "home",
      edgeIds: ["home-profile", "profile-settings", "settings-profile"],
      visits: [{ id: "v1" }, { id: "v2" }, { id: "v3" }, { id: "v4" }],
    },
  ],
};
const yaml = writeChecks(
  "appId: com.example.App\n---\n- launchApp\n",
  { screens: [], edges: [], paths: [] },
  canvas,
);

type View = {
  zoom?: number;
  scrollLeft?: number;
  scrollTop?: number;
  selectedScreenId?: string;
  selectedVisitId?: string;
};

async function mount(
  options: { initialView?: View; rects?: Map<string, Rect> } = {},
) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  const window = dom.window;
  const document = window.document;
  const keys = [
    "window",
    "document",
    "HTMLElement",
    "Event",
    "ResizeObserver",
    "IS_REACT_ACT_ENVIRONMENT",
  ];
  const previous = keys.map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  class ResizeObserver {
    observe() {}
    disconnect() {}
  }
  for (const key of keys)
    Object.defineProperty(globalThis, key, {
      value:
        key === "IS_REACT_ACT_ENVIRONMENT"
          ? true
          : key === "ResizeObserver"
            ? ResizeObserver
            : Reflect.get(window, key),
      configurable: true,
    });
  const rects = options.rects ?? new Map<string, Rect>();
  const empty = { left: 0, top: 0, width: 0, height: 0 };
  // Layout keys: "viewport", a screen id, or "label:<edge id>".
  window.HTMLElement.prototype.getBoundingClientRect = function (
    this: HTMLElement,
  ) {
    const key = this.classList.contains("canvas-viewport")
      ? "viewport"
      : (this.dataset.screenId ??
        (this.classList.contains("transition-label")
          ? "label:" +
            this.closest<SVGGElement>("[data-edge-id]")?.dataset.edgeId
          : ""));
    const rect = rects.get(key) ?? empty;
    return {
      ...rect,
      x: rect.left,
      y: rect.top,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      toJSON() {},
    } as DOMRect;
  };
  Object.defineProperty(window.HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("floating-inspector") ? 400 : 0;
    },
  });
  Object.defineProperty(window, "innerWidth", {
    value: 1200,
    configurable: true,
  });
  Object.defineProperty(window, "innerHeight", {
    value: 800,
    configurable: true,
  });
  const { createRoot } = await import("react-dom/client");
  const { CanvasEditor } = await import("../src/canvas.js");
  const views: View[] = [];
  function Host() {
    const [graph, setGraph] = useState<CanvasGraph | undefined>(canvas);
    const [source, setSource] = useState(yaml);
    return createElement(CanvasEditor, {
      graph,
      onChange: setGraph,
      yaml: source,
      onYamlChange: setSource,
      catalog: [],
      diagnostics: [],
      pathId: "route",
      onPathChange: () => {},
      disabled: false,
      scenarioMode: true,
      scenarioId: "main",
      scenarios: [{ id: "main", name: "Main", pathId: "route" }],
      initialView: options.initialView,
      onViewChange: (view) => views.push(view),
    });
  }
  const root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(createElement(Host)));
  const card = () => document.querySelector<HTMLElement>(".floating-inspector");
  const node = (id: string) =>
    document.querySelector<HTMLElement>(`[data-screen-id="${id}"]`)!;
  const section = (number: number, title: string) =>
    card()?.querySelector<HTMLElement>(
      `section[aria-label="Visit ${number} · ${title} operations"]`,
    ) ?? null;
  const heading = (number: number, title: string) =>
    section(number, title)!.querySelector<HTMLButtonElement>(
      ".visit-section-heading",
    )!;
  const highlighted = () =>
    [
      ...document.querySelectorAll<SVGGElement>(
        '[data-edge-id][data-highlighted="true"]',
      ),
    ].map((edge) => edge.dataset.edgeId);
  const press = async (target: Element, key: string) => {
    let prevented = false;
    await act(async () => {
      const event = new window.KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(event);
      prevented = event.defaultPrevented;
    });
    return prevented;
  };
  const click = (element: HTMLElement) => act(async () => element.click());
  const select = (title: string) =>
    click(
      document.querySelector<HTMLButtonElement>(
        `[aria-label="Select screen ${title}"]`,
      )!,
    );
  const relayout = () =>
    act(async () => {
      window.dispatchEvent(new window.Event("resize"));
    });
  const placement = () => {
    const style = card()!.style;
    return {
      left: Number.parseFloat(style.left),
      top: Number.parseFloat(style.top),
      side: card()!.dataset.inspectorSide,
    };
  };
  return {
    window,
    document,
    rects,
    views,
    card,
    node,
    section,
    heading,
    highlighted,
    press,
    click,
    select,
    relayout,
    placement,
    async close() {
      await act(async () => root.unmount());
      window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

const screenRect = (left: number, top: number): Rect => ({
  left,
  top,
  width: 250,
  height: 200,
});

test("one inspector opens for the selected screen and none without a selection", async () => {
  const page = await mount();
  try {
    absent(page.card(), "Nothing is open by default");
    absent(
      page.node("profile").querySelector(".canvas-visit-section"),
      "Visit sections are no longer rendered inside the node",
    );
    await page.select("Profile");
    assert.equal(
      page.document.querySelectorAll(".floating-inspector").length,
      1,
    );
    assert.equal(page.card()!.querySelector("h3")!.textContent, "Profile");
    absent(
      page.card()!.closest(".canvas-surface"),
      "The card sits outside the zoomed surface, so it keeps a fixed size",
    );
    assert.deepEqual(
      [...page.card()!.querySelectorAll("section[aria-label]")].map((item) =>
        item.getAttribute("aria-label"),
      ),
      ["Visit 2 · Profile operations", "Visit 4 · Profile operations"],
      "One section per visit, numbered by route index",
    );
    await page.select("Settings");
    assert.equal(
      page.document.querySelectorAll(".floating-inspector").length,
      1,
    );
    assert.equal(page.card()!.querySelector("h3")!.textContent, "Settings");
    await page.click(
      page
        .card()!
        .querySelector<HTMLButtonElement>(
          '[aria-label="Close Settings inspector"]',
        )!,
    );
    absent(page.card());
    absent(page.document.querySelector(".selected-screen"));
  } finally {
    await page.close();
  }
});

test("only the selected visit is expanded and the others are collapsed headers", async () => {
  const page = await mount();
  try {
    await page.select("Profile");
    assert.equal(
      page.heading(2, "Profile").getAttribute("aria-expanded"),
      "true",
    );
    assert.equal(
      page.heading(4, "Profile").getAttribute("aria-expanded"),
      "false",
    );
    assert.ok(page.section(2, "Profile")!.querySelector(".visit-section-body"));
    absent(
      page.section(4, "Profile")!.querySelector(".visit-section-body"),
      "A collapsed visit renders only its header",
    );
    const body = page
      .section(2, "Profile")!
      .querySelector(".visit-section-body")!;
    assert.equal(
      page.heading(2, "Profile").getAttribute("aria-controls"),
      body.id,
    );
    assert.ok(body.querySelector('[aria-label="Check 1 selector"]'));

    await page.click(page.heading(4, "Profile"));
    assert.equal(
      page.heading(2, "Profile").getAttribute("aria-expanded"),
      "false",
    );
    assert.equal(
      page.heading(4, "Profile").getAttribute("aria-expanded"),
      "true",
    );
    assert.equal(
      page.card()!.querySelectorAll(".visit-section-body").length,
      1,
      "Exactly one visit is expanded",
    );
    assert.equal(
      page.document
        .querySelector('[aria-label="Scenario sequence"] [aria-pressed="true"]')
        ?.getAttribute("aria-label"),
      "Visit 4 · Profile",
      "Expanding a visit selects it",
    );

    await page.click(page.heading(4, "Profile"));
    assert.equal(
      page.heading(4, "Profile").getAttribute("aria-expanded"),
      "true",
      "Choosing the expanded visit again keeps it expanded",
    );

    await page.click(
      page.document.querySelector<HTMLButtonElement>(
        '[aria-label="Scenario sequence"] [aria-label="Visit 3 · Settings"]',
      )!,
    );
    assert.equal(page.card()!.querySelector("h3")!.textContent, "Settings");
    assert.equal(
      page.heading(3, "Settings").getAttribute("aria-expanded"),
      "true",
    );
  } finally {
    await page.close();
  }
});

test("selecting a visit highlights its edge on the main canvas", async () => {
  const page = await mount();
  try {
    assert.deepEqual(page.highlighted(), []);
    await page.select("Home");
    assert.deepEqual(page.highlighted(), ["home-profile"]);
    await page.select("Profile");
    assert.deepEqual(
      page.highlighted(),
      ["profile-settings"],
      "Visit 2 leaves Profile by tap Gear",
    );
    assert.match(
      page.card()!.querySelector(".floating-inspector-note")!.textContent!,
      /Visit 2’s edge, Profile → Settings · tap Gear, is highlighted on the main canvas/,
    );
    const edge = page.document.querySelector<SVGGElement>(
      '[data-edge-id="profile-settings"]',
    )!;
    assert.ok(edge.classList.contains("highlighted-transition"));
    assert.equal(edge.querySelector("path")!.getAttribute("stroke-width"), "3");
    assert.equal(
      edge.querySelector("path")!.getAttribute("stroke"),
      "var(--inspector-highlight)",
    );

    await page.click(page.heading(4, "Profile"));
    assert.deepEqual(
      page.highlighted(),
      ["settings-profile"],
      "The last visit highlights the edge that reached it",
    );
    assert.equal(
      page
        .card()!
        .querySelectorAll(".canvas-surface,.canvas-lines,[data-edge-id]")
        .length,
      0,
      "There is no mini canvas in the inspector",
    );

    await page.press(page.heading(4, "Profile"), "Escape");
    assert.deepEqual(page.highlighted(), []);
  } finally {
    await page.close();
  }
});

test("Enter on a focused screen moves focus into the card and Esc returns it to the screen", async () => {
  const page = await mount();
  try {
    const profile = page.node("profile");
    assert.equal(profile.tabIndex, 0);
    profile.focus();
    await page.press(profile, "Enter");
    assert.ok(page.card());
    same(
      page.document.activeElement,
      page.heading(2, "Profile"),
      "Focus lands on the first visit header",
    );

    const fields = [
      ...page
        .card()!
        .querySelectorAll<HTMLElement>("button:not(:disabled),select,input"),
    ];
    const last = fields.at(-1)!;
    last.focus();
    assert.equal(
      await page.press(last, "Tab"),
      false,
      "Tab is not trapped inside the card",
    );
    assert.equal(
      await page.press(fields[0], "Tab"),
      false,
      "Tab is not trapped on the first control either",
    );

    const selector = page
      .card()!
      .querySelector<HTMLInputElement>('[aria-label="Check 1 selector"]')!;
    selector.focus();
    assert.equal(await page.press(selector, "Escape"), true);
    absent(page.card(), "Esc closes the inspector");
    same(
      page.document.activeElement,
      profile,
      "Esc returns focus to the screen",
    );

    await page.press(profile, "Enter");
    assert.ok(page.card());
    profile.focus();
    await page.press(profile, "Escape");
    absent(page.card(), "Esc on the open screen closes it too");
    same(page.document.activeElement, profile);
  } finally {
    await page.close();
  }
});

test("selecting with the pointer or moving the selection does not move focus", async () => {
  const page = await mount();
  try {
    const heading = page.document.querySelector<HTMLButtonElement>(
      '[aria-label="Select screen Profile"]',
    )!;
    heading.focus();
    await page.click(heading);
    assert.ok(page.card());
    same(page.document.activeElement, heading);
    const strip = page.document.querySelector<HTMLButtonElement>(
      '[aria-label="Scenario sequence"] [aria-label="Visit 1 · Home"]',
    )!;
    strip.focus();
    await page.click(strip);
    assert.equal(page.card()!.querySelector("h3")!.textContent, "Home");
    same(page.document.activeElement, strip);
  } finally {
    await page.close();
  }
});

test("the card anchors to the right of the selected screen", async () => {
  const rects = new Map<string, Rect>([
    ["viewport", { left: 0, top: 0, width: 1200, height: 800 }],
    ["home", screenRect(40, 100)],
    ["profile", screenRect(320, 100)],
    ["settings", screenRect(900, 600)],
  ]);
  const page = await mount({ rects });
  try {
    await page.select("Profile");
    assert.deepEqual(page.placement(), {
      left: 320 + 250 + 12,
      top: 100,
      side: "right",
    });
    rects.set("profile", screenRect(360, 140));
    await page.relayout();
    assert.deepEqual(
      page.placement(),
      { left: 360 + 250 + 12, top: 140, side: "right" },
      "The card follows the screen when the canvas moves",
    );
  } finally {
    await page.close();
  }
});

test("the card flips left at the window edge, and below when both sides are covered", async () => {
  const rects = new Map<string, Rect>([
    ["viewport", { left: 0, top: 0, width: 1200, height: 800 }],
    ["home", screenRect(900, 600)],
    ["profile", screenRect(860, 100)],
    ["settings", screenRect(20, 650)],
  ]);
  const page = await mount({ rects });
  try {
    await page.select("Profile");
    assert.deepEqual(page.placement(), {
      left: 860 - 12 - 300,
      top: 100,
      side: "left",
    });

    rects.set("profile", screenRect(400, 100));
    rects.set("label:profile-settings", {
      left: 700,
      top: 150,
      width: 160,
      height: 48,
    });
    await page.relayout();
    assert.equal(
      page.placement().side,
      "left",
      "It flips left rather than cover an edge label",
    );

    rects.set("home", screenRect(90, 100));
    await page.relayout();
    assert.deepEqual(
      page.placement(),
      { left: 400, top: 100 + 200 + 12, side: "below" },
      "With a screen on the left too, it goes below",
    );
  } finally {
    await page.close();
  }
});

test("the card stays clamped inside the window when its screen is panned off-screen", async () => {
  const rects = new Map<string, Rect>([
    ["viewport", { left: 0, top: 0, width: 1200, height: 800 }],
    ["profile", screenRect(-1600, -900)],
  ]);
  const page = await mount({ rects });
  try {
    await page.select("Profile");
    const assertInside = () => {
      const { left, top } = page.placement();
      assert.ok(left >= 8, "left edge " + left);
      assert.ok(left + 300 <= 1200 - 8, "right edge " + left);
      assert.ok(top >= 8, "top edge " + top);
      assert.ok(top <= 800 - 8, "bottom edge " + top);
      assert.ok(
        Number.parseFloat(page.card()!.style.maxHeight) <= 800 - 16,
        "The card scrolls rather than grow past the window",
      );
    };
    assertInside();
    rects.set("profile", screenRect(3000, 2000));
    await act(async () => {
      page.document
        .querySelector(".canvas-viewport")!
        .dispatchEvent(new page.window.Event("scroll"));
    });
    assertInside();
    rects.set("viewport", { left: 0, top: 420, width: 1200, height: 580 });
    rects.set("profile", screenRect(100, 500));
    await page.relayout();
    assert.ok(
      page.placement().top >= 420,
      "With the canvas fully visible from 420px, the card stays over it",
    );
  } finally {
    await page.close();
  }
});

test("the open screen and selected visit go through the canvas view record", async () => {
  const page = await mount();
  try {
    await page.select("Profile");
    await page.click(page.heading(4, "Profile"));
    assert.deepEqual(
      {
        selectedScreenId: page.views.at(-1)?.selectedScreenId,
        selectedVisitId: page.views.at(-1)?.selectedVisitId,
      },
      { selectedScreenId: "profile", selectedVisitId: "v4" },
    );
  } finally {
    await page.close();
  }
  const restored = await mount({
    initialView: { selectedScreenId: "profile", selectedVisitId: "v4" },
  });
  try {
    assert.equal(restored.card()!.querySelector("h3")!.textContent, "Profile");
    assert.equal(
      restored.heading(4, "Profile").getAttribute("aria-expanded"),
      "true",
    );
    assert.equal(
      restored.heading(2, "Profile").getAttribute("aria-expanded"),
      "false",
    );
  } finally {
    await restored.close();
  }
  const stale = await mount({
    initialView: { selectedScreenId: "home", selectedVisitId: "v4" },
  });
  try {
    assert.equal(
      stale.heading(1, "Home").getAttribute("aria-expanded"),
      "true",
      "A visit of another screen is not restored",
    );
  } finally {
    await stale.close();
  }
});

test("inspector styles keep 300px width, 44px targets, 12px text and the #0a63d1 primary", () => {
  const css = readFileSync(
    new URL("../src/style.css", import.meta.url),
    "utf8",
  );
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, selector, body]) => ({ selector: selector.trim(), body }))
    .filter((rule) => rule.selector.includes("floating-inspector"));
  assert.ok(rules.length > 0);
  const card = rules.find((rule) => rule.selector === ".floating-inspector")!;
  assert.match(card.body, /width:300px/);
  assert.match(card.body, /--accent:var\(--inspector-primary\)/);
  assert.match(css, /--inspector-primary: #0a63d1;/);
  for (const rule of rules)
    for (const [, size] of rule.body.matchAll(/font-size:(\d+)px/g))
      assert.ok(Number(size) >= 12, `${rule.selector} uses ${size}px text`);
  const targets = rules.find((rule) =>
    rule.selector.startsWith(".floating-inspector button,"),
  )!;
  assert.match(targets.selector, /select/);
  assert.match(targets.selector, /summary/);
  assert.match(targets.body, /min-height:44px/);
  assert.match(
    rules.find((rule) => rule.selector === ".floating-inspector-close")!.body,
    /min-width:44px;min-height:44px/,
  );
});
