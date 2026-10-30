# Draft recovery manual verification

Automated tests cover the storage, conflict, and jsdom journeys in `tests/draft-recovery.test.ts` and `tests/draft-recovery-ui.test.ts`. jsdom does not apply media queries or a real canvas viewport, so these checks stay manual. UI tests that render through jsdom need Node 22.12 or newer.

## Desktop

1. Open a saved workspace, break the YAML, and wait until the header reads “Draft kept, not valid yet.” A warning button sits after that status. Typing, pausing, and leaving a field do not open a note on the canvas or under the selected node. Click the warning button. A short popup opens at that button and reads “Unsaved changes from {time} were recovered.” The description can wrap. Restore draft (filled) and Keep saved version sit on one row. Refresh the page. The warning button is back and the popup stays closed until clicked. There is no Compare control.
2. Restore draft returns the incomplete YAML and unapplied field text, and the popup closes. Keep saved version hides the warning button and leaves `draft.json` in the workspace directory. The next valid save removes that file. A later invalid edit, including one made after that valid save, shows the warning button again. The popup stays closed until that button is clicked, including after refresh.
3. Save the workspace from another editor so the draft’s base revision is older. Open the warning button. The popup adds “Based on an older version.” and replaces Restore draft with Restore as a copy. The copy contains the draft; the original draft file remains.
4. Replace `draft.json` with `{`. The saved workspace still opens, with “A recovered draft couldn't be read.” Discard draft asks “Discard the unreadable draft? This can't be undone.” and focuses Cancel. Cancel leaves the file and returns focus to Discard draft. Discard removes it.
5. While a save is failing, choose New workspace. The dialog offers Retry, Cancel, and Discard changes and switch, with Retry focused. Tab cycles inside the dialog. Escape returns to the editor. Discard changes and switch focuses Cancel; Cancel returns to Discard changes and switch. Discard asks for the workspace name before switching. With the header on “Couldn't save.”, including while that dialog is open, reloading the page asks you to stay. Staying keeps the edit.
6. Switch from workspace A to B and back. Each workspace restores its scenario, zoom, scroll, and selected screen. The manager stays where it was. A missing saved scenario selects the first scenario and names both in the notice. A workspace with no `view.json` fits the canvas and selects the first scenario.
7. Enter a password in Confidential runtime inputs, then break the YAML. `draft.json`, `view.json`, and `session.json` do not contain that password.

## Paused autosave in a browser

The local runner always returns a token from `GET /api/status`, including when it is not ready. After that response, a normal session cannot sit on “no runner connected”.

Development only: run `npm run dev`, then open `http://127.0.0.1:4317/?no-runner=1`. Edit the scenario YAML. The header becomes “Unsaved changes · Autosave paused”, the icon is ‖, and the tooltip and accessible description are “no runner connected”. The top bar can still say the runner is connected; only the scenario token is withheld. Remove the query and reload to autosave again. `?no-runner=1` is ignored by `npm start` after `npm run build`, because that serves the production bundle where the development flag is off.

“while the picker is open” cannot be held with Design offline and no simulator. Refresh screen stays disabled until a simulator is selected, and opening Advanced screenshot picker does not pause autosave. With a booted simulator selected, edit the YAML, open Advanced screenshot picker, and click Refresh screen. While that button reads “Inspecting…”, the header is “Unsaved changes · Autosave paused” and the tooltip is “while the picker is open”. The pause ends when the capture request finishes.

## Narrow (under 760px)

1. The save status becomes an icon. Failures use ×, a kept draft uses !, paused autosave uses ‖, and the paused tooltip and description say “while the picker is open” or “no runner connected”. Failures use an alert. The warning button stays after the status icon. Its popup stays narrow, with the description wrapping and the two actions on one row. It does not become a full-width bar or sit under the selected node.
2. The workspace manager still opens as the existing bottom sheet. Canvas pan and zoom change only the canvas viewport.
