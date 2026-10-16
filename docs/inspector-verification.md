# Inspector keyboard, accessibility and desktop browser review (#51)

Parent: [#40](https://github.com/GE-N/TnT/issues/40) Option 1 floating inspector. Hardening pass across #43–#50.

## What changed

- **Tab order:** visit step summaries form one composite list (a single `tabIndex={0}` stop; Arrow Up/Down/Home/End move between rows). The one-stop / arrow contract stays active while a run is locked (edits stay blocked). Drag handles and the ⋯ trigger stay out of the tab order (`tabIndex={-1}`; ArrowRight reaches ⋯ when unlocked). Deleting or discarding the focused row heals the list stop onto a surviving row.
- **Inline edit order:** fields → Destination → Pick from screen (Element mode) → YAML → ✕. Pick stays in the Element edit flow visually (flex `order` under the selector) while DOM order keeps Destination before Pick for Tab.
- **Focus stability:** run / save / autosave still do not move focus (covered by #50 journeys and kept here). Esc closes the inspector only when the target is not an editable field; inline edit Esc still cancels the row first.
- **Shortcut suppression:** shared `isEditableTarget` suppresses single-key inspector/canvas shortcuts inside inputs, textareas, selects, comboboxes and the YAML editor (floating-card Esc/arrows, screen-node nudge arrows, step-list arrows).
- **Accessible structure:** errors keep `role="alert"`; run/status badges and notices keep `role="status"`. Targets remain ≥44px. Danger palette aligned to AA tokens `#b3261e` on `#fdecea`; warning `#8a4b00` on `#fff4e5`; primary `#0a63d1`.

UI-only: no `shared/`, `server/canvas*.ts` or `server/default-actions.ts` changes. Golden fixtures unchanged.

## jsdom coverage (public workspace boundary)

`tests/inspector-a11y-ui.test.ts` drives the real `Scenarios` + `createScenarios` persistence service (same journey pattern as #50), not an in-memory `CanvasEditor` host:

- one tab stop + Arrow/Home/End; deleting the last focused row keeps a stop
- discarding a new active row restores a surviving stop
- running keeps one list stop and arrow navigation without unlocking edits
- edit tab order fields → Destination → Pick → YAML → ✕ (DOM order)
- shortcut suppression in a focused selector; failed run announces `role="status"` / `role="alert"`

Existing floating-inspector, match-by and run-state UI journeys remain green.

## Desktop browser review

Reviewed with the real `CanvasEditor` fixture via Vite + Chrome headless (`scripts/inspector-browser-review.mjs`) on Linux, Node 22. Metrics: `docs/evidence/inspector-a11y-metrics.json`.

| Check | Result |
| --- | --- |
| Placement / flip | Home opens to the **right** at 1440×900 and 1280×800. Settings at 1.15× zoom **flips below**. |
| Clamping | Narrow 480×700 viewport with Home panned so left/right ideals overflow; recorded `data-inspector-clamped` and in-window left/top in the clamped shot. |
| Fixed size at zoom | Inspector width stayed **300px** at 0.5×, 0.85× and 1.15× zoom. |
| Contrast | Metrics include **rendered** foreground/background samples and WCAG ratios for danger text, warning notice, primary Add step, and failed status (not tokens alone). |
| 44px targets | Close, step summary, Add step, YAML, Pick, Destination, and Done sizes recorded when present. |
| Focus rings | Focused summary outline recorded in metrics. |
| Keyboard journey | Scripted create → link Destination → reorder via ⋯ → delete on the live fixture; log in metrics under `keyboard`. |

### Screenshots

![1440×900 placement, focus ring on step list](evidence/inspector-a11y-1440x900.png)

![1280×800 placement](evidence/inspector-a11y-1280x800.png)

![Flip below on Settings at higher zoom](evidence/inspector-a11y-flip-below.png)

![Clamped placement after panning Home in a narrow viewport](evidence/inspector-a11y-clamped.png)

![Fixed 300px width at 50% zoom](evidence/inspector-a11y-zoom-fixed.png)

![Element edit: Pick from screen, Destination, contrast and 44px controls](evidence/inspector-a11y-contrast-targets.png)

![After keyboard create / link / reorder / delete](evidence/inspector-a11y-keyboard-journey.png)

## Keyboard-only walkthrough (recorded)

On the fixture (`inspector-a11y-keyboard-journey` in metrics):

1. Focus the list stop → ArrowDown between rows → Enter to edit → Tab through fields toward Destination → Esc cancel
2. **Create:** focus + Enter on `+ Add step` → choose Tap
3. **Link:** set Destination to Profile, fill selector, Done
4. **Reorder:** ArrowRight to ⋯ → Move down
5. **Delete:** focus last row → ⋯ → Delete (list keeps one tab stop)

## Verification

- `npm run typecheck`
- `npm run build`
- `npm test` (2 known macOS-only `plutil` failures in `tests/apps.test.ts` on Linux)
- Golden #41 unchanged
- `npm run check:canvas-contract` empty

Re-run screenshots: `npm install --no-save puppeteer-core && node scripts/inspector-browser-review.mjs`.
