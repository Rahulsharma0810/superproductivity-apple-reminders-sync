# Apple Reminders Sync

Bidirectional sync between **SuperProductivity** and **Apple Reminders**, powered by
the [`remi`](https://github.com/mattheworiordan/remi) command-line tool.

Create a task in SuperProductivity and it appears in Apple Reminders — which then
syncs to your iPhone, iPad, Mac, and Apple Watch through iCloud. Check something
off on your phone and it comes back into SuperProductivity on your desktop.

> **macOS + desktop only.** This plugin shells out to the `remi` binary through
> SuperProductivity's Node execution bridge, so it runs on the **desktop
> (Electron) app on macOS only**. It is inert on the web/mobile/PWA builds
> (the config screen shows a "desktop only" notice).

---

## How it works

- **Outbound (SP → Apple)** is event-driven: task changes are picked up via the
  `anyTaskUpdate` hook, debounced, then pushed to Reminders.
- **Inbound (Apple → SP)** is **poll-based**. Apple Reminders has no change
  notifications, so the plugin periodically runs `remi list <list>` and diffs
  the result. Inbound changes are therefore **not instant** (default poll:
  ~30s when the window is focused, ~2min when unfocused).
- Tasks and reminders are correlated by a **device-local id map** plus a hidden
  `[sp:<taskId>]` marker written into the reminder's notes as a fallback.
- Anti-oscillation guards (mirroring the `sync-md` plugin) prevent an inbound
  write from bouncing straight back out: an in-progress guard, a post-inbound
  cooldown that suppresses the SP change hook, and debounced outbound writes.

Conflicts are resolved **last-writer-wins, per field**.

---

## Prerequisites

### 1. Install `remi`

```bash
# Homebrew (recommended)
brew install mattheworiordan/tap/remi

# …or build from source — see https://github.com/mattheworiordan/remi
```

Verify it runs:

```bash
remi --version
remi doctor
```

### 2. Grant Reminders access

`remi` talks to the macOS Reminders database on behalf of whichever app launched
it. When run from this plugin, **that app is SuperProductivity** (Electron).

1. Open **System Settings → Privacy & Security → Reminders**.
2. Enable access for **SuperProductivity** (and, if you also run `remi` from a
   terminal, for your terminal app — Terminal / iTerm / etc.).
3. **For section (tag) support:** also grant **Full Disk Access** to the same
   app under **Privacy & Security → Full Disk Access**. Sections are an
   advanced Reminders feature that requires it; without it, tag→section mapping
   degrades gracefully and everything else keeps working.
4. Authorize once from a terminal:

   ```bash
   remi authorize
   ```

5. **Restart SuperProductivity** so it picks up the new permission.

If access is missing, the plugin's config screen shows a red banner and sync
pauses with an actionable snackbar instead of failing silently.

---

## Installing the plugin

This is a standalone, uploadable plugin — no changes to SuperProductivity core
are required. **You do not need to clone this repo or run any build tools.**

1. Go to the [**Releases**](https://github.com/Rahulsharma0810/superproductivity-apple-reminders-sync/releases/latest)
   page and download the latest **`sync-reminders-v<version>.zip`** from the
   **Assets** section.
2. In SuperProductivity: **Settings → Plugins → Load plugin from file** and
   select the downloaded `.zip`.
3. Approve the Node-execution consent prompt when asked. For uploaded plugins
   this is **ask-once and remembered** for the plugin.
4. Open the plugin's config screen (its entry in the side menu / plugin list).

> Developers who want to build from source can follow [Building](#building)
> instead, but this is not required for normal use.

---

## Configuration

The config screen (an iframe UI) lets you set:

| Setting | Meaning |
| --- | --- |
| **Enable sync** | Master on/off switch. |
| **Mappings** | One or more **SP project ↔ Apple Reminders list** pairs. Pick a project from the dropdown and a list (dropdown when lists load, free-text otherwise). Add as many pairs as you like. |
| **Sync estimates in notes** | Write `[estimate: 2h]` into the reminder's notes so the time estimate round-trips. |
| **Sync tags as sections** | Put each task under an Apple Reminders **section** named after the task's **first tag**. Requires Full Disk Access. |
| **remi binary path** | Optional. Leave blank to use `remi` from `PATH`; set an absolute path (e.g. `/opt/homebrew/bin/remi`) if it isn't found. |

Buttons: **Save** (persists config and re-initialises sync), **Sync now**
(runs a full pass immediately), **Check connection** (runs a health check and
reports permission status).

Configuration is stored **device-local** (`localStorage`). Only the tiny mapping
config is local — your actual task **data** flows to all your devices via
Apple/iCloud. (The `remi` binary only exists on this Mac, so a config that only
makes sense here stays here.)

---

## Field mapping

| SuperProductivity | Apple Reminders | Notes |
| --- | --- | --- |
| Title | Title | Two-way. |
| Notes | Notes | Two-way. Hidden markers are appended to the reminder and **stripped** before notes are shown back in SP. |
| Done state | Completed | Two-way. |
| `dueDay` (date) | Due date | Two-way. |
| `dueWithTime` (date **+ time**) | Due date (**date only**) | Outbound only. remi/Reminders store **no time-of-day** here — the time is dropped on the Apple side. Inbound never overwrites an existing SP time unless the **day** actually changed. |
| Time **estimate** | `[estimate: 2h]` in notes | Two-way, if "Sync estimates" is on. |
| Time **spent** | — | **SP-only.** No Reminders equivalent. |
| Recurrence (repeat cfg) | Recurrence rule | **Outbound, at create time.** `remi` fully supports recurrence, but its CLI only accepts `--repeat` on `add` (not `update`), so the rule is set when the reminder is first created and changing it later isn't pushed. Inbound recurring reminders become a **plain task + `[repeats: <rule>]` note** plus a one-time hint — see limitations. |
| First tag | Section | If "Sync tags as sections" is on. Needs Full Disk Access. Inbound sections become/join a tag of the same name. |
| Links / URLs | (in notes) | Kept inside the notes body. |
| Priority | — | Ignored. SP tasks have no first-class priority field; outbound priority is always `none`, inbound priority is ignored (to avoid tag pollution). |
| Subtasks | — (flattened) | `remi` has no subtask concept; SP subtasks are synced as **top-level** reminders. |
| Flagged | — | Ignored. |

### Hidden note markers

The plugin appends these to a reminder's notes (and removes them before writing
notes back into SP):

- `[sp:<taskId>]` — always present; the correlation fallback.
- `[estimate: 2h]` — when a time estimate is synced.
- `[repeats: <rule>]` — preserves a recurrence rule imported from Apple that SP
  can't natively recreate.

---

## Limitations

- **Desktop macOS only.** Needs the Electron app + the `remi` binary.
- **No time-of-day on the Apple side.** Reminders due dates are date-only here;
  an SP due *time* is not represented in Apple. (SP keeps its own time; the
  plugin only touches SP's due when the **day** differs.)
- **Recurrence is one-way and set at creation.** `remi` itself fully supports
  recurring reminders, so a repeating SP task **is** created as a repeating Apple
  reminder. The limits are: (1) `remi`'s CLI only accepts `--repeat` on `add`, so
  editing an SP task's recurrence afterward isn't pushed to an existing reminder
  (tracked upstream in [remi#3](https://github.com/mattheworiordan/remi/issues/3));
  and (2) the SuperProductivity **plugin API has no way to create a repeat
  configuration**, so a recurring Apple reminder coming *back* into SP is imported
  as a normal task with a `[repeats: …]` note and a one-time suggestion to set up
  recurrence manually.
- **Subtasks are flattened** to top-level reminders.
- **Time spent is not synced** (SP-only).
- **Priority is ignored.**
- **Sections (tag mapping) need Full Disk Access;** without it, that one feature
  degrades and the rest keeps working.
- **Inbound is polling-based**, so changes made on another device appear after
  the next poll, not instantly.

---

## Building (for contributors)

Normal users should [install from Releases](#installing-the-plugin) instead —
this section is only for developing or modifying the plugin.

```bash
git clone https://github.com/Rahulsharma0810/superproductivity-apple-reminders-sync.git
cd superproductivity-apple-reminders-sync
npm install          # once
npm run build        # bundle -> dist/plugin.js (+ manifest, index.html, icon)
npm run package      # zip dist/ -> sync-reminders-v<version>.zip
```

Other scripts:

```bash
npm test             # jest unit tests
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm run watch        # rebuild on change
```

> **Type definitions are vendored.** SuperProductivity injects the `PluginAPI`
> global at runtime, so this repo only needs the API's *type declarations*. They
> live in `types/plugin-api/` and are wired up via a `file:` dependency — no
> extra build step, nothing fetched from npm for the API surface.

---

## Releasing

This project is **pre-1.0 (`0.x`)**, so every release is published as a GitHub
**prerelease**. Releases are fully automated by GitHub Actions
([`.github/workflows/release.yml`](.github/workflows/release.yml)) — you never
pick a version number by hand, create tags manually, or upload artifacts.

### Cut a release

Releases are triggered **manually** so one can never fire by accident from a
routine push. From the GitHub UI:

**Actions** tab → **Release** → **Run workflow** (on `main`).

Or from the CLI:

```bash
gh workflow run release.yml --ref main
```

The **Version bump** input defaults to `auto` (derive it from Conventional
Commits, below). You can override it with `patch` or `minor` to force a specific
bump regardless of commit messages.

### How the version is chosen (Conventional Commits)

With bump = `auto`, the workflow finds the latest `v*` tag, inspects every commit
since it, and bumps automatically. Because the project is `0.x`, it **never bumps
the major** — breaking changes bump the minor instead (SemVer's pre-1.0
convention):

| Commits since last tag                       | Bump    | Example         |
| -------------------------------------------- | ------- | --------------- |
| `feat!:` / `refactor!:` / `BREAKING CHANGE:` | minor   | `0.1.2 → 0.2.0` |
| `feat:`                                       | minor   | `0.1.2 → 0.2.0` |
| `fix:` / `chore:` / `docs:` / anything else   | patch   | `0.1.2 → 0.1.3` |

On the **first** release (when no `v*` tag exists yet and bump = `auto`) the
workflow ships the version currently in `package.json` as-is, with no bump.

### What the workflow does

1. Computes the next `X.Y.Z` from commit history (above).
2. Writes it into **both** `package.json` and `src/manifest.json`.
3. Runs `typecheck` + `test` + `package`.
4. Creates the `vX.Y.Z` tag and publishes a **prerelease** with
   `sync-reminders-vX.Y.Z.zip` attached and auto-generated notes.

> The version bump is applied only inside the built artifact and the tag — it is
> **not** committed back to `main`. The next release computes its base from the
> latest tag, so `main` never drifts out of sync with what was released.

Every push to `main` and every pull request also runs
[`.github/workflows/ci.yml`](.github/workflows/ci.yml) (typecheck, lint, test,
package) to keep `main` releasable.

---

## Troubleshooting

- **"Node script execution is not available (desktop only)."** — You're on the
  web/PWA build, or Node execution isn't granted. Use the desktop app and
  approve the consent prompt.
- **"Reminders access is denied."** — Grant Reminders access to SuperProductivity
  in System Settings, run `remi authorize`, and restart the app.
- **`Could not run "remi"`** — The binary isn't on `PATH`. Set an absolute path
  in the config's "remi binary path" field.
- **Tags aren't creating sections** — Grant Full Disk Access to
  SuperProductivity, then restart.
- **A change isn't syncing immediately** — Inbound is polled; hit **Sync now**
  to force a pass.
