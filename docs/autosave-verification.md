# Workspace autosave verification — issue #33

Implements [Autosave with trustworthy persistence status](https://github.com/GE-N/TnT/issues/33) on the existing local workspace service and UI. Valid authored edits and committed renames autosave; a simulator is unnecessary. Untouched blank contexts stay out of the library. Raw drafts are not durable in this ticket.

The UI serializes its writes and checks the current content before adopting responses. Only acknowledged current content produces Saved locally. Local atomic writes compare the expected revision; stale saves and renames return HTTP 409. Recovery creates an independent named copy without overwriting the competing version. Recency remains based on opening, independently of saves.

## Behavior checked

- Real-service UI journey: committed rename, autosave/reopen, independent copies, pending-form guards, actual permission failure with retained edits and Retry, delayed acknowledgement during further editing, revision conflict and copy recovery, unchanged editor Run rejecting a competing revision.
- Invalid alias YAML stays in the editor, remains unsaved, triggers beforeunload protection, and blocks workspace replacement. Incomplete form and canvas drafts continue to require apply, repair or cancel.
- Public-service tests: competing and delayed stale writes, HTTP conflict status, actual storage failures preserving prior acknowledged content, malformed revision metadata, legacy records, stable opened ordering and metadata.
- Existing execution and batch tests retain their validation and immutable snapshot assertions. Sequential fixture writes now send acknowledged revisions.
- Existing native controls, Escape/focus behavior and narrow-screen manager layout are retained. This verification uses jsdom UI journeys, not a new native simulator or visual-browser proof.

## Standards

No documented standards violations or blocking findings. Typed HTTP 409 errors resolved the review's optional concern about coupling recovery to error wording.

## Spec

No remaining blockers. Review caught and resolved a cached-save shortcut that could bypass app-ID preparation and conflict checking before Run. The blank-context finding was withdrawn because the parent spec explicitly keeps untouched blank drafts out of the saved library.

Review summary: Standards 0 remaining findings; Spec 0 remaining findings.

## Final validation

`npm run typecheck` passed. `npm test` passed all 160 tests. `git diff --check` passed.
