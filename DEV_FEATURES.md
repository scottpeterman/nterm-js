# nterm-js — Dev Features

This file tracks features in flight or on deck for the next release cycle.
It lives on the `dev` branch. The public `README.md` reflects shipped
behavior on `main`; this file reflects intent.

When a feature lands on `dev`, its entry moves from *Next Up* / *Planned*
into *Recently Landed*. On release, those entries get absorbed into the
main README's *Features* section and purged from here.

---

## Status Legend

| Symbol | Meaning |
| --- | --- |
| 🟢 | Shipped on `dev`, pending next release |
| 🟡 | In progress |
| ⚪ | Planned, not started |
| ⚫ | Considered but deferred — see reasoning |

---

## Recently Landed on `dev`

### 🟢 Paste Pacing (all transports)

**Files touched.** `src/main/settings.ts`, `src/renderer/index.html`,
`src/renderer/renderer.js`. Zero transport-layer changes.

**Approach.** Pacing lives in the renderer, piggybacking on the
multi-line paste warning dialog. The dialog is already the universal
chokepoint for multi-line content, so a single implementation there
works for SSH, telnet (including reverse-telnet to GNS3 consoles), and
serial with no transport code changes.

**User-visible.** New "Line delay" dropdown in the paste warning dialog
(None / 25 / 50 / 100 / 250 ms) with a live `≈ Xs total` estimate.
Default is read from a new persistent setting `defaultPasteLineDelayMs`
(0–5000ms, default 0), editable in Settings.

**Implementation.** Delay=0 keeps the original `term.paste()` fast path
unchanged, including bracketed-paste-mode (DEC 2004) honoring. Delay>0
bypasses `term.paste()`, splits input on any line terminator, emits each
line plus `\r` through `window.nterm.send()` with `setTimeout(delay)`
between. Matches xterm's own `\n`→`\r` normalization. In-flight state
tracked on `session.pastePacing`. Two cancel hooks: `closeTab` clears
the timer before `term.dispose()`; `updateTabStatus` clears on any
transition out of `connected`.

**Concurrent paste policy.** A second paste arriving while one is
draining gets a "wait or disconnect" message. Queueing was considered
and rejected — cancelling mid-paste leaves half-applied configs.

**Keystroke behavior during paced paste.** Keystrokes go straight
through `onData` → transport. If the user types during a paste, input
interleaves with paced lines. Matches SecureCRT behavior. Deliberately
not buffered/held.

**Validated against.** Arista EOS `banner motd` over 9600-baud serial.
Pacing visibly clean at 50ms / 100ms. SSH fast-path unchanged.

**Known gaps.**
- No in-flight cancel UI. User must close tab or disconnect to bail on
  a long paste. Toast-with-cancel is v2 work.
- Paced path always emits bare `\r`. On a remote with active
  bracketed-paste-mode, `term.paste()` would have wrapped with DEC 2004
  delimiters; the paced path doesn't. In practice the devices that need
  pacing never advertise bracketed-paste, so this hasn't come up.

---

## Next Up (priority order, Scott-confirmed)

### ⚪ Per-tab terminal color

**Scope.** First YAML schema extension. Optional `tab_color: "#rrggbb"`
field on a session. Absent = no color, theme-default tab. Invalid hex =
warning logged, field dropped, session loads anyway.

**Rationale.** Visual blast-radius cue. Prod=red, lab=green, dev=blue.
Peripheral-vision recognition of "what am I about to type into."

**UI.**
- Tab strip: 3px left-border in the session color.
- Viewport: thin colored bar along the top edge, theme-independent.
  Tint-the-whole-viewport (SecureCRT-style) was considered and rejected
  as visually nauseating.
