# TnT · Mobile Test Workbench

Local browser UI and Mac runner for mobile UI testing. Select a running iOS simulator, launch an installed app, and execute an authored Maestro scenario ([issue #3](https://github.com/GE-N/TnT/issues/3)).

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

No mock controller, picker, canvas editor, or default-action handler is implemented yet.

Tests target the public runner and its HTTP boundary. Fixture command responses are confined to external tool boundaries; real-device checks are recorded in [launch verification](docs/launch-verification.md) and [scenario verification](docs/scenario-verification.md).

The full product specification is [GitHub issue #1](https://github.com/GE-N/TnT/issues/1).
