# RFC #92 T5 — knowledge draft review

Client review of an AI knowledge draft on current main (`2f24a2c` and later).
No live model calls. Generation in the hand test was a fake response in front of
the real workbench.

## What the workbench does

- A running knowledge request keeps the Ask AI field: the prompt stays, the spark
  animates, Stop replaces Send. There is no heading and no visible “Generating…”.
- When a knowledge draft arrives, the info sheet opens on its own. Purpose and
  Expected outcome that differ from the saved context are tinted
  `rgba(10,132,255,.08)` with a 2px accent in the sheet’s 16px gutter. The text
  column does not move. Why stays collapsed and is never tinted. ✓ Apply and ✕
  stay on the Ask AI capsule.
- Closing the sheet leaves it closed. No other right-hand panel opens, and the
  info button has no badge. Apply remains.
- An ask-back uses the existing question card. It can be dismissed and has no
  Apply. The sheet is unchanged.
- A mixed request stays a flow draft and does not open the sheet. After that
  flow is applied, the capsule asks “Update the purpose too?” with Update details
  and Skip, next to the flow’s 10 second Undo. Update details sends the stored
  remainder through `POST /api/ai/generations`. Skip leaves the flow as applied.
- Knowledge Apply clears the tint, shows Updating and then the saved freshness,
  and puts Undo on the capsule for 10 seconds. It does not add a Versions row.
- `KNOWLEDGE_UNAVAILABLE` shows “Scenario details aren't available right now.
  Nothing was changed.” `CONTEXT_REVISION_CONFLICT` shows “These details changed
  somewhere else. Nothing was applied.” The codes are not shown. Apply waits
  until the sheet has reloaded the server copy.

## Hand check

Screenshots of the running workbench, 1280×800 unless noted, are the review
record for the states above. At 1024×800 the sequence bar’s “Finish sequence”
control was fully inside the bar (its right edge at 645px, the bar’s at 814px).
The clip in the approved static preview is not what current main draws for this
sequence, and this change does not touch the sequence bar.