- Session editor: `<input type="color">` with a clear button.
- Quick-connect: `<input type="color">`, not persisted (quick-connect
  sessions aren't saved to YAML).

**Files to touch.** Session YAML loader, session editor dialog,
quick-connect dialog, tab-strip CSS, viewport wrapper markup.

### ⚪ Anti-idle

**Scope.** `TransportManager`-level periodic write. YAML `anti_idle:`
block. Transport-agnostic — applies to SSH, telnet, serial.

**YAML.**
```yaml
anti_idle:
  enabled: true
  interval_sec: 60
  payload: backspace     # named token, not raw escape
```

Tokens: `backspace` (default, `\x08`), `nul` (`\x00`),
`space-backspace` (`\x20\x08`), `custom:<hex>` escape hatch. Storing
raw escape strings in YAML is a footgun across parsers — named tokens
round-trip cleanly.

**Behavior.** Timer resets on every real user keystroke (floor, not
ceiling). Bound to the `connected` state — clears on disconnect,
restarts on reconnect.

**Defaults.** OFF globally, OFF per-session unless explicitly enabled.
Phantom traffic without opt-in is bad for audits.

**Files to touch.** `TransportManager` (base timer + configure hook),
three transport subclasses (connect/disconnect state transitions), YAML
loader, session editor, settings dialog.

**First cross-cutting change.** Touches all three transports + YAML +
two UI dialogs. Good test for the next-tier changes that will also span
everything.

---

## Planned (priority order, unscheduled)

### ⚪ Host key verification

Biggest real security gap. Current `ssh2.ConnectConfig` has no
`hostVerifier`, so any host key is accepted silently. New
`hostKeyStore.ts` (SQLite table adjacent to the vault) provides a
known_hosts equivalent. Three trust policies: *Strict* (reject
mismatch), *TOFU* (trust-on-first-use, prompt on mismatch —
default), *Promiscuous* (current behavior, lab escape hatch). Known
Hosts manager dialog for inspection / deletion.

### ⚪ Vault idle auto-lock

Timer-based DEK wipe after N minutes of inactivity. Reset on vault
read / write / unlock. Status-bar lock indicator. New setting
`vaultAutoLockMinutes` (0 = never, the current behavior). Broadcasts
`vault:locked` IPC on fire.

### ⚪ Vault audit log

Append-only table in `vault.db`:
`{timestamp, action, credential_name, host}`. Covers the "did this app
ever read prod creds on my laptop" question. Inside the vault so it
can't be tampered with while locked.

### ⚪ SSH agent forwarding

Add `agentForward: boolean` to `SSHConnectionConfig`, pass through to
`ssh2.shell({ agentForward: true })`. Per-session, off by default
(forwarding is dangerous). "Advanced" collapsible in session editor.
Essential for real jump host workflows.

### ⚪ Jump host (ProxyJump / `-J` equivalent)

New `JumpSSHManager` composing two `ssh2.Client` instances under one
`TransportManager` subclass. Outer client's `forwardOut()` provides the
`sock` for the inner client. Vault schema already reserves the fields
(`jumpHost`, `jumpUsername`, `jumpAuthMethod`, `jumpRequiresTouch`) —
no vault schema change needed.

Single-hop only for v1. Nested jumps (`-J b1,b2,b3`) deferred. Both
hops get separate host-key-store entries. Prefix status messages
`[jump]` or `[target]` so hang locations are visible.

Surfaced in session editor only; jump hosts belong in saved sessions,
not quick-connect.

### ⚪ Scrollback search

`xterm-addon-search`. Drop-in. Ctrl+F.

### ⚪ Clickable URLs

`xterm-addon-web-links`. Drop-in.

### ⚪ Terminal bell handling

`onBell` → flash tab background. Useful for noticing long command
completion on a tab you've tabbed away from.

### ⚪ Session logging with timestamped default filenames

`{session_name}_{YYYY-MM-DD_HHMMSS}.log` in a configurable directory.
Already in the public README's "Next" list.

### ⚪ Connection rate limiting for bulk connect

100–200ms stagger between session opens when opening a whole folder.
Protects TACACS / AAA from accidental DDoS when a folder has 50
sessions.

### ⚪ Command broadcast to a tab group

"Send to selected tabs" where the selection is explicit, never "all
tabs." All-tabs-by-default is terrifying with prod sessions open.

---

## Deferred — not planned

| Feature | Why not |
| --- | --- |
| ⚫ SFTP / SCP | Different UI paradigm, well-solved elsewhere. Not without commitment. |
| ⚫ Scripting / macro system | nterm-ng handles this. Product specialization. |
| ⚫ Tab split-panes | Renderer complexity explodes for marginal gain. Users who want tmux run tmux. |
| ⚫ Cloud session sync | Violates the per-OS-user no-cloud stance. Wrong threat model. |
| ⚫ "Everything SecureCRT does" | Explicit non-goal. 80/20 ships; feature-parity rot doesn't. |

---

## Branching

- **`main`** — released code. Matches the public README.
- **`dev`** — integration branch for in-flight features. This file
  lives here. Feature branches for multi-commit work branch off `dev`
  and PR back.
- **Release** — `dev` → `main` merge, tag, publish installers.
  Recently-Landed entries fold into the main README; this file resets
  to only what's still pending.

Initial setup:

```
git checkout main
git checkout -b dev
# move this file onto dev
git add DEV_FEATURES.md
git commit -m "dev: feature tracker for in-flight work"
git push -u origin dev
```

Day-to-day:

```
# Start a feature
git checkout dev && git pull
git checkout -b feat/tab-color

# Land it
git checkout dev && git merge --no-ff feat/tab-color
# update this file: move the entry to Recently Landed, add impl notes
git commit -am "dev: tab color landed, updating tracker"
git push
```

Release:

```
git checkout main && git merge --no-ff dev
git tag v0.3.0
git push --follow-tags
# on dev: trim Recently-Landed entries that shipped to main
```