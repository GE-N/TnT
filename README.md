# TnT · Mobile Test Workbench

Local browser UI and Mac runner for mobile UI testing. The first slice ([issue #2](https://github.com/GE-N/TnT/issues/2)) selects a running iOS simulator and launches an already-installed app.

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

Maestro is not installed on the inspected Mac. This slice uses Xcode's supported `simctl launch` and `simctl io screenshot` commands; it does not substitute a fake Maestro run. Executing user-authored Maestro YAML belongs to issue #3. No mock controller, picker, canvas editor, or default-action handler is implemented in this slice.

Tests target the public runner and its HTTP boundary. Fixture command responses are confined to the external simulator command boundary; real-device verification is separately recorded in [launch verification](docs/launch-verification.md).

The full product specification is [GitHub issue #1](https://github.com/GE-N/TnT/issues/1).
