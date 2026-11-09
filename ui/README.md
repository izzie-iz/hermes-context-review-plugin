# Hermes Desktop Context Review Reminder

Optional native-themed UI for the [Hermes Context Review Plugin](../README.md). It displays a compact **Context review suggested** strip immediately above the message composer.

## Install

Install and configure the backend first using the [main setup instructions](../README.md#install-the-hermes-context-review-plugin). The reminder itself does not select or activate a context engine.

For a default-home backend installation and a local Desktop app using the same home:

```bash
mkdir -p "$HOME/.hermes/desktop-plugins/context-review-reminder"
cp -i "$HOME/.hermes/plugins/context-review/ui/plugin.js" \
  "$HOME/.hermes/desktop-plugins/context-review-reminder/plugin.js"
```

For custom homes or a remote backend, copy `ui/plugin.js` from this repository to the **local Desktop app's** `desktop-plugins/context-review-reminder/plugin.js` location. Do not assume the backend's remote or profile-specific directory is the Desktop app's plugin home.

If a file already exists there, inspect it before replacing it. Use a physical copy, not a file symlink: the Desktop watcher may load a symlink initially without noticing later changes to its target.

Hermes Desktop normally hot-loads the file. Check its plugin settings if it is disabled; otherwise use **Reload desktop plugins** from the command palette if needed. Do not override a deliberate disable. Copy the updated file again when updating this separately installed UI.

## Behavior

- Uses the app's focused-chat usage stream, not cumulative token spend or a polling loop.
- Appears at the lower of 250,000 tokens / 60% of the model window, with a second threshold at the lower of 300,000 / 75%.
- **Review now** submits review consent only. Separate version-bound approval is still required before compaction.
- Protects unsent drafts, checks the intended chat after asynchronous draft reads, and refuses to submit while busy.
- **Later** snoozes the UI for another 25,000 active-context tokens. It does not change backend review state.
- Stores choices by connection, profile, and durable chat ID.
- Uses the native composer contribution slot and active theme colors. It does not change the app theme or rewrite the core DOM.

The UI requires the SDK APIs imported and used by `plugin.js`, including `COMPOSER_AREAS.top`, focused usage/state atoms, and exact-session composer submission. Its automated tests use controlled SDK stubs, not a complete Desktop app installation.

## Local diagnostics

Where the Desktop SDK provides `ctx.files`, the plugin writes registration and render receipts in its plugin-local data folder. They include timestamps, chat/profile identifiers, token usage, UI state, and geometry, not conversation bodies. These are local diagnostics, not external telemetry. Do not include them in a public issue without review.

## Test

From the repository root:

```bash
node --check ui/plugin.js
node --experimental-vm-modules --test tests/test_desktop_ui.mjs
```
