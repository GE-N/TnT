# Workspace Trash verification (#36)

Implemented recoverable deletion in the existing local workspace manager and service. Current-workspace Delete and full-library row Delete name the target, show its identity, and offer Cancel / Move to Trash. The destructive confirmation focuses Cancel; Cancel and Escape return focus to the originating command. Trash remains part of the same management surface and fits the narrow-screen sheet.

Deletion moves the complete workspace directory into `.tnt/trash/<id>`, retaining authored content, references, drafts and view preferences. Content writes, draft writes, deletion and restoration share the existing root-level persistence queue. Lifecycle operations advance content revisions so stale saves cannot overwrite restored content. Existing destination identities, including empty directories and links, are rejected before moving a bundle. Directory sync is best effort on supported platforms, matching existing record-write behavior.

Deleting current work clears its last-active selection and returns to a chooser without an editor or a saved blank replacement. Deleting another workspace leaves current authoring unchanged. Named Undo reopens deleted current work only while no workspace is open; it preserves newly created unsaved work. Ordinary Restore retains the current editor. Failed persistence keeps actionable feedback; a successful Restore followed by failed Open offers Retry Open rather than pretending the entry remains in Trash.

Run preparation, execution and batch ownership block deletion of their workspace without implicit cancellation. Run files remain separate and unchanged by Trash and Restore. No permanent-purge, expiry, empty-Trash control or report-history surface was added.

## Validation

Public UI journeys use `Scenarios` backed by the real `createScenarios` service, stubbing simulator/Maestro boundaries only. They cover named confirmation, Cancel/Escape focus, current and noncurrent deletion, Undo, refresh restoration, failed Delete/Undo/Open, and Undo while newly created work is unsaved.

Public-service tests in `tests/workspace-trash.test.ts` hold content and draft writes across deletion, reject delayed writes, restart the service, preserve references and drafts, inject persistence failures and identity collisions, tolerate malformed Trash records, retain immutable execution evidence, and recover from failed session cleanup. The existing batch journey verifies its deletion guard.

Browser review checked the full library and named confirmation at 390 × 844, including readable identity wrapping and touch controls. It cancelled the confirmation without deleting stored work. Repository typechecking, production build and the full test suite pass.

## Standards

The standards review found one minor duplication in active/Trash summary mapping. Extracting the shared summary resolved it. Final review: zero outstanding findings.

## Spec

The spec review found restore feedback being cleared by library loading, incorrect retry guidance after Restore committed but Open failed, and Undo reopening over newly created unsaved work. Separate mutation feedback, separate Restore/Open outcomes, and the explicit no-workspace state resolved these issues. Public UI regressions cover all three. Final review: zero outstanding findings.

Standards: 0 outstanding findings. Spec: 0 outstanding findings.
