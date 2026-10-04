# Issue #3 execution verification

Verified on 2026-10-04 against [GE-N/TnT#3](https://github.com/GE-N/TnT/issues/3). The authenticated issue body and activity were read before implementation; no additional human discussion changed the approved criteria.

Environment: macOS 15.1, Xcode 16.1, Node 24.7.0, OpenJDK 17.0.14, Maestro 2.11.0. Device: booted iPhone 15, iOS 17.0, `E5C92F6E-40DC-493C-93B4-469E67193736`. Installed app: `com.example.HybridApp`. Maestro was downloaded from the [official releases](https://github.com/mobile-dev-inc/Maestro/releases), extracted into ignored `.tnt/tools/maestro`, and checked with its own `--version` and `test --help`. The subprocess selects a valid Java installation without changing the user's shell configuration.

## Verified tool interface

The installed CLI supports an explicit `--device`, `test --no-ansi --format JUNIT --output <file> --test-output-dir <directory> <flow>`, and `-e NAME=value` runtime inputs. The [official CLI documentation](https://docs.maestro.dev/maestro-cli/maestro-cli-commands-and-options) is a reference; installed help and real output establish this adapter's actual contract.

Real runs produced a JUnit suite with one testcase, structured `commands.json`, a manifest, tool/device logs, and a failed assertion screenshot/hierarchy. Artifacts live in timestamped per-flow subdirectories, so the adapter discovers them recursively rather than assuming a flat output folder. Command metadata includes command objects, status, depth, sequence numbers, error detail, and artifact paths. Internal configuration/variable events are excluded from top-level step mapping. Unsupported or ambiguous structures are reported unavailable with raw metadata retained. No terminal-text event parser or live-step streaming claim is used.

## Real behavior evidence

- Browser passing flow: `launchApp` then `assertVisible: Home`, run `29717422-44d6-40cb-8d7a-798ec4646355`. UI showed passed scenario and two passed steps. Its immutable YAML, metadata, tool versions, mapping, JUnit, and raw logs remain under `.tnt/runs/<id>`.
- Browser failing flow: `assertVisible: TnT intentionally absent heading`, run `92bb7826-c0e6-419c-a900-4414baacb40d`. UI showed assertion-failed, launch passed/assertion failed, the expected visible text, raw log, and the real failure screenshot. Reviewed run `6e06e71e-ac02-4b4d-b497-cbe4052851e4` repeated the failure for the final visible demonstration and verified process-group cleanup.
- Invalid YAML: browser submitted `appId: [broken`; preflight rejected it with an actionable YAML error and started no Maestro execution.
- Unavailable device: the prepared simulator was briefly shut down, then the browser refreshed to no running simulator and disabled Run scenario. The simulator was booted and refreshed afterward.
- Reviewed cleanup: a long `repeat` flow was cancelled through the actual local API, run `3b192079-f177-45a7-8495-44bc29936738`. A concurrent submission was rejected with “device operation is already in progress.” Cancellation returned cancelled only after owned process-group disappearance was verified. The next run acquired ownership successfully.
- Confidential inputs: run `a81285a9-ccb1-479c-9d1e-66c4aa1ab97e` executed `assertVisible: ${HEADING}` using a runtime input. It passed, retained only authored YAML and snapshot artifacts, withheld raw logs/evaluated metadata/images, and verified removal of confidential temporary artifacts. Runtime values are not recorded in the result or snapshot. Fixtures additionally use a unique secret to verify absence from all retained artifacts.

Earlier experimental artifacts predate the structured cleanup field; new results use an explicit verified flag. Runtime artifacts are ignored by Git and remain local. A normal passed flow with an unsupported `repeat` command also proved the scenario can pass while mapped step detail is honestly unavailable.

## Checks and review

The approved specification defines the public runner as the primary automated test boundary. New behavior tests cover immutable versions after workspace edits, assertion evidence, cancellation ownership through cleanup, exclusion across runner instances, invalid/symlink workspace paths, confidential input retention, and conservative ownership after unverified cleanup. Simulator/Maestro fixtures occur only at the external tool boundary; they complement the real checks above.

Final full suite: 12 tests passed. Type checking and production build passed. Standards review found an artifact-response race and a cleanup-message heuristic; both were fixed and re-reviewed. Spec review found premature process-group cleanup reporting; the adapter now verifies disappearance with a bounded check and retains ownership if cleanup remains unverified. Both reviewers confirmed no remaining concrete findings.

Limits: single-flow workspaces reject external file references and authored artifact paths; reusable-flow packaging follows later. Confidential runs deliberately withhold raw/visual evidence. No mock instance is allocated and app state is not restored. Crash recovery is conservative: retained ownership/private artifacts require inspection and cleanup before retrying. No history UI, Mockoon control, screenshot picker, canvas, or default-action handler is included.
