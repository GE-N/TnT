# Workspace manager verification — issue #32

Scope: the compact title manager, discovery, manual saving, Rename, New and Save a copy. The editor continues to save explicitly; autosave and recovery drafts belong to the next ticket.

## Public UI/service journeys

`tests/workspace-manager-ui.test.ts` uses the real scenario/workspace service and a temporary local store. The journey covers an empty library, five recents, full-store search, full-library discovery, no matches, an unavailable store and Retry, named saving, copying, editing and reopening source/copy independently, incomplete form/scenario-rename/checkpoint drafts, cancellation, New with Save and continue, an untouched blank context, Escape/focus return, and a delayed save acknowledgement that cannot discard newer edits.

The scenario sequence journey checks that browsing remains available during an active batch, while switching, New, copy and rename remain blocked until cleanup. Existing canvas/scenario journeys now open work by name and save through the title manager. Their immutable-run and execution-validation assertions remain in place.

`tests/workspaces.test.ts` checks discovery across nonrecent items, duplicate names, legacy records, malformed records, missing work, path containment, independent internal graph/scenario/visit references, exclusion of runtime/ownership fields, failed writes and retry, serialized metadata updates, authenticated same-origin HTTP management, and accepted large legacy formatted records. Writes are atomic and serialized in the existing local workspace store. Derived diagnostics are recomputed rather than persisted in new records.

## Browser review

Reviewed the actual local workbench at 1280×900 and 390×844. The title sits outside the canvas pan/zoom area with its own inset. The desktop popover is bounded by available viewport height; the expanded library exposes older existing local records. At narrow width the same controls form one temporary scrolling sheet. The copy title, Create copy and Cancel controls fit within the sheet. Escape cancels and returns keyboard focus to Manage workspace. Buttons provide at least 44px touch targets.

## Code review

Baseline: `6017a918f6ac788231347490626b1f9b4a4b8e26` (the starting commit). Standards and Spec were reviewed independently with the code-review skill.

### Standards

No documented-standard violations or unresolved material baseline smells. The authored-content payload builder resolves the review's duplication/data-clump concern across save, copy and dirty detection.

### Spec

Review exposed missing draft guards, late-response edit loss and a read bound that excluded accepted large formatted legacy records. Those findings were fixed and covered by regressions. Final independent review: 0 unresolved Spec findings and no scope creep.

## Checks

`npm run typecheck` and `npm run build` pass. The final `npm test` run passes all 158 tests. HTTP integration checks require local listen permissions; the sandbox-blocked attempt was rerun with those permissions.

Review totals: Standards 0 unresolved findings; Spec 0 unresolved findings.
