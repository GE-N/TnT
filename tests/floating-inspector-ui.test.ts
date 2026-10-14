import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, useState } from "react";
import { refreshChecks, writeChecks } from "../shared/canvas-authoring.js";
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
  const changes:CanvasGraph[]=[];let latestGraph:CanvasGraph=canvas;let latestSource=yaml;let replaceGraph:(graph:CanvasGraph)=>void=()=>{};let replaceSource:(source:string)=>void=()=>{};
  function Host() {
    const [graph, setGraph] = useState<CanvasGraph | undefined>(()=>refreshChecks(canvas,yaml));
    const [source, setSource] = useState(yaml);latestGraph=graph!;latestSource=source;replaceGraph=setGraph;replaceSource=setSource;
    return createElement(CanvasEditor, {
      graph,
      onChange: next=>{if(next)changes.push(next);setGraph(next);},
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
    changes,
    saved:()=>({graph:structuredClone(latestGraph),yaml:latestSource}),
    restore:async(state:{graph:CanvasGraph;yaml:string})=>act(async()=>{replaceGraph(state.graph);replaceSource(state.yaml);}),
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
    await page.click(selector.closest('.visit-step')!.querySelector<HTMLButtonElement>('.visit-step-summary')!);
    selector.focus();
    assert.equal(await page.press(selector, "Escape"), true);
    assert.ok(page.card(), "First Esc cancels inline editing");
    assert.equal(await page.press(page.card()!, "Escape"), true);
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
  // Shared 11px rules (e.g. `.canvas-navigation-actions legend`, `.outcome`) also apply inside the card.
  const minimum = rules.find((rule) =>
    rule.selector.startsWith(".floating-inspector .field-hint,"),
  )!;
  for (const selector of [
    ".floating-inspector legend",
    ".floating-inspector .outcome",
  ])
    assert.ok(
      minimum.selector.split(",").includes(selector),
      `${selector} is raised to 12px`,
    );
  assert.match(minimum.body, /font-size:12px/);
  assert.match(css, /\.transition-label\{font:12px\/1\.5 system-ui;/);
});

test('visit menu filters groups, adds with arrows/Enter and restores focus on Escape',async()=>{
 const page=await mount({initialView:{selectedScreenId:'home',selectedVisitId:'v1'}});
 try{
  const trigger=page.card()!.querySelector<HTMLButtonElement>('.add-visit-step')!;await page.click(trigger);
  const input=page.document.querySelector<HTMLInputElement>('[role=combobox]')!;
  same(page.document.activeElement,input);
  await act(async()=>{Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype,'value')!.set!.call(input,'ass');input.dispatchEvent(new page.window.Event('input',{bubbles:true}));});
  absent(page.document.querySelector('[role=group][aria-label=Actions]'));assert.equal(page.document.querySelectorAll('[role=option]').length,2);
  await page.press(input,'ArrowDown');await page.press(input,'Enter');
  absent(page.document.querySelector('[role=dialog]'));const rows=page.section(1,'Home')!.querySelectorAll('.visit-step');assert.equal(rows.length,3);
  assert.match(rows[2].querySelector('.visit-step-summary')!.textContent!,/3 assertNotVisible/);assert.match(rows[2].textContent!,/after navigation, on Profile/);
  assert.equal(page.document.activeElement?.getAttribute('aria-label'),'Check 2 selector');
  await page.press(page.document.activeElement!,'Escape');assert.equal(page.section(1,'Home')!.querySelectorAll('.visit-step').length,2,'Escape removes a new blank step');await page.click(trigger);await page.press(page.document.querySelector('[role=combobox]')!,'Escape');same(page.document.activeElement,trigger);assert.ok(page.card());
  await page.click(trigger);await page.press(page.document.querySelector('[role=combobox]')!,'Tab');const cancel=page.document.activeElement as HTMLButtonElement;assert.equal(cancel.textContent,'Cancel');assert.equal(await page.press(cancel,'Enter'),false,'Enter on Cancel must not select an option');await page.click(cancel);assert.equal(page.section(1,'Home')!.querySelectorAll('.visit-step').length,2);
 }finally{await page.close();}
});

test('inline rows commit Enter and blur, cancel Escape, and move above navigation with one Undo',async()=>{
 const page=await mount({initialView:{selectedScreenId:'home',selectedVisitId:'v1'}});
 try{
  const row=page.card()!.querySelector<HTMLElement>('[data-operation-id="home-ready"]')!;
  const summary=row.querySelector<HTMLButtonElement>('.visit-step-summary')!;
  async function type(value:string){const input=row.querySelector<HTMLInputElement>('[aria-label="Check 1 selector"]')!;await act(async()=>{Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new page.window.Event('input',{bubbles:true}));});return input;}
  await page.click(summary);let input=await type('Saved on Enter');await page.press(input,'Enter');assert.match(summary.textContent!,/Saved on Enter/);assert.equal(summary.getAttribute('aria-expanded'),'false');
  await page.click(summary);input=await type('Cancelled');await page.press(input,'Escape');assert.match(summary.textContent!,/Saved on Enter/);assert.doesNotMatch(summary.textContent!,/Cancelled/);
  await page.click(summary);input=await type('Saved on blur');await act(async()=>page.heading(1,'Home').focus());assert.match(summary.textContent!,/Saved on blur/);same(page.document.activeElement,page.heading(1,'Home'),'Successful blur retains the chosen focus');
  const trigger=page.card()!.querySelector<HTMLButtonElement>('.add-visit-step')!;await page.click(trigger);const combo=page.document.querySelector('[role=combobox]')!;await page.press(combo,'ArrowDown');await page.press(combo,'ArrowDown');await page.press(combo,'ArrowDown');await page.press(combo,'Enter');
  const added=[...page.card()!.querySelectorAll<HTMLElement>('.visit-step')].at(-1)!;
  const pendingInput=added.querySelector<HTMLInputElement>('input[aria-label$=" selector"]')!;await act(async()=>{Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype,'value')!.set!.call(pendingInput,'Later check');pendingInput.dispatchEvent(new page.window.Event('input',{bubbles:true}));});await page.press(pendingInput,'Enter');
  const move=[...added.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='↑ Move above actions')!;assert.ok(move);await page.click(move);
  assert.deepEqual([...page.card()!.querySelectorAll('.visit-step-summary')].map(node=>node.textContent?.trim().split(' ')[0]),['1','2','3']);assert.equal(added.querySelector('.navigation-hint'),null);
  assert.match(page.card()!.querySelector('[role=status]')!.textContent!,/position 2/);
  const undo=[...page.document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Undo canvas deletion')!;assert.ok(undo);await page.click(undo);assert.ok(added.querySelector('.navigation-hint'));
 }finally{await page.close();}
});

