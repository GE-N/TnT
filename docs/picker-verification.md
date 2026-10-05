# Simulator element picker verification — issue #4

Verified on 2026-10-05 (Asia/Bangkok). Ticket: https://github.com/GE-N/TnT/issues/4. Dependency #3 is completed. Review baseline: `eefabc5ce8998d3378a3d9e1c4d4d28d89c05e0a`.

## Environment and verified integration

- macOS 15.1 (24B83), Xcode 16.1 (16B40), Node.js 24.7.0.
- Maestro 2.11.0, installed from its official release. The adapter checks this version before inspection/execution.
- Prepared iPhone 15, iOS 17.0, device `E5C92F6E-40DC-493C-93B4-469E67193736`.
- Installed target app `com.example.HybridApp`, build 1.

The installed `maestro hierarchy --help` verifies JSON hierarchy output (`--compact` is optional CSV; it is not used). `maestro --device <id> hierarchy --no-ansi` returned attributes/children, accessibility labels, resource identifiers, and bounds such as `[341,58][377,93]`. The application frame is 393 × 852 logical points. `xcrun simctl io <id> screenshot <file>` produced a 1179 × 2556 PNG: 3 pixels per logical point. The picker normalizes element bounds into that image space; browser clicks use fractions of the displayed image, so CSS scaling does not change the selected region.

The runner records hierarchy completion and screenshot timestamps and rejects a screenshot taking more than two seconds after hierarchy completion. This is a sequential capture pair, not an atomic screenshot/tree transaction. Captures expire after two minutes and are held only in memory; temporary PNG files are removed.

Selector behavior was checked against the pinned [Maestro 2.11.0 filter source](https://raw.githubusercontent.com/mobile-dev-inc/maestro/cli-2.11.0/maestro-client/src/main/java/maestro/Filters.kt) and [orchestration source](https://raw.githubusercontent.com/mobile-dev-inc/maestro/cli-2.11.0/maestro-orchestra/src/main/java/maestro/orchestra/Orchestra.kt). Basic matches use deeper matching nodes, indexed candidates sort by screen y then x, labels match without case sensitivity, and relative positions compare top-left coordinates. Preview exposes raw overlaps separately from eligible Maestro targets. Constraint anchors must be unique; arbitrary regex, expressions, nested indices, and unsupported selector keys are rejected by this form. Labels are escaped and anchored in executable YAML.

## Real runs and browser journey

| Journey | Run ID | Observed outcome |
| --- | --- | --- |
| Browser: click Home, explicitly select its candidate, choose visible, preview, Save & run step | `8f01e3b5-2618-40aa-8934-3200d3b89717` | Passed; saved YAML appended `assertVisible`, isolated snapshot executed only that assertion; mapped step passed and cleanup verified. |
| Runner API: picked Home not-visible assertion | `9ce21f53-e6b2-44b6-98e1-05405594832a` | Assertion-failed as intended; mapped assertion failed, real screenshot/hierarchy/logs retained, cleanup verified. |
| Runner API: picked Settings tap with reviewed index 0 | `e3387776-5408-4289-bc76-a87b6b021876` | Tap passed; subsequent real hierarchy showed Settings with APPEARANCE, NOTIFICATIONS, LANGUAGE, and ABOUT sections. |
| Runner API: overlapping Dark Mode candidates, explicit deepest candidate/index 0, visible assertion | `0314e21b-c7b0-4571-875e-6ea8097fd1b1` | Screenshot-region query returned both Dark Mode candidates; plain selector was blocked as ambiguous. Reviewed index identified `element-29`; real assertion passed and cleanup verified. No preference was changed. |

The final negative proof retained `raw/2026-10-05_190357/flow/screenshots/step-003-assertCondition-^Home$.png`, structured command metadata, screen hierarchy, JUnit report, device logs, and Maestro logs. Artifacts live under `.tnt/runs/<run-id>` and are accessible through the existing protected run artifact API.

After the Settings tap, attempting to save the previous target again failed with: “Stale capture: selected target, bounds, ancestry, or selector constraints changed. Refresh and review again.” An earlier full-screen comparison also rejected an unrelated status change; the final semantic check instead validates the selected target and its ancestry/constraints. Coordinate fallback deliberately keeps the conservative screenshot/hierarchy comparison.

Every picked execution snapshot retains `pickerReference` with the capture ID, review ID, and captured time. The opaque review binds execution to the exact generated isolated YAML. Substituting another flow fails before tool execution. Execution acquisition repeats freshness validation while holding the shared device lock; another run or app launch cannot overlap inspection/execution. Unverified hierarchy process cleanup retains ownership for manual recovery.

Input generates `tapOn` followed by `inputText`; tap/input/visible/not-visible generation is covered at the public runner boundary. No input field was exercised in these real proof journeys. Real tap and positive/negative assertions satisfy this ticket's real-device verification gate; broader app-specific input behavior is not claimed.

## Checks and review

- 22 tests passed: existing launch/scenario tests plus 10 picker tests at the public runner boundary. Fixtures replace only external tool output and time.
- Type checking and production build passed; `git diff --check` passed.
- Standards review: no documented breaches or unresolved findings. Shared runner client resolved the duplicated request-helper suggestion.
- Spec review: no unresolved findings. The overly strict semantic freshness finding was fixed and regression-tested.

## Practical limits

The app must already be foregrounded in the desired state. Running a picked step does not relaunch the app or replay earlier commands. Not-visible against a currently visible element is a deliberately failing assertion. Unsupported/unlabeled controls need an inspected identifier or explicitly chosen point; this is not OCR. Coordinates support tap/input only and depend on layout; unrelated animation/clock changes can invalidate their strict check. Semantic validation cannot eliminate the small interval before the actual device action, whose real result remains authoritative.

The picker saves literal, non-secret input text. Confidential inputs continue through authored scenario runtime parameters, with the existing artifact-withholding policy. Captures are explicit inspection of the currently displayed app; ordinary screenshots/logs can contain app data and stay local. No mock controller, canvas editor, reusable-flow packaging, history UI, or screen-triggered default action is part of this slice.
