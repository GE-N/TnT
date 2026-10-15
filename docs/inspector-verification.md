# Inspector keyboard, accessibility and desktop browser review (#51)

Parent: [#40](https://github.com/GE-N/TnT/issues/40) Option 1 floating inspector. Hardening pass across #43–#50.

## What changed

- **Tab order:** visit step summaries form one composite list (a single `tabIndex={0}` stop; Arrow Up/Down/Home/End move between rows). Drag handles and the ⋯ trigger stay out of the tab order (`tabIndex={-1}`; ArrowRight reaches ⋯). Inline fields, Destination, Pick from screen (Element mode), YAML and ✕ follow. ✕ is last in DOM/tab order while remaining visually in the header.
- **Focus stability:** run / save / autosave still do not move focus (covered by #50 journeys and kept here). Esc closes the inspector only when the target is not an editable field; inline edit Esc still cancels the row first.
- **Shortcut suppression:** shared `isEditableTarget` suppresses single-key inspector/canvas shortcuts inside inputs, textareas, selects, comboboxes and the YAML editor (floating-card Esc/arrows, screen-node nudge arrows, step-list arrows).
- **Accessible structure:** errors keep `role="alert"`; run/status badges and notices keep `role="status"`. Targets remain ≥44px. Danger palette aligned to AA tokens `#b3261e` on `#fdecea`; warning `#8a4b00` on `#fff4e5`; primary `#0a63d1`.

UI-only: no `shared/`, `server/canvas*.ts` or `server/default-actions.ts` changes. Golden fixtures unchanged.

## jsdom coverage

`tests/inspector-a11y-ui.test.ts` covers:

- one tab stop + arrow movement between step rows
- Destination / Pick / YAML / ✕ document order
- shortcut suppression in text fields and selects
- alert role on field errors

Existing floating-inspector, match-by and run-state UI journeys remain green.

## Desktop browser review

Reviewed with the real `CanvasEditor` fixture via Vite + Chrome headless (`scripts/inspector-browser-review.mjs`) on Linux, Node 22.14. Viewports **1440×900** and **1280×800**. Metrics are in `docs/evidence/inspector-a11y-metrics.json`.

| Check | Result |
| --- | --- |
| Placement / flip | Home opens to the **right** at both desktop sizes. Settings at 1.15× zoom **flips below** to avoid covering the next edge/window edge. |
| Clamping | Inspector stays inside the window; measured left/top remain non-negative within each viewport. |
| Fixed size at zoom | Inspector width stayed **300px** at 0.5×, 0.85× and 1.15× zoom. |
| Contrast | Computed `--inspector-primary: #0a63d1`, `--danger: #b3261e`, `--danger-surface: #fdecea`, `--warning: #8a4b00`, `--warning-surface: #fff4e5`. |
| 44px targets | Close and step summary measured **44×44** / height 44. |
| Focus rings | Focused summary outline `rgb(10, 132, 255) solid 3px` (inspector highlight). |

### Screenshots

![1440×900 placement, focus ring on step list](evidence/inspector-a11y-1440x900.png)

![1280×800 placement](evidence/inspector-a11y-1280x800.png)

![Flip below on Settings at higher zoom](evidence/inspector-a11y-flip-clamped.png)

![Fixed 300px width at 50% zoom](evidence/inspector-a11y-zoom-fixed.png)

![Element edit: Pick from screen, Destination, contrast and 44px controls](evidence/inspector-a11y-contrast-targets.png)

## Keyboard-only walkthrough (demo)

On the fixture: Enter on Home → ArrowDown through steps → Enter to edit → Tab through Match by / selector / Destination → Esc to cancel → ArrowRight to ⋯ → Delete with Undo → Tab to YAML → Tab to ✕ → Esc returns focus to the screen.

## Verification

- `npm run typecheck`
- `npm run build`
- `npm test` (2 known macOS-only `plutil` failures in `tests/apps.test.ts` on Linux)
- Golden #41 unchanged
- `npm run check:canvas-contract` empty

Re-run screenshots (optional): `npm install --no-save puppeteer-core && node scripts/inspector-browser-review.mjs`.