test('bottom fade is shown only when the inspector content overflows',async()=>{
 const page=await mount({initialView:{selectedScreenId:'home',selectedVisitId:'v1'}});
 try{
  assert.ok(page.card()!.querySelector('.inspector-bottom-fade'));
  Object.defineProperty(page.card()!,'clientHeight',{value:400,configurable:true});
  await page.click(page.card()!.querySelector<HTMLButtonElement>('.add-visit-step')!);
  absent(page.card()!.querySelector('.inspector-bottom-fade'),'Equal content/client height must not show a fade');
 }finally{await page.close();}
});

test('empty selector Enter and blur retain the draft, save nothing, and expose an accessible error',async()=>{
 const page=await mount({initialView:{selectedScreenId:'home',selectedVisitId:'v1'}});
 try{
  const row=page.card()!.querySelector<HTMLElement>('[data-operation-id="home-ready"]')!;await page.click(row.querySelector<HTMLButtonElement>('.visit-step-summary')!);
  const input=row.querySelector<HTMLInputElement>('[aria-label="Check 1 selector"]')!;const before=page.saved();
  await act(async()=>{Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype,'value')!.set!.call(input,'   ');input.dispatchEvent(new page.window.Event('input',{bubbles:true}));});
  await page.press(input,'Enter');assert.equal(input.getAttribute('aria-invalid'),'true');assert.equal(page.document.getElementById(input.getAttribute('aria-describedby')!)!.textContent,'✕ Enter text to look for.');assert.deepEqual(page.saved(),before);assert.equal(row.querySelector('.visit-step-summary')!.getAttribute('aria-expanded'),'true');
  await act(async()=>page.heading(1,'Home').focus());same(page.document.activeElement,page.heading(1,'Home'));assert.deepEqual(page.saved(),before);assert.equal(input.value,'   ');
  await act(async()=>{Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype,'value')!.set!.call(input,' a ');input.dispatchEvent(new page.window.Event('input',{bubbles:true}));});assert.equal(input.getAttribute('aria-invalid'),null);
  await page.press(input,'Enter');assert.equal(page.saved().graph.screens[0].tests.find(test=>test.id==='home-ready')!.check!.value,' a ');
 }finally{await page.close();}
});

