# Installed app picker — issue #13

Review baseline: `b360235991d5ccae7a1ce239952a2b2c72b5a337`. Specification: https://github.com/GE-N/TnT/issues/13. Verified 2026-10-06.

## Behavior

Launch configuration defaults to a picker loaded automatically for the selected running simulator. Options show name and bundle ID under separate User-installed apps and System apps groups. Refresh apps reloads the current simulator. Enter bundle ID manually switches to the existing validated text input; returning to the picker clears the manual selection. Switching simulators clears the selection and manual mode. Requests are cancelled on replacement, and late completions are ignored even if cancellation cannot stop the response. Picker-mode launch is disabled while loading or refreshing; manual entry remains available. Refresh clears a selection that is no longer installed. Loading, empty and retryable error states are visible.

The authenticated local endpoint returns only simulator identity, app name, bundle ID and simulator-provided classification. `simctl listapps` metadata is converted using macOS `plutil`; temporary metadata is private and removed after conversion. No app container paths are exposed. App discovery does not provision simulators or install apps. Launches continue through the existing installation check, screenshot capture and explicit confirmation flow.

## Verification

- Public runner/API tests cover simulator-provided classification (including a user app with an Apple-style ID), fallback names, invalid/unavailable simulator rejection, authenticated discovery, foreign-origin rejection and absence of container paths in API results.
- App UI regression tests render the real app and drive its controls. A deferred old-simulator response completes after the new simulator's list and selection, without replacing them; launch uses the selected simulator and bundle ID. Returning to the previous simulator clears the selection. Further tests cover a delayed refresh that blocks picker-mode launch, list failure/retry, removed app selection, empty state and explicit manual/picker modes.
- Real browser and prepared iPhone 15 / iOS 17: automatic list contained HybridApp and 17 system apps in separate groups. Picker launch `79f4c88b-f704-4595-9a1f-000e61952a91` captured HybridApp and was confirmed. System app launch `024ca2b0-a608-458a-91f2-b6b1e5da9b7e` captured Settings and was confirmed. An earlier Settings capture caught startup before the UI appeared and was deliberately left unconfirmed; relaunch produced the settled capture.
- Manual launch `c6e1945c-1324-497c-a01c-3f8d3a648537` captured HybridApp and was confirmed.
- Installed a temporary copy of the prepared demo app as `com.example.TnTRefreshProof`, refreshed and selected it, removed only that proof app, then refreshed. It disappeared, the selection cleared, and Launch was disabled. The original app remains installed.
- Only one real simulator is currently booted. Multi-simulator switching and delayed response behavior were verified with UI test fixtures rather than provisioning another device.

Final validation: 42 tests passed; type checking, production build and diff checks passed. Local screenshots and launch artifacts are ignored under `.tnt/`.
