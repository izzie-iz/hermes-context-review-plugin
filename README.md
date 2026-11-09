# Hermes Context Review Plugin: Human-Approved Context Compaction

**Human-approved context compaction for Hermes Agent.** Review what your AI carries forward before a long conversation is compressed.

This community plugin adds an evidence-grounded context review workflow to [Hermes Agent](https://github.com/NousResearch/hermes-agent): clarify important ambiguities, inspect a structured handoff, and approve that exact version before compaction. It includes active-context token reminders and an optional Hermes Desktop reminder above the message box.

**Status: experimental · Plugin version: 0.1.1 · Tested with Hermes Agent 0.23.0.** This is an independent project, not an official Nous Research plugin.

## Why review context before compaction?

Long-running AI conversations accumulate decisions, repeated explanations, abandoned ideas, tool results, and unfinished work. A useful context handoff needs to distinguish what you actually approved from what the assistant merely suggested.

Instead of immediately replacing earlier context with an automatic summary, this plugin gives you a review step:

1. **Start a review.** Ask Hermes to review the current conversation.
2. **Resolve meaningful ambiguities.** The assistant asks one source-grounded question at a time, only when an answer changes what should survive.
3. **Inspect the handoff.** Review the objective, active work, decisions, constraints, artifacts, open questions, and next actions.
4. **Approve a specific version.** Send the exact approval phrase shown with that proposal.
5. **Continue with compacted context.** Hermes applies the approved handoff through its native context engine, retaining the conversation after the review snapshot.

A request to review is **not** permission to compact. A generic “yes” is not cleanup approval.

## Features

- **Version-bound approval:** approval is tied to the reviewed source, clarifications, and proposed handoff. A changed proposal needs fresh approval; changed source history invalidates the old approval.
- **Evidence-grounded clarification:** initial questions require matching conversation quotes. Follow-ups can reference a previously answered question.
- **Active-context reminders:** reminder thresholds use the current input context, not cumulative session token spend.
- **Profile and session isolation:** review state persists locally and is separated by active Hermes profile and session.
- **Original-history retention:** compaction changes the active context through Hermes' native lifecycle, without deleting the original session evidence.
- **Optional Desktop UI:** a compact, native-themed strip offers **Review now** and **Later**, follows the focused chat, and protects unsent drafts.
- **No extra Python dependencies:** the backend uses the standard library plus APIs supplied by your Hermes installation.

This is not a promise of lossless summarization. The model and the human still need to judge whether the proposed handoff preserves the right information.

## Requirements and compatibility

| Component | Requirement |
| --- | --- |
| Hermes Agent | Manifest declares `>=0.22.5`; integration tests run on `0.23.0`. Older-version admission tests do not establish full compatibility with every release. |
| Context engine | Select `context-review`. Installing the plugin alone does not select the engine. |
| Tool availability | Enable the `context_engine` toolset for each surface where you use the review tool. |
| Codex transport | Use `codex_responses`, not `codex_app_server`. The plugin rejects app-server because it can compact outside this review boundary. |
| Desktop reminder | Optional; requires the Desktop SDK APIs used in [`ui/plugin.js`](ui/plugin.js), including focused usage and exact-session composer submission. |

Only one context engine can be selected at a time. If you already use a different custom engine, evaluate the trade-off before replacing it.

## Install the Hermes context review plugin

### 1. Download without activating

```bash
hermes plugins install izzie-iz/hermes-context-review-plugin --no-enable
```

The manifest names the installed backend `context-review`, so its default location is `~/.hermes/plugins/context-review/`. With a custom Hermes home, it is `$HERMES_HOME/plugins/context-review/`.

For a named profile, use `hermes -p <profile> plugins install ... --no-enable` and apply the remaining settings to that same profile.

### 2. Configure reviewed compaction

**These settings intentionally replace automatic compaction with approval-gated review.** Inspect your existing configuration first. If you defer review until the context window is full, the provider may refuse another request rather than the plugin silently compacting it.

Use the supported CLI to set individual keys:

```bash
hermes config set compression.enabled true
hermes config set compression.in_place true
hermes config set compression.micro_compact false
hermes config set compression.prepare_ahead false
hermes config set compression.codex_responses_native false
hermes config set compression.proactive_prune_tokens 0
hermes config set compression.idle_compact_after_seconds 0
hermes config set compression.codex_app_server_auto off
hermes config set context.engine context-review
```

**Codex users only:** also select the supported transport:

```bash
hermes config set model.api_mode codex_responses
```

Do not apply that transport setting to unrelated providers.

Enable both the general plugin and its toolset:

```bash
hermes plugins enable context-review --no-allow-tool-override
hermes tools enable context_engine --platform cli
```

Repeat the toolset command with the platform name used by your intended surface. For a named profile, prefix each command with `hermes -p <profile>`; do not assume the default profile's settings are inherited.

Both loading paths matter: selecting the engine enables context management, while enabling the general plugin registers its pre-call hook and registry-backed tool.

### 3. Validate and check the conversation

```bash
hermes plugins doctor context-review --ci
hermes plugins validate context-review --json
```

Resume the same conversation through Hermes' supported session-resume flow if an already-running agent predates activation. Do not reset or delete the conversation. Plugin reload alone may not replace a cached agent or refresh an existing session's tool policy.

Ask Hermes to check `context_review` with `action: status`. Confirm the selected engine is `context-review` and `engine_initialized` is true before relying on it.

## How to use context review

Ask in your conversation:

> Review this chat's context. Ask one question at a time only if needed, then show me the handoff before compacting.

Hermes reviews the actual conversation, asks for clarification where needed, and proposes these sections:

| Handoff section | What it preserves |
| --- | --- |
| Objective | What you are trying to accomplish |
| Active work | Work still in progress |
| Decisions | Adopted decisions, with approval status distinguished from suggestions |
| Constraints | Scope, permissions, and rules that still apply |
| Artifacts | Exact paths, identifiers, and relevant outputs |
| Open questions | Unresolved information, not invented answers |
| Next actions | What should happen next |
| Remove from active | What can leave active context, not what to delete from history |

After inspecting the complete proposal, send the phrase Hermes provides:

```text
approve context cleanup <version>
```

Replace `<version>` with the actual proposal version. The placeholder itself is not approval. Approval is matched against that proposal's phrase; tool calls, manual `/compress`, and `force=True` do not grant it.

The engine reports the handoff as **applied** only after Hermes confirms the native compression boundary. A proposal or approval alone is not proof of completed compaction.

### Pause, snooze, or inspect

The `context_review` tool supports:

| Action | Purpose |
| --- | --- |
| `status` | Inspect review phase and state |
| `start` | Begin reviewing the current conversation |
| `inspect` | Read indexed source excerpts from the reviewed snapshot |
| `ask` | Stage one grounded clarification question |
| `propose` | Prepare or revise the structured handoff |
| `pause` / `resume` | Suspend and continue a review |
| `later` | Snooze backend reminders for another 25,000 active-context tokens |
| `dismiss` | Suppress reminders for the session; the review can be resumed explicitly |

You can request these actions conversationally. There is no tool action that approves cleanup on your behalf.

## Active-context token reminders

The backend offers a reminder on a subsequent user turn when the latest provider-reported prompt usage reaches a threshold:

| Reminder | Threshold |
| --- | --- |
| First | Lower of 250,000 tokens or 60% of the model's context window |
| Second | Lower of 300,000 tokens or 75% of the model's context window |

These are turn-boundary reminders, not idle-time notifications or exact real-time interrupts. If the provider omits prompt usage, the backend does not currently estimate it. The Desktop component separately consumes the app's focused-usage data and can label estimated usage when the host supplies it.

## Optional Hermes Desktop reminder

The Desktop component adds a small strip immediately above the message composer:

```text
Context review suggested          [Review now]  [Later]
```

**Review now** sends a review request to the intended chat, not an approval phrase. It refuses to overwrite an unsent draft and waits while the chat is busy. **Later** snoozes the UI reminder for another 25,000 active-context tokens.

See [Desktop reminder installation and behavior](ui/README.md). The backend works without this UI. UI-local snoozing does not change backend reminder or approval state.

## Privacy and session history

Backend review state is stored in:

```text
$HERMES_HOME/plugin-data/context-review/state.sqlite3
```

It contains message fingerprints, clarification questions and answers, proposals, and workflow state. It is not a second full transcript archive, but questions, quotes, and proposals can still contain sensitive conversation details. Keep it private.

The plugin uses the active profile's home and the dispatcher's trusted session identity. The registry adapter reads only that session's active transcript through Hermes' read-only session API. It does not accept model-selected profile, session, or database overrides.

The current conversation's model performs the review. There is no separate background summarizer or additional model call just to trigger a token reminder. Review messages still use your normal model and provider.

The review workflow does not write permanent memories, skills, or vault notes as a side effect. Original transcript retention depends on Hermes' native session storage; this plugin does not provide a separate backup service.

## Tests and validation

Run from this repository using the Hermes runtime and Node.js for the optional UI tests:

```bash
hermes --run-module unittest discover -s ./tests -p 'test_review.py' -v
hermes plugins doctor . --ci
hermes plugins validate . --json
node --check ui/plugin.js
node --experimental-vm-modules --test tests/test_desktop_ui.mjs
```

The backend fixtures require `TMPDIR` to point to an existing writable temporary directory. If your environment does not set it, set it before running the suite.

The initial publication was checked with **15 backend tests and 8 Desktop UI tests** on Hermes Agent 0.23.0. Coverage includes version-bound human approval, source drift, proposal revision, grounded questions, profile/session isolation, restart persistence, native loader and tool dispatch, original-history retention, the real agent compression lifecycle, focused-chat routing, draft protection, and UI reminder state.

Tests use isolated synthetic sessions. They do not compact your production chats or make paid model requests. Native Hermes integration fixtures can emit auxiliary-model, deprecation, and process-cleanup warnings; passing fixtures are not evidence of live provider compatibility.

## Limitations

- Experimental, with no full compatibility matrix across Hermes releases, operating systems, or model providers.
- A real 250,000-token conversation and unattended production cleanup have not been exercised by this suite.
- Source matching and approval gates are deterministic; handoff completeness and the usefulness of clarification still depend on model judgment and human review.
- No automatic fallback compaction if you decline. Review while there is enough context headroom to complete it.
- Codex app-server transport is unsupported. Competing native pruning or compaction paths must remain disabled as documented above.
- The optional Desktop UI is installed separately and is not automatically activated by installing the backend.

## Project structure

```text
hermes-context-review-plugin/
├── __init__.py                 # Context engine, review tool, and safety hook
├── plugin.yaml                 # Hermes plugin manifest
├── README.md
├── ui/
│   ├── plugin.js               # Optional Desktop composer reminder
│   └── README.md
└── tests/
    ├── test_review.py          # Backend and native host contract tests
    └── test_desktop_ui.mjs     # Desktop behavior tests with SDK stubs
```

## Reporting issues

[Open an issue](https://github.com/izzie-iz/hermes-context-review-plugin/issues) with your Hermes version, model/provider transport, affected surface, relevant plugin settings, and reproduction steps. Redact session identifiers and private conversation content before sharing logs or state.

For the host extension contracts, see the official [Context Engine Plugins](https://hermes-agent.nousresearch.com/docs/developer-guide/context-engine-plugin) and [Hermes Plugins](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins) documentation.

## License

A license has not yet been selected for this repository.
