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
  ⌘⇧M fetches the inbox, ⌘⇧P opens the port overview, ⌘⇧Z shows the time
  widget.
- **Port overview** (⌘⇧P or tray). The same thing as `npm run ports`, in a
  window: which service listens on which port, where it comes from, and a
  button to stop it. The app shells out to [`scripts/ports.sh`](../scripts/ports.sh)
  for this — the logic exists in exactly one place.
- **Time widget** (⌘⇧Z or tray). A frameless pill on top of everything: a dot
  that says whether the clock runs, the project key, the elapsed time. The
  whole pill is handle and switch at once — drag it and it moves, click it and
  it folds out; what tells the two apart is whether the pointer travelled more
  than four pixels. Letting go snaps it to the nearest of eight resting places
  — the four corners and the middle of the four edges — so it lands out of the
  way instead of in the middle of what is being read. Where it sat, whether it
  was unfolded and whether it was on at all survive a restart in
  `data/tracker.json`.

  **It also stays on the screen it was dropped on.** That needs saying,
  because the obvious implementation gets it wrong: tao reports a monitor's
  position as its bounds times _that monitor's_ backing scale, and a window's
  position times the scale of the screen the _window_ is on. Put a 2× laptop
  display next to a 1× monitor and those two numbers are no longer in the
  same coordinate system — so the geometry in `tracker.rs` is done entirely
  in points, the screen a widget belongs to is the one containing its
  **centre**, and the name of that screen is remembered in
  `data/tracker.json`. A monitor that has been unplugged is simply gone, and
  then the first screen takes over.

  It stays where it is put: it joins every space rather than waiting on the
  one it was opened on, and a thread brings it back whenever macOS has hidden
  it along with the rest of the app (⌘H, "Hide Others"). That thread keeps its
  hands off while the widget is being dragged — macOS reports a window
  crossing a screen boundary as hidden for a moment, and answering that by
  snapping it back to its anchor every three seconds is what a flickering
  widget looks like. The one thing that
  still covers it is another app's fullscreen window. Switching it off is a
  decision and stays one — the button for that sits inside the unfolded panel,
  not next to the fold arrow where a misclick used to make it look crashed.

  Unfolded it lists the active projects by client with the hours that are not
  on an invoice yet; one click starts the clock. While it runs it shows the
  commits that have landed in the window so far — the ones that will become
  the service description on the invoice, see
  [Modules](modules.md). Stopping is one button; the commits are filled in a
  few minutes later, because the push comes after the clock.

  The widget talks to the API through Rust and never sees the `SERVICE_TOKEN`.
  Its commands hang off that one window
  ([`capabilities/tracker.json`](../apps/desktop/src-tauri/capabilities/tracker.json)):
  read the timer, start it, stop it, read the project list, read the commits of
  an entry, fold, snap, disappear. Nothing else, and no other window.

- **Backup into iCloud** (_Ansicht → Backup & iCloud …_ or tray). One archive
  per run holding a `pg_dump` of the database and a copy of `data/`, written
  into a folder that syncs itself — iCloud Drive by default
  (`~/Library/Mobile Documents/com~apple~CloudDocs/soloops-backup`), any other
  folder if one is chosen. Off until a folder is confirmed; once on, every 24
  hours by default, keeping the newest 14 archives.

  **The database itself stays local, deliberately.** Pointing Postgres at a
  synced folder loses it: iCloud writes when it feels like it, evicts files it
  believes are cold, and resolves a conflict by keeping both versions side by
  side. The failure does not show up on the day it is caused — it shows up
  weeks later as a cluster that will not start. Snapshots into that folder
  cannot corrupt what they copy.

  The archive is built under `.<name>.part` and renamed into place at the very
  end, because iCloud starts uploading the moment a file appears. A dump of
  under a kilobyte is treated as a failed run and thrown away — otherwise a
  stack that was not running would rotate away fourteen good snapshots over
  fourteen days. A failed run leaves the timestamp where it was, so the next
  tick tries again instead of waiting out the interval.

  **Onto a new Mac:** clone the repository, copy the `.env`, `npm run up`, then
  open this window and restore the newest archive. Restoring overwrites what is
  there — the button arms on the first click and does it on the second, like
  the port window's. Files go back first and the database last, and afterwards
  the interface needs a reload (⌘R). Settings and status live in
  `data/backup.json`; the window's commands hang off that one window
  ([`capabilities/backup.json`](../apps/desktop/src-tauri/capabilities/backup.json)),
  and `pg_dump`, `tar` and `psql` run in Rust — the page knows neither the
  `.env` nor the database.

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
- **Tray menu.** Show window, fetch inbox, ports, backup, time widget on/off,
  activity on/off, stop containers, quit.

A menu item is handled **once**, by the handler on the builder. Tauri keeps one
list of menu listeners for the whole app and calls every one of them for every
event, wherever the menu sits, so a second handler on the tray icon would run
each click twice — which for the two check marks is the difference between
switching and not switching.

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
