# Issue #2 — real launch verification

Verified on 2026-10-04, Asia/Bangkok. This report covers the app-launch slice, not a full Maestro test scenario.

## Environment

| Item | Observed value |
| --- | --- |
| macOS | 15.1, build 24B83 |
| Xcode | 16.1, build 16B40 |
| Node / npm | 24.7.0 / 11.5.1 |
| Simulator | iPhone 15, iOS 17.0, already Booted |
| Device UDID | E5C92F6E-40DC-493C-93B4-469E67193736 |
| Installed user app | com.example.HybridApp, build 1 |
| Launch tool | Xcode 16.1 simctl, inspected with local help |
| Maestro | Not installed in PATH or the conventional user installation directory |

## Browser-to-device proof

1. Started `npm run dev` with simulator access and opened the workbench at http://127.0.0.1:4317.
2. The UI reported **Local runner connected** and listed the already-running iPhone 15.
3. Entered `com.example.HybridApp` and clicked **Launch app** in the browser.
4. The runner checked the installed app container, called `simctl launch`, and captured the device screen. Launch output reported PID 39196.
5. Inspected the captured PNG: the app's **Home** screen, demo action list, and **Loading items…** overlay were visible in the foreground. This proves foreground launch, not successful backend loading or a finished app workflow.
6. The UI initially reported **Needs confirmation**. After inspecting the real screen, clicked **I can see the app** and verified **Confirmed**.
7. Entered `com.example.DoesNotExist` and launched again. The UI reported **Failed** and **App is not installed on the selected simulator. Check its bundle ID.** The raw simulator error was retained.

The first launch ID was `80bce4cb-ed3f-42ff-b564-98a8a4873c15`. Runtime screenshots and result JSON remain in the ignored `.tnt/launches/` directory on this Mac. Screenshots are not committed because they may contain app-specific data. The captured screen was visually checked, independently of the launch process exit code.

## Verification still belonging to later tickets

- Issue #3: install/check Maestro and verify execution/report formats for authored YAML.
- Issue #4: supported hierarchy capture, selector bounds and screenshot element picking.
- Issue #5: Mockoon control, dedicated environment copy, fallback, response acknowledgement/reset and available traffic evidence.
- Issue #6: generic screen-triggered default actions and reusable setup; PIN remains an example.
- Issues #7 onward: canvas mapping, YAML editing preservation, multiple scenarios, retries, history/recovery, and API evidence.

No simulator installation, app build, provisioning, Mockoon mutation, or Maestro scenario execution was performed by this slice.

## Checks and review

- TypeScript typechecking and the Vite production build passed.
- The full suite passed: five behavior tests covering ready-device discovery, unconfirmed/confirmed launch evidence, invalid bundle identifiers, retained missing-app failure, and HTTP origin/session/input restrictions.
- The HTTP test reproduces malformed request target `http://[`; the runner now returns 400 instead of rejecting its async handler and crashing.
- `PORT=4318 npm start` served the built production page and reported a connected runner with the ready iPhone 15. The temporary production server was then stopped.
- Independent Standards review found one concrete URL-parsing bug; the regression test reproduced it and the reviewer confirmed the fix. No documented-standard violations remain. A minor three-state display-dispatch duplication was retained as a review judgment tradeoff.
- Independent Spec review found no actionable issue #2 gaps and inspected the real foreground screenshot/result independently.
- The development runner was restarted with the reviewed fix and left available at http://127.0.0.1:4317.

Review baseline: this checkout had no commits, so the staged first implementation was compared to Git's empty tree `4b825dc642cb6eb9a060e54bf8d69288fbee4904`. The original untracked handoff and user-installed skills were excluded from the implementation commit.
