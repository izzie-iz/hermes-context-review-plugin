# Hermes Context Review Plugin

A [Hermes Agent](https://github.com/NousResearch/hermes-agent) plugin that lets you review and approve context compaction before it happens.

The idea isn't exactly groundbreaking: before the agent compresses a long conversation, it should check what still matters, ask me if something is unclear, and show me what it's going to keep. Then I decide whether to go ahead.

**Experimental. I'm going to use this in my own work and see whether it helps.**

## Where the idea came from

I was inspired by Drew Breunig's [The State of Context Engineering](https://www.dbreunig.com/2026/10/24/the-state-of-context-engineering.html). He talks about watching context size rather than filling the whole window, and checking what's relevant before compacting. Around 200k–300k tokens is where he starts paying attention; he gives an example of resetting before a big new job.

That made me want to try this in my own workflow. I also remember seeing a token readout around 500k while using GPT-6.1 Sol, which got me thinking about how much of a long chat I still needed.

My version adds a conversation before compaction. If we've changed direction, left something unresolved, or discussed an idea without agreeing to it, I want a chance to clear that up before it becomes part of the summary.

Drew's post is the inspiration, not evidence that this plugin improves results.

## What I'm going to test

I'm going to use it for marketing work and general tasks, then compare the results with how I worked before.

For marketing, that means research, positioning, content drafts, and revisions. For general tasks, it means planning, troubleshooting, and longer conversations where the task changes as we go.

I'm looking for a few practical things:

- Does the agent keep the decisions I made, without treating every suggestion as something I approved?
- Do I spend less time repeating context or correcting things we've already discussed?
- Are the drafts, recommendations, and completed tasks better than before?
- Is reviewing the handoff worth the extra time, or does it mostly add friction?

I don't have results yet. A smaller token count isn't enough on its own; I want to see whether the work gets better.

## How it works

Ask Hermes:

> Review this chat's context. Ask me one question at a time if anything needs clearing up, then show me what you want to keep before compacting.

The agent reviews the conversation. If something important is ambiguous, it asks one question and waits for your answer before deciding what to ask next. If nothing needs clarifying, it can go straight to the proposed handoff.

That handoff covers the goal, work in progress, decisions, constraints, exact file paths or other artifacts, open questions, next steps, and what can leave active context.

You read it, request changes if needed, then send the exact phrase it gives you:

```text
approve context cleanup <version>
```

Use the actual version from your proposal. Saying "yes" or asking for a review doesn't approve compaction. If the proposal changes, it needs new approval. If the reviewed history changes, the old approval is invalidated.

Hermes applies the approved handoff through its native context engine and keeps the messages that came after the review snapshot. The plugin only marks it as applied after Hermes confirms the compaction was committed.

Original session history stays in Hermes. This changes what the agent carries in active context, not what you keep as conversation history. It doesn't save permanent memories, skills, or vault notes as part of the review.

## Install the plugin

Version `0.1.1` has been tested with Hermes Agent `0.23.0`. The manifest allows `>=0.22.5`, but I haven't verified every release, provider, or operating system. This is a community plugin, not an official Nous Research project.

It uses Hermes' APIs and the Python standard library, with no extra Python dependencies.

### 1. Download it

```bash
hermes plugins install izzie-iz/hermes-context-review-plugin --no-enable
```

This installs the backend as `context-review`, normally under `~/.hermes/plugins/context-review/`, or `$HERMES_HOME/plugins/context-review/` if you use a custom home.

### 2. Set up reviewed compaction

Check your existing settings first. These commands switch off other automatic compaction and pruning paths so they don't bypass the review. They also replace your selected context engine; don't apply them blindly if you already use another one.

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

If you use Codex, also run:

```bash
hermes config set model.api_mode codex_responses
```

That last command is **only for Codex**. The plugin rejects `codex_app_server` because that transport can compact outside the review process.

Enable the plugin and review tool:

```bash
hermes plugins enable context-review --no-allow-tool-override
hermes tools enable context_engine --platform cli
```

Selecting the engine and enabling the plugin are separate steps. You need both: the engine handles compaction, and the general plugin registers the review hook and tool.

For a named profile, use `hermes -p <profile>` at the start of **every** command, including installation. Enable the toolset for each platform you use, not just `cli`. Settings aren't automatically shared between profiles.

### 3. Check that it's available in your chat

```bash
hermes plugins doctor context-review --ci
hermes plugins validate "${HERMES_HOME:-$HOME/.hermes}/plugins/context-review" --json
```

The validation command takes a directory path, not a plugin name. For a named profile, point it at that profile's installed `plugins/context-review/` directory.

Ask Hermes to call `context_review` with `action: status`. Check that the engine is `context-review` and `engine_initialized` is true.

An already-running agent may still have its old engine or tool policy. If so, resume the same conversation through Hermes' supported session-resume flow. Don't reset the chat or delete its history. Reloading the plugin alone may not refresh the agent.

**Don't wait until the context window is full.** If you haven't approved a handoff, the plugin won't silently compact to make room, and your provider may refuse the next request.

## Context reminders

The backend checks the latest provider-reported input usage, not all the tokens you've spent across the session.

| Reminder | When it appears |
| --- | --- |
| First | Lower of 250,000 tokens or 60% of the model's context window |
| Second | Lower of 300,000 tokens or 75% of the model's context window |

These reminders arrive on a subsequent user turn, not as an exact real-time interrupt. If the provider doesn't report prompt usage, the backend doesn't currently estimate it.

You can ask to review now, snooze reminders, pause a review, or skip reminders for that session. Review state is kept separately for each profile and session and survives restarts.

## Optional Hermes Desktop reminder

There's also a small strip above the message box:

```text
Context review suggested          [Review now]  [Later]
```

**Review now** starts the review. It doesn't approve compaction, overwrite an unsent draft, or submit while the chat is busy. **Later** snoozes the UI reminder until active context grows by another 25,000 tokens.

It follows the focused chat and uses Hermes' theme. Install it separately using the [Desktop setup instructions](ui/README.md). The backend works without it, and snoozing the UI doesn't change the backend reminder state.

## What's stored locally

Review state lives here:

```text
$HERMES_HOME/plugin-data/context-review/state.sqlite3
```

It includes message fingerprints, questions and answers, proposals, and review state. It isn't a second full transcript archive, but quotes and proposals can contain private information. Don't upload that database or unredacted diagnostics to an issue.

The current chat's model does the review. There isn't a separate background summarizer, and triggering a token reminder doesn't make an extra model call. The review conversation still uses your normal model and provider.

The optional Desktop UI also stores local reminder preferences and diagnostic receipts, including session identifiers and UI state. See its [README](ui/README.md#local-diagnostics) for details.

## Testing the code

The initial checks passed **15 backend tests and 8 Desktop UI tests** on Hermes Agent `0.23.0`, plus native plugin doctor and validation.

From the repository root:

```bash
hermes --run-module unittest discover -s ./tests -p 'test_review.py' -v
hermes plugins doctor . --ci
hermes plugins validate . --json
node --check ui/plugin.js
node --experimental-vm-modules --test tests/test_desktop_ui.mjs
```

The backend tests need `TMPDIR` set to an existing writable temporary directory. The UI tests need Node.js and use controlled SDK stubs rather than a full Desktop app.

Tests cover approval, changed proposals and source history, clarification, profile/session separation, restart persistence, native tool dispatch and compaction, history retention, and the Desktop reminder's chat routing and draft protection. They use isolated synthetic sessions, not your production chats or paid model calls. Hermes integration fixtures can emit auxiliary-model, deprecation, and process-cleanup warnings.

Passing those checks means the tested mechanics work. It doesn't answer my question about better marketing or general-task results. That's the next experiment.

## A few limits to know

- This isn't lossless memory. You still need to check whether the handoff keeps the right things.
- The suite hasn't exercised a real 250k-token conversation or unattended production cleanup.
- Manual `/compress`, `force=True`, and tool calls don't grant cleanup approval.
- Other compaction paths need to stay disabled as documented above. Codex app-server isn't supported.
- Original history is retained through Hermes' session storage. This plugin isn't a separate backup system.

## Issues and contributions

If you try it, I'd like to hear whether it helps with your actual work, including where it gets in the way.

[Open an issue](https://github.com/izzie-iz/hermes-context-review-plugin/issues) with your Hermes version, provider/transport, the surface you're using, and steps to reproduce the problem. Please leave private conversation content and session identifiers out of public logs.

For the host APIs, see the official [Context Engine Plugins](https://hermes-agent.nousresearch.com/docs/developer-guide/context-engine-plugin) and [Hermes Plugins](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins) docs.

## License

A license hasn't been selected yet.