test('ArrowUp moves backwards and wraps, while ArrowDown wraps forwards',async()=>{
 const page=await mount({initialView:{selectedScreenId:'home',selectedVisitId:'v1'}});
 try{
  await page.click(page.card()!.querySelector<HTMLButtonElement>('.add-visit-step')!);const combo=page.document.querySelector<HTMLInputElement>('[role=combobox]')!;
  const active=()=>page.document.querySelector('[role=option][aria-selected=true]')!.textContent;
  assert.equal(active(),'Tap');await page.press(combo,'ArrowUp');assert.equal(active(),'assertNotVisible');await page.press(combo,'ArrowUp');assert.equal(active(),'assertVisible');await page.press(combo,'ArrowDown');assert.equal(active(),'assertNotVisible');await page.press(combo,'ArrowDown');assert.equal(active(),'Tap');
 }finally{await page.close();}
});

test('mouse Cancel and Escape followed by focusout never save, and reopening restores the saved value',async()=>{
 const page=await mount({initialView:{selectedScreenId:'home',selectedVisitId:'v1'}});
 try{
  const row=page.card()!.querySelector<HTMLElement>('[data-operation-id="home-ready"]')!;const summary=row.querySelector<HTMLButtonElement>('.visit-step-summary')!;const input=row.querySelector<HTMLInputElement>('[aria-label="Check 1 selector"]')!;const before=page.saved();
  async function type(value:string){await act(async()=>{Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new page.window.Event('input',{bubbles:true}));});}
  await page.click(summary);await type('Mouse draft');const cancel=[...row.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Cancel')!;
  await act(async()=>{cancel.dispatchEvent(new page.window.Event('pointerdown',{bubbles:true}));input.dispatchEvent(new page.window.FocusEvent('focusout',{bubbles:true,relatedTarget:null}));cancel.click();});assert.deepEqual(page.saved(),before);assert.equal(page.changes.length,0);same(page.document.activeElement,summary);
  await page.click(summary);assert.equal(input.value,'Home');await type('Escape draft');
  await act(async()=>{input.dispatchEvent(new page.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));input.dispatchEvent(new page.window.FocusEvent('focusout',{bubbles:true,relatedTarget:null}));page.heading(1,'Home').focus();});assert.deepEqual(page.saved(),before);assert.equal(page.changes.length,0);
  await page.click(summary);assert.equal(input.value,'Home');await type('Saved');await page.press(input,'Enter');same(page.document.activeElement,summary);
  await page.click(summary);await type('Saved with Done');await page.click([...row.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Done')!);same(page.document.activeElement,summary);assert.equal(page.saved().graph.screens[0].tests.find(test=>test.id==='home-ready')!.check!.value,'Saved with Done');
 }finally{await page.close();}
});

test('Escape discards a new blank selector and leaves existing Undo history unchanged',async()=>{
 const page=await mount({initialView:{selectedScreenId:'home',selectedVisitId:'v1'}});
 try{
  const trigger=page.card()!.querySelector<HTMLButtonElement>('.add-visit-step')!;
  await page.click(trigger);const combo=page.document.querySelector('[role=combobox]')!;await page.press(combo,'ArrowUp');await page.press(combo,'Enter');
  const newRow=page.section(1,'Home')!.querySelector<HTMLElement>('.visit-step:last-of-type')!;const input=newRow.querySelector<HTMLInputElement>('input[aria-label$=" selector"]')!;await act(async()=>{Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype,'value')!.set!.call(input,'Later');input.dispatchEvent(new page.window.Event('input',{bubbles:true}));});await page.press(input,'Enter');
  await page.click([...newRow.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='↑ Move above actions')!);
  const before=page.saved();const undo=[...page.document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Undo canvas deletion')!;assert.equal(undo.disabled,false);
  await page.click(trigger);await page.press(page.document.querySelector('[role=combobox]')!,'Enter');const blank=page.document.activeElement!;await page.press(blank,'Escape');assert.deepEqual(page.saved(),before);assert.equal(undo.disabled,false);same(page.document.activeElement,trigger);
  await page.click(undo);assert.ok(page.card()!.querySelector('.navigation-hint'),'The prior move Undo is still available');
 }finally{await page.close();}
});

test('blank tap blur alone is blocked without refocusing, and Escape removes the new draft without Undo',async()=>{
 const page=await mount({initialView:{selectedScreenId:'home',selectedVisitId:'v1'}});
 try{
  const before=page.saved();await page.click(page.card()!.querySelector<HTMLButtonElement>('.add-visit-step')!);await page.press(page.document.querySelector('[role=combobox]')!,'Enter');const input=page.document.activeElement as HTMLInputElement;const row=input.closest('.visit-step')!;const afterAdd=page.saved();assert.deepEqual(afterAdd,before,'Add keeps the blank step outside saved graph/source');assert.equal(page.changes.length,0);
  await act(async()=>{Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype,'value')!.set!.call(input,' \t ');input.dispatchEvent(new page.window.Event('input',{bubbles:true}));page.heading(1,'Home').focus();});assert.equal(input.getAttribute('aria-invalid'),'true');assert.equal(page.document.getElementById(input.getAttribute('aria-describedby')!)!.textContent,'✕ Enter an element to tap.');same(page.document.activeElement,page.heading(1,'Home'));assert.deepEqual(page.saved(),afterAdd);assert.equal(input.value,' \t ');
  await page.press(input,'Escape');assert.equal(row.isConnected,false);assert.deepEqual(page.saved(),before);assert.equal([...page.document.querySelectorAll('button')].some(button=>button.textContent==='Undo canvas deletion'),false);
 }finally{await page.close();}
});

