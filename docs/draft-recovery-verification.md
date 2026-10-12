# Draft recovery manual verification

Automated tests cover the storage, conflict, and jsdom journeys in `tests/draft-recovery.test.ts` and `tests/draft-recovery-ui.test.ts`. jsdom does not apply media queries or a real canvas viewport, so these checks stay manual. UI tests that render through jsdom need Node 22.12 or newer.

## Desktop

1. Open a saved workspace, break the YAML, and wait until the header reads “Draft kept, not valid yet.” Refresh the page. The banner “Unsaved changes from {time} were recovered.” appears with Restore draft and Keep saved version. There is no Compare control.
2. Restore draft returns the incomplete YAML and unapplied field text. Keep saved version hides the banner and leaves `draft.json` in the workspace directory. The next valid save removes that file.
3. Save the workspace from another editor so the draft’s base revision is older. The banner adds “Based on an older version.” and replaces Restore draft with Restore as a copy. The copy contains the draft; the original draft file remains.
4. Replace `draft.json` with `{`. The saved workspace still opens, with “A recovered draft couldn't be read.” Discard draft asks “Discard the unreadable draft? This can't be undone.” and focuses Cancel. Cancel leaves the file and returns focus to Discard draft. Discard removes it.
5. While a save is failing, choose New workspace. The dialog offers Retry, Cancel, and Discard changes and switch, with Retry focused. Tab cycles inside the dialog. Escape returns to the editor. Discard changes and switch focuses Cancel; Cancel returns to Discard changes and switch. Discard asks for the workspace name before switching.
6. Switch from workspace A to B and back. Each workspace restores its scenario, zoom, scroll, and selected screen. The manager stays where it was. A missing saved scenario selects the first scenario and names both in the notice. A workspace with no `view.json` fits the canvas and selects the first scenario.
7. Enter a password in Confidential runtime inputs, then break the YAML. `draft.json`, `view.json`, and `session.json` do not contain that password.

## Narrow (under 760px)

1. The save status becomes an icon. Failures use ×, a kept draft uses !, paused autosave uses ‖, and the paused tooltip and description say “while the picker is open” or “no runner connected”. Failures use an alert. The recovery banner is a full-width bar with stacked buttons at least 44px tall.
2. The workspace manager still opens as the existing bottom sheet. Canvas pan and zoom change only the canvas viewport.
