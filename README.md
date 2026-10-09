# TnT · Mobile Test Workbench

Local browser UI and Mac runner for mobile UI testing. Select a running iOS simulator, launch an installed app, and execute an authored Maestro scenario ([issue #3](https://github.com/GE-N/TnT/issues/3)), or pick a reviewed executable step from a screenshot ([issue #4](https://github.com/GE-N/TnT/issues/4)).

## Start

Requires macOS, Xcode with an iOS simulator runtime, and Node.js 22.12 or later (verified with 24.7.0).

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:4317. The terminal prints the address; use `PORT` to choose another port. Open Simulator and install your app manually, refresh the device list, select a device, enter its bundle identifier, and click **Launch app**.

Inspect the captured screen. Click **I can see the app** only when the expected app is foregrounded. A successful launch command alone is reported as **Needs confirmation**, not a verified foreground launch. The confirmation records a human visual check, not automatic app identification. The captured screen can include an app's loading state.

The UI reports missing devices, tools, apps, invalid identifiers, and command failures. Expand **Launch log** for the evidence. Launch records and captured screens are retained locally under `.tnt/launches/` until you remove them; this directory is ignored by Git and may contain app data visible on-screen. There is no history browser yet. Restarting the server refreshes the session token; refreshing the page establishes the new session.

## Production and verification

```sh
npm run typecheck
npm test
npm run build
npm start
```

`npm start` serves the built UI with the same local runner. Stop the development server first if using the same port. The runner binds to `127.0.0.1`, validates local Host/Origin, and requires a session token for launch/artifact operations. It invokes fixed Xcode commands through argument arrays with no shell, with a 30-second command timeout and bounded output. Requests cannot provide a program, command, arguments, or filesystem path. Launch requests are serialized.

## Stack and launch tool

React/TypeScript + Vite for the browser; Node.js/TypeScript with the built-in HTTP server for the runner. Dependency versions are exact and the lockfile is committed.

The app-launch action uses Xcode `simctl`. Scenario execution uses Maestro **2.11.0**, verified against its installed CLI, JUnit report, structured command metadata, and failure artifacts. Install this exact version from the [official releases](https://github.com/mobile-dev-inc/Maestro/releases), extract it to `.tnt/tools/maestro`, or set `MAESTRO_BIN` to its executable before starting the workbench. Java 17+ is required; the runner detects Java 17 using `java_home` when `JAVA_HOME` is absent or invalid. Maestro analytics are disabled in runner subprocesses.

## Run a YAML scenario

In **Run an authored scenario**, enter a name and a single Maestro flow, then save or run it. The supplied starter targets the installed proof app `com.example.HybridApp`; replace its `appId` and selectors for your app. YAML has an `appId` header, `---`, and a command list. Saving preserves the authored text, including invalid YAML; running validates it and checks the device, installed app, and tool before execution.

Workspaces are stored under `.tnt/workspaces/<id>`. Each run stores an immutable `flow.yaml`, `snapshot.json`, and `result.json` under `.tnt/runs/<id>`, alongside raw Maestro reports and artifacts. Snapshot identity hashes the authored content, scenario metadata, step mapping, device, and Maestro version. Editing or saving during execution cannot change that snapshot. Results expose passed, assertion-failed, tool-error, or cancelled outcomes, expected assertion data, available screenshots, and raw logs. The browser polls for terminal results; live command streaming is not claimed. Supported top-level commands map from structured metadata; unsupported/ambiguous mappings remain unavailable.

This slice uses single-flow workspaces. External files and authored artifact paths are rejected; reusable flow/assets packaging follows later. Optional runtime inputs are a JSON object of uppercase names and string values, passed through Maestro's `-e` option. Reference them as `${NAME}` in YAML. All values are treated as confidential and omitted from snapshots. Runs with inputs withhold raw logs, evaluated metadata, and screenshots rather than risk publishing transformed or visually rendered secrets. Their temporary tool artifacts use private directories and are removed during cleanup; a crash retains private files and the ownership lock for manual recovery. Historical snapshots cannot replay omitted inputs. Keep secrets out of authored YAML. Only a small tool environment is forwarded; inherited application environment variables are excluded. Ordinary-run logs and screenshots may contain app data: retain them locally and review before sharing.

Device operations are serialized, including app launches. A filesystem ownership lock also excludes another runner using the same `.tnt` root. **Cancel run** terminates the owned CLI process group and waits for cleanup before releasing ownership. Runs time out after five minutes. Cleanup reports the actual process outcome; no Mockoon instance is allocated, and app data is not restored. A crash or unverified cleanup retains ownership conservatively. Inspect `.tnt/device-ownership.lock`, stop its owned CLI/helpers, and only then remove the stale lock before retrying. Automated crash recovery and mock restoration belong to later reliability slices.

## Pick a simulator element

Below the YAML editor, choose **Refresh screen**, click the captured screenshot, then select a hierarchy candidate explicitly. Overlapping elements remain separate candidates. The browser translates its displayed image coordinates into the screenshot's pixel space; the runner normalizes Maestro's logical bounds against the captured PNG dimensions. Screenshot capture follows hierarchy completion within two seconds; the pair is sequential, not an atomic device snapshot.

Choose tap, input (tap followed by `inputText`), visible, or not-visible. Edit the selector YAML using literal `text`/`id`, `index`, `enabled`, or `childOf`, `containsChild`, `above`, `below`, `leftOf`, and `rightOf` constraints. Labels are escaped and anchored in executable Maestro YAML; the form does not accept arbitrary regex or runtime expressions. **Preview selector** shows capture matches and executable YAML. Ambiguous selectors cannot be saved until an explicit constraint/index identifies the selected candidate. Maestro keeps deeper basic matches and orders indices top-to-bottom, then left-to-right. Preview exposes eligible candidates separately; index is a deliberate choice: use **Test selector** to verify it against Maestro. The preview is not proof of a real device match.

Unlabeled/custom controls may have no semantic selector. **Choose targeted identifier** uses an identifier on the candidate; **Permit identifier constraint** deliberately enables an inspected identifier in an edited hierarchy constraint. **Choose coordinate fallback** uses the clicked point and requires deliberate selection; coordinates support tap/input only, depend on layout, and must stay inside the chosen candidate. Do not put secrets in generated literal input text; use confidential runtime inputs in authored flows instead.

**Test selector** runs a real visible assertion without tapping. **Save step** appends the reviewed command(s) to the current workspace. **Save & run step** saves them and executes just those commands against the current simulator UI, without relaunching/resetting the app or rerunning earlier commands. Results, snapshots, cleanup, and artifacts use the existing scenario result panel. Not-visible against a currently visible picked element deliberately fails.

Captures are ephemeral, held in memory (at most eight), and expire after two minutes or a runner restart. Temporary screenshot files are removed after capture. Before saving/executing, the runner reacquires device ownership and checks the reviewed target, bounds, ancestry, selector matches, device, and screen dimensions. Unrelated status-bar changes do not invalidate semantic selectors. Coordinate fallbacks conservatively require the whole screenshot/hierarchy to remain identical; animations or clock changes can require refresh. Captured review identity is bound to the exact isolated flow and retained in the execution snapshot. There is always a small interval between validation and the actual device command; Maestro's real result remains authoritative. Capture and freshness inspection use the same owned-process cleanup policy as execution, with a 30-second hierarchy timeout.

No mock controller, canvas editor, or default-action handler is implemented yet.

Tests target the public runner and its HTTP boundary. Fixture command responses are confined to external tool boundaries; real-device checks are recorded in [launch verification](docs/launch-verification.md) and [scenario verification](docs/scenario-verification.md), and [picker verification](docs/picker-verification.md).

The full product specification is [GitHub issue #1](https://github.com/GE-N/TnT/issues/1).

## Mock response scenarios and reusable assertions (#5)

Import an existing Mockoon 9.9 environment under **API response scenario**. Choose a dedicated port (default 4320), a real test backend fallback, and an existing endpoint/response variant. Configure the simulator app's API base URL to the dedicated port before running; the workbench does not infer or change app networking. State resets and response selection must be acknowledged before the first YAML command. The original environment is never edited.

Pick and **Save step** for the trigger, then append a parameterized reusable assertion with the expected page text. **Run scenario** executes the complete YAML and snapshots its declared reusable files. The picker’s isolated execution buttons continue to execute only the reviewed picked command. Results show expected screen labels, mock intent, independently observed server transactions, and cleanup. Missing traffic is unavailable, even when a UI assertion passes.

Declared reusable flows use flat `.yaml` filenames and the same literal app ID. Other external file references remain unsupported. Cancellation stops owned Maestro and Mockoon processes before device release. See [verification and remaining real-app proof inputs](docs/mock-verification.md); #5 is not release-complete without the target API maintenance journey.

## Author actions and checks on canvas nodes

Each node has **Add action** and **Add check** controls. Add action opens a tap selector and a destination-screen choice. Enter the button's text or identifier and choose the screen it should open: the canvas draws the connection immediately. Extending the selected route's current end appends that connection automatically. Exact matching is the default, with explicit Contains and Regex options.

For Home → Coordinator, add an action on Home, target the Coordinator button, and choose Coordinator as its destination. Add checks on Coordinator for content identifying that page. YAML stays synchronized; all authored destination checks require execution evidence. Connections to screens without checks can be saved as drafts, but execution waits for a valid destination and checks. Reopened workspaces require selecting the saved route before running.

The **bin icon** is inside each expanded action/check row. Confirm deletion in the reference-warning dialog, or cancel with Escape. Deleting an action removes its connection and route entries; **Undo canvas deletion** restores the authored content and YAML when no later edits would be overwritten.

## Ordered connections and explicit routes (#16)

Use **Add screen** in the screen inspector to create nodes. Adding the first screen selects its initial route. Add checks to define each screen’s condition, then connect existing nodes by choosing an action’s destination or dragging between nodes. Edit the title directly in the node header; Enter or clicking outside saves it, Escape cancels, and blank names revert. Use the bin in a node header to delete that screen, with affected-route warnings and Undo. You can also drag **Drag to connect** from one node onto another. A new connection extends the selected route only when its source is the current tail. Connections at other points remain outside the route until you choose them explicitly.

On the source node, expand the compact rows under **Actions to reach …**. Add and edit **Tap**, **Input text**, and **Back**, and use the arrows to reorder them. Tap selectors support manual entry and the existing picker. Input text goes to the focused field; add a Tap first when focus is needed. Checks stay on their screen nodes. The selected route lists the ordered connection actions for review, and **Preview execution YAML** shows the commands that will run.

Ordered connections execute launch/setup, initial checks, each connection’s actions, and its destination checks. Unselected canvas branches are omitted; unassociated YAML commands are retained. Supported YAML edits refresh action forms and order. Results require actual action and assertion evidence. A failure stops normal progression through Maestro’s existing execution semantics. Legacy association-only routes retain their existing YAML-order validation.

Deleting an ordered connection action, a connection, or a referenced node reports the affected routes and leaves missing references visible for repair. Invalid routes cannot run. **Undo canvas deletion** restores graph and YAML together, provided later changes would not be overwritten. Saved workspaces retain action order and routes; select the saved route again after opening. Repeated visits are a separate feature in #17.

## Screen test canvas (#7)

Choose **Create screen canvas**, add one node per app screen, and associate current YAML commands or declared reusable flows in the screen inspector. Drag headers or use arrow keys to arrange screens; zoom and scroll to inspect the graph. Optional reference screenshots are local annotations up to 250 KB. Reopen saved work using its workspace ID; graph, YAML, reusable flows and mock configuration are restored, while the route must be explicitly selected again.

Connect a source action and destination assertion, add a response-condition explanation, then create an explicitly ordered scenario path. Select it before **Run scenario**. YAML owns execution: the selected route must match its existing command order. Stale/broken/ambiguous references block the selected route and require explicit repair. The executed result canvas uses an immutable graph snapshot, reports verified outcomes after execution, and fails an unverified required destination instead of switching branches. Shared screens expose their reusable assertion flows.

Setup/default-action handlers remain unavailable until #6. The actual API maintenance-route integration gate remains outstanding; see [canvas evidence and limits](docs/canvas-verification.md).