test('an external Undo refreshes an open draft without moving focus or writing the stale draft on blur',async()=>{
 const page=await mount({initialView:{selectedScreenId:'home',selectedVisitId:'v1'}});
 try{
  const row=page.card()!.querySelector<HTMLElement>('[data-operation-id="home-ready"]')!;await page.click(row.querySelector<HTMLButtonElement>('.visit-step-summary')!);const input=row.querySelector<HTMLInputElement>('[aria-label="Check 1 selector"]')!;
  await act(async()=>{Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype,'value')!.set!.call(input,'Stale draft');input.dispatchEvent(new page.window.Event('input',{bubbles:true}));});
  const before=page.saved();const graph={...before.graph,screens:before.graph.screens.map(screen=>({...screen,tests:screen.tests.map(test=>test.id==='home-ready'?{...test,check:{...test.check!,value:'Restored by Undo'}}:test)}))};const yaml=writeChecks(before.yaml,before.graph,graph);await page.restore({graph:refreshChecks(graph,yaml),yaml});assert.equal(input.value,'Restored by Undo');same(page.document.activeElement,input);
  const restored=page.saved();await act(async()=>page.heading(1,'Home').focus());assert.deepEqual(page.saved(),restored);assert.equal(page.changes.length,0,'Blur must not overwrite restored state');
 }finally{await page.close();}
});

test('summaries retain command quotes and destination, and last-step Move down is disabled',async()=>{
 const page=await mount({initialView:{selectedScreenId:'home',selectedVisitId:'v1'}});
 try{
  assert.equal(page.card()!.querySelector('[data-operation-id="avatar"] .visit-step-summary')!.textContent,'2 tapOn "Avatar" → Profile');assert.equal(page.card()!.querySelector<HTMLButtonElement>('[aria-label="Move action 1 down"]')!.disabled,true);
  const before=page.saved();const graph={...before.graph,edges:[{...before.graph.edges[0],id:'foreign',from:'settings',to:'home'},...before.graph.edges]};await page.restore({graph,yaml:before.yaml});assert.equal(page.card()!.querySelector('[data-operation-id="avatar"] .visit-step-summary')!.textContent,'2 tapOn "Avatar" → Profile','Destination lookup must be scoped to this screen');
 }finally{await page.close();}
});

