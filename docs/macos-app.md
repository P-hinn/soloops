# Running as a macOS app

Instead of living in a browser tab, soloops also runs as a standalone app with
a dock icon, a menu bar and a tray item — a [Tauri](https://tauri.app) window
onto the same interface, around 10 MB, using the macOS WebView rather than
shipping its own Chromium.

```bash
npm run app          # start the app in development mode
npm run app:build    # build soloops.app and a DMG
```

The result lands in
`apps/desktop/src-tauri/target/release/bundle/macos/soloops.app` — drag it to
`/Applications` once and you're done.

**What the app adds on top of the web UI:**

- **Starting the containers itself.** On launch it checks whether web and API
  respond. If they don't, it starts Docker Desktop and runs
  `docker compose up -d`; the splash screen reports what it is waiting for.
  Closing the window leaves the containers running so the worker keeps syncing
  calendars and mail — quit them from the tray menu.
- **Keyboard shortcuts.** ⌘1 to ⌘9 jump to the modules, ⌘R reloads,
  ⌘⇧M fetches the inbox, ⌘⇧P opens the port overview.
- **Port overview** (⌘⇧P or tray). The same thing as `npm run ports`, in a
  window: which service listens on which port, where it comes from, and a
  button to stop it. The app shells out to [`scripts/ports.sh`](../scripts/ports.sh)
  for this — the logic exists in exactly one place.
- **Activity recording.** One sample every 20 seconds: which app is in front,
  what its window is called, how long nobody has typed. Off by default — the
  checkbox sits in the tray and under _Ansicht_ and takes effect immediately.
  On first run macOS asks for **Accessibility** permission (System Settings >
  Privacy & Security); without it, nothing is recorded. Details under
  [Activity](activity.md).
- **Follow-up reminders.** A lead whose follow-up falls due becomes a macOS
  notification — once per date, and only between 8 and 22. Details under
  [Follow-ups](inbox.md#follow-ups).
- **Connecting Claude.** _Einstellungen → Claude_ writes the MCP connector into
  Claude Desktop and Claude Code with one click. Only the app can do this: the
  API runs in a container and has no home directory to write into. Details
  under [MCP server](mcp.md#connecting).
- **Tray menu.** Show window, fetch inbox, ports, activity on/off, stop
  containers, quit.

Building requires the Rust toolchain ([rustup](https://rustup.rs)) and the
Xcode command line tools. The path to the repository is baked in at build time;
if the directory moves, either rebuild the app or start it with `SOLOOPS_DIR`.

The loaded interface gets as good as **no** access to Tauri APIs (see
[`capabilities/default.json`](../apps/desktop/src-tauri/capabilities/default.json)):
it is the same web app as in the browser, just in a different frame. Menu, tray
and container startup run entirely in Rust.

The single exception is the Claude connection
([`capabilities/claude.json`](../apps/desktop/src-tauri/capabilities/claude.json)):
there the interface may call exactly three commands — read the status, write the
connector, restart Claude Desktop. The commands are listed in
[`build.rs`](../apps/desktop/src-tauri/build.rs), because Tauri treats a page under
`http://localhost` as a remote origin and allows nothing there that no
capability names. Anything beyond those three stays with the menu and Rust.