test('navigation warning appears only at the first affected step and follows the next step after moving it',async()=>{
 const page=await mount({initialView:{selectedScreenId:'home',selectedVisitId:'v1'}});
 try{
  const before=page.saved();const title='Settings with a very long destination name for keyboard and touch users';await page.restore({graph:{...before.graph,screens:before.graph.screens.map(screen=>screen.id==='profile'?{...screen,title}:screen)},yaml:before.yaml});
  const trigger=page.card()!.querySelector<HTMLButtonElement>('.add-visit-step')!;
  for(const value of ['First affected','Second affected']){await page.click(trigger);const combo=page.document.querySelector('[role=combobox]')!;await page.press(combo,'ArrowUp');await page.press(combo,'Enter');const input=page.document.activeElement as HTMLInputElement;await act(async()=>{Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new page.window.Event('input',{bubbles:true}));});await page.press(input,'Enter');}
  assert.equal(page.card()!.querySelectorAll('.navigation-hint').length,1);assert.equal(page.card()!.querySelector('.navigation-hint p')!.textContent,'⚠ This step runs after navigation, on '+title);assert.match(page.card()!.querySelector('.navigation-hint')!.closest('.visit-step')!.textContent!,/First affected/);
  await page.click(page.card()!.querySelector<HTMLButtonElement>('.navigation-hint button')!);assert.equal(page.card()!.querySelectorAll('.navigation-hint').length,1);assert.match(page.card()!.querySelector('.navigation-hint')!.closest('.visit-step')!.textContent!,/Second affected/);
 }finally{await page.close();}
});


test('a saved new Back step remains saved when a later blank edit is cancelled',async()=>{
 const page=await mount({initialView:{selectedScreenId:'home',selectedVisitId:'v1'}});
 try{
  await page.click(page.card()!.querySelector<HTMLButtonElement>('.add-visit-step')!);const combo=page.document.querySelector('[role=combobox]')!;await page.press(combo,'ArrowDown');await page.press(combo,'ArrowDown');await page.press(combo,'Enter');
  const input=page.document.activeElement as HTMLInputElement;const row=input.closest('.visit-step')!;await page.press(input,'Enter');const saved=page.saved();
  await page.click(row.querySelector<HTMLButtonElement>('.visit-step-summary')!);await act(async()=>{Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype,'value')!.set!.call(input,'');input.dispatchEvent(new page.window.Event('input',{bubbles:true}));});await page.press(input,'Escape');assert.equal(row.isConnected,true);assert.deepEqual(page.saved(),saved);
 }finally{await page.close();}
});


test('first valid new step and destination commit once and Undo restores exact graph/source',async()=>{
 const page=await mount({initialView:{selectedScreenId:'home',selectedVisitId:'v1'}});
 try{
  const before=page.saved();await page.click(page.card()!.querySelector<HTMLButtonElement>('.add-visit-step')!);await page.press(page.document.querySelector('[role=combobox]')!,'Enter');const input=page.document.activeElement as HTMLInputElement;const row=input.closest('.visit-step')!;
  assert.equal(page.changes.length,0);await act(async()=>{Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype,'value')!.set!.call(input,' Next ');input.dispatchEvent(new page.window.Event('input',{bubbles:true}));const to=row.querySelector<HTMLSelectElement>('[aria-label$=" destination"]')!;to.value='settings';to.dispatchEvent(new page.window.Event('change',{bubbles:true}));});await page.press(input,'Enter');
  assert.equal(page.changes.length,1,'first valid commit publishes one graph change');const added=page.saved();const id=row.getAttribute('data-operation-id')!;assert.equal(added.graph.screens[0].tests.find(test=>test.id===id)!.tap!.value,' Next ');assert.equal(added.graph.edges.find(edge=>edge.actionTestId===id||edge.actionTestIds?.includes(id))!.to,'settings');
  const undo=[...page.document.querySelectorAll<HTMLButtonElement>('button')].filter(button=>button.textContent==='Undo canvas deletion');assert.equal(undo.length,1);await page.click(undo[0]);assert.deepEqual(page.saved(),before);assert.equal([...page.document.querySelectorAll('button')].some(button=>button.textContent==='Undo canvas deletion'),false);
 }finally{await page.close();}
});

test('visit review styles retain minimum hit targets and accessible validation colours',()=>{
 const css=readFileSync(new URL('../src/style.css',import.meta.url),'utf8');const rules=[...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([,selector,body])=>({selector:selector.trim(),body}));
 const rule=(selector:string)=>rules.find(item=>item.selector===selector)!.body;
 for(const selector of ['.floating-inspector .visit-step-summary','.visit-step-actions summary','.visit-step-actions button','.navigation-hint button,.visit-yaml-link'])assert.match(rule(selector),/min-height:44px/);
 assert.match(rule('.visit-step-actions summary'),/min-width:44px/);assert.match(rule('.navigation-hint button,.visit-yaml-link'),/font-size:12px/);
 assert.match(rule('.visit-selector-error'),/color:#b3261e/);assert.match(rule('.visit-selector-error'),/font-size:12px/);assert.match(rule('.visit-inline-fields input[aria-invalid=true]'),/border:2px solid #b3261e/);
 assert.match(css,/--warning: #8a4b00/);assert.match(css,/--warning-surface: #fff4e5/);assert.match(rule('.navigation-hint'),/color:var\(--warning\)/);assert.match(rule('.navigation-hint'),/background:var\(--warning-surface\)/);
 assert.match(rule('.floating-inspector .selected-visit>.visit-section-heading'),/width:calc\(100% \+ 16px\)/);
});

test('step menu moves retain focus, announce position and undo in one change',async()=>{
 const page=await mount({initialView:{selectedScreenId:'home',selectedVisitId:'v1'}});
 try{
  const before=page.saved();const row=()=>page.card()!.querySelector<HTMLElement>('[data-operation-id="home-ready"]')!;
  const menu=row().querySelector<HTMLElement>('[aria-label="Step actions"]');assert.ok(menu);
  assert.equal(row().querySelector<HTMLButtonElement>('[aria-label="Move check 1 up"]')!.disabled,true);
  await page.click(row().querySelector<HTMLButtonElement>('[aria-label="Move check 1 down"]')!);
  assert.deepEqual(page.saved().graph.paths[0].visits![0].operationIds,['avatar','home-ready']);
  same(page.document.activeElement,row().querySelector('.visit-step-summary'));
  assert.match(page.card()!.querySelector('[role=status]')!.textContent!,/Step 1 moved to position 2/);
  assert.equal(row().querySelector<HTMLButtonElement>('[aria-label="Move check 1 down"]')!.disabled,true);
  assert.equal(row().querySelector('details')!.open,false);
  await page.click([...page.document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Undo canvas deletion')!);
  assert.deepEqual(page.saved(),before);
 }finally{await page.close();}
});

test('drag handle shows a drop line, commits once, and one Undo restores the visit',async()=>{
 const page=await mount({initialView:{selectedScreenId:'home',selectedVisitId:'v1'}});
 try{
  const before=page.saved();const from=page.card()!.querySelector<HTMLElement>('[data-operation-id="home-ready"]')!;
  const to=page.card()!.querySelector<HTMLElement>('[data-operation-id="avatar"]')!;
  const handle=from.querySelector<HTMLButtonElement>('[aria-label="Drag step 1"]');assert.ok(handle);assert.equal(handle.draggable,true);
  async function drag(target:Element,type:string,y=1){await act(async()=>{const event=new page.window.MouseEvent(type,{bubbles:true,cancelable:true,clientY:y});Object.defineProperty(event,'dataTransfer',{value:{setData(){},effectAllowed:'',dropEffect:''}});target.dispatchEvent(event);});}
  await drag(handle,'dragstart');await drag(to,'dragover');assert.equal(to.dataset.dropPosition,'after');
  const count=page.changes.length;await drag(to,'drop');assert.equal(page.changes.length,count+1);
  assert.deepEqual(page.saved().graph.paths[0].visits![0].operationIds,['avatar','home-ready']);
  absent(page.card()!.querySelector('[data-drop-position]'));same(page.document.activeElement,from.querySelector('.visit-step-summary'));
  await page.click([...page.document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Undo canvas deletion')!);
  assert.deepEqual(page.saved(),before);
 }finally{await page.close();}
});

test('delete step offers live Undo toast and restores focus without a dialog',async()=>{
 const page=await mount({initialView:{selectedScreenId:'home',selectedVisitId:'v1'}});
 try{
  const before=page.saved();const row=page.card()!.querySelector<HTMLElement>('[data-operation-id="home-ready"]')!;
  await page.click(row.querySelector<HTMLButtonElement>('[aria-label="Delete check 1"]')!);
  absent(page.document.querySelector('[role=alertdialog]'));absent(page.card()!.querySelector('[data-operation-id="home-ready"]'));
  const toast=page.document.querySelector<HTMLElement>('.step-undo-toast[role=status]');assert.ok(toast);assert.match(toast.textContent!,/Step 1 deleted · Undo/);
  const undo=toast.querySelector<HTMLButtonElement>('button')!;assert.equal(undo.disabled,false);
  same(page.document.activeElement,page.card()!.querySelector('[data-operation-id="avatar"] .visit-step-summary'));
  await page.click(undo);assert.deepEqual(page.saved(),before);same(page.document.activeElement,page.card()!.querySelector('[data-operation-id="home-ready"] .visit-step-summary'));absent(page.document.querySelector('.step-undo-toast'));
  await page.click(page.card()!.querySelector<HTMLButtonElement>('[aria-label="Delete action 1"]')!);
  assert.equal(page.saved().graph.paths[0].edgeIds.length,0,'only outgoing action cuts the route');
  same(page.document.activeElement,page.card()!.querySelector('.add-visit-step'));
  await page.click(page.card()!.querySelector<HTMLButtonElement>('.visit-step-summary')!);
  const input=page.card()!.querySelector<HTMLInputElement>('[aria-label="Check 1 selector"]')!;
  await act(async()=>{Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype,'value')!.set!.call(input,'Changed');input.dispatchEvent(new page.window.Event('input',{bubbles:true}));});
  await page.press(input,'Enter');absent(page.document.querySelector('.step-undo-toast'));
 }finally{await page.close();}
});

test('deletion toast expires and cannot revive after a later edit returns to the old state',async context=>{
 const page=await mount({initialView:{selectedScreenId:'home',selectedVisitId:'v1'}});
 try{
  context.mock.timers.enable({apis:['setTimeout']});
  await page.click(page.card()!.querySelector<HTMLButtonElement>('[aria-label="Delete check 1"]')!);
  const deleted=page.saved();assert.ok(page.document.querySelector('.step-undo-toast'));
  await act(async()=>context.mock.timers.tick(8001));absent(page.document.querySelector('.step-undo-toast'));
  await page.restore(deleted);absent(page.document.querySelector('.step-undo-toast'));
 }finally{context.mock.timers.reset();await page.close();}
});

test('a drag cannot drop into a different visit or survive a drag end',async()=>{
 const page=await mount({initialView:{selectedScreenId:'profile',selectedVisitId:'v2'}});
 try{
  const before=page.saved();const handle=page.section(2,'Profile')!.querySelector<HTMLButtonElement>('.visit-step-drag')!;
  async function drag(target:Element,type:string){await act(async()=>{const event=new page.window.MouseEvent(type,{bubbles:true,cancelable:true,clientY:1});Object.defineProperty(event,'dataTransfer',{value:{setData(){},effectAllowed:'',dropEffect:''}});target.dispatchEvent(event);});}
  await drag(handle,'dragstart');await page.click(page.heading(4,'Profile'));
  const row=page.section(4,'Profile')!.querySelector('.visit-step')!;
  await drag(row,'dragover');absent(page.document.querySelector('[data-drop-position]'));await drag(row,'drop');assert.deepEqual(page.saved(),before);
  await drag(row.querySelector('.visit-step-drag')!,'dragstart');await drag(row,'dragover');assert.ok(page.document.querySelector('[data-drop-position]'));
  await drag(row.querySelector('.visit-step-drag')!,'dragend');absent(page.document.querySelector('[data-drop-position]'));await drag(row,'drop');assert.deepEqual(page.saved(),before);
 }finally{await page.close();}
});

test('leaving a drag target hides its drop line without committing',async()=>{
 const page=await mount({initialView:{selectedScreenId:'home',selectedVisitId:'v1'}});
 try{
  const before=page.saved();const row=page.card()!.querySelector('[data-operation-id="avatar"]')!;
  async function drag(target:Element,type:string){await act(async()=>{const event=new page.window.MouseEvent(type,{bubbles:true,cancelable:true,clientY:1});Object.defineProperty(event,'dataTransfer',{value:{setData(){},effectAllowed:'',dropEffect:''}});target.dispatchEvent(event);});}
  await drag(page.card()!.querySelector('.visit-step-drag')!,'dragstart');await drag(row,'dragover');assert.ok(page.document.querySelector('[data-drop-position]'));
  await drag(row,'dragleave');absent(page.document.querySelector('[data-drop-position]'));assert.deepEqual(page.saved(),before);
 }finally{await page.close();}
});
