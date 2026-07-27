<div align="center">

<img src="https://raw.githubusercontent.com/UtkarshloneyaITG/Infinity-Coder/main/assets/icon-256.png" alt="" width="96" height="96">

# Infinity Coder

**A self-contained AI coding agent for Visual Studio Code.**

Reads, writes, searches and runs code in your project — with *your* API key,
against *any* OpenAI-compatible endpoint.

[![VS Code](https://img.shields.io/badge/VS%20Code-1.85%2B-0098FF?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/)
[![License](https://img.shields.io/badge/License-MIT-22c55e)](LICENSE)
[![Release](https://img.shields.io/github/v/release/UtkarshloneyaITG/Infinity-Coder?color=8b5cf6&include_prereleases&sort=semver)](https://github.com/UtkarshloneyaITG/Infinity-Coder/releases)
[![Build](https://img.shields.io/github/actions/workflow/status/UtkarshloneyaITG/Infinity-Coder/release.yml)](https://github.com/UtkarshloneyaITG/Infinity-Coder/actions)

[Install](#install) · [First run](#first-run) · [Features](#features) · [Skills](#skills) · [Security](#security)

</div>

---

No backend server. No Python. No npm dependencies. No telemetry. Nothing leaves your
machine except the requests you make to the AI provider you chose.

## Install

<table>
<tr><th align="left" width="200">From a <code>.vsix</code></th><td>

Download `infinity-coder-<version>.vsix` from the
[Releases page](https://github.com/UtkarshloneyaITG/Infinity-Coder/releases), then:

```bash
code --install-extension infinity-coder-0.1.0.vsix
```

Or in the UI: **Extensions** (`Ctrl+Shift+X`) → the `...` menu → **Install from VSIX...**

</td></tr>
<tr><th align="left">Build it yourself</th><td>

```bash
git clone https://github.com/UtkarshloneyaITG/Infinity-Coder.git
cd Infinity-Coder
npm install
npm run package                                   # writes the .vsix here
code --install-extension infinity-coder-0.1.0.vsix
```

</td></tr>
<tr><th align="left">Run from source</th><td>

```bash
git clone https://github.com/UtkarshloneyaITG/Infinity-Coder.git
cd Infinity-Coder
npm install
npm run compile
```

Open the folder in VS Code and press `F5`. A second window opens with the extension loaded.

</td></tr>
</table>

Reload VS Code afterwards — the **Infinity Coder** icon appears in the activity bar.

## First run

The extension ships with **no key and no default provider account**. It cannot talk to
anything until you give it one.

1. Click the Infinity Coder icon in the activity bar.
2. Click the gear icon in the panel header.
3. Under **Keys**, paste an API key into a provider and press **Add**.
4. Press **Test** — it verifies the key and discovers that endpoint's models.
5. Go to **Models**, pick one, hit **Save**. Start chatting.

Two providers are preconfigured. Either works, or add your own:

| Provider | Base URL | Where to get a key |
|---|---|---|
| NVIDIA NIM | `https://integrate.api.nvidia.com/v1` | [build.nvidia.com](https://build.nvidia.com) — free tier available |
| Groq | `https://api.groq.com/openai/v1` | [console.groq.com](https://console.groq.com) |
| Anything else | your URL | Any OpenAI-compatible endpoint: OpenRouter, Together, xAI, a local llama.cpp / Ollama server |

> [!IMPORTANT]
> Your keys are stored in your operating system's keychain via VS Code's `SecretStorage`.
> They never touch `settings.json`, never appear in the UI beyond the last 4 characters,
> and are deleted from the keychain when you remove them.

## Features

**Chat sidebar** with markdown, syntax highlighting, and per-code-block *Copy*,
*Insert at Cursor*, *Replace Selection*.

**Agentic tools** — it acts on your project instead of telling you what to type:

| Group | Tools |
|---|---|
| Files | `read_file` `write_file` `edit_file` `create_item` `delete_item` `list_folder` |
| Search | `find_files` `search_in_files` |
| Shell | `run_command` (foreground or detached) `list_processes` `stop_process` |
| Web | `web_search` `read_page` `extract_links` |

Everything else:

- **Plan mode** — the **Plan** toggle next to the model picker. While it's on the agent
  is offered *only* read and search tools, so it physically cannot write, delete or run
  anything: it investigates, then posts a plan with **Approve & build** / **Change
  something** / **Dismiss**. Approving turns the mode off and starts the work. It stays
  on for the rest of the chat and resets in a new one.
- **Diff approval** — every write, edit and delete pauses with a card *in the chat*.
  Shows `+added −removed`, opens a real diff on request, and lets you reject with an
  instruction ("use Tailwind instead") that goes straight back to the model.
  Switch to auto-apply in **Settings → Tools** to run unattended.
- **Semantic index** — ask "where is authentication handled" and get the auth middleware,
  the JWT service and the login controller, not grep hits. [See below](#semantic-index).
- **`@file` mentions** — type `@` to search your workspace and attach files to a message.
- **Skills** — reusable `SKILL.md` instruction files. [See below](#skills).
- **Key & model failover** — add fallback keys per provider. A key that hits 401 or 429
  falls through to the next key, then the next provider, then a lighter model, with a
  notice in the chat each time.
- **Token usage** — real counts from the provider plus a context-budget meter per reply.
- **Live activity strip** — what the agent is doing right now, elapsed time, Stop button.
- **Editor integration** — right-click a selection for *Explain*, *Fix / Refactor*, or
  *Ask about this*.

Keyboard: `Ctrl+Alt+B` (`Cmd+Alt+B` on macOS) opens the chat.

## Settings

Everything lives in the extension's own settings modal (the gear icon), not in VS Code's
settings page.

| Tab | What it holds |
|---|---|
| **Keys** | Providers, base URLs, API keys. Order is the failover order — for providers and for the keys within one. |
| **Models** | Active model, boost model, temperature, max tokens, context budget. |
| **Tools** | Ask-vs-auto for file changes, tool steps per message, per-group toggles. |
| **Skills** | Per-skill Always / Auto / Off, token cost, scanned folders. |

## Skills

A skill is a markdown file with YAML frontmatter — the same format Claude Code uses, so
an existing library works here unchanged:

```markdown
---
name: house-style
description: Use when writing or reviewing code in this project.
prompt: Review the uncommitted diff against our house style.
---
- Prefer composition over inheritance.
- Every exported function needs a one-line doc comment.
```

Save it as `~/.infinity-coder/skills/house-style/SKILL.md` and it appears in
**Settings → Skills**. Scanned folders default to `~/.infinity-coder/skills` and
`~/.claude/skills`; add more from that tab.

| Mode | Loads | Use for |
|---|---|---|
| **Always** | Every message | Small behaviour skills. The tab shows the running per-message token cost. |
| **Auto** (default) | Only when your message matches the skill's name, description, or `triggers:` | Large reference skills — free until they match. |
| **Off** | Never | — |

Every skill is also a slash command: type `/house-style` to run it immediately, or
`/house-style check the auth module` to give it a target. A command overrides the
configured mode, including **Off**.

Selection is deterministic keyword scoring, not model judgement — a skill you configured
always fires, one you didn't never does. Whichever skills apply are named in the chat.

`prompt:` in the frontmatter is optional: it's what `/<skill>` asks for when invoked with
nothing after it.

## Semantic index

Off by default — it spends embedding calls, and that should be your decision. Turn it on
in **Settings → Index**, set an embedding model for your provider, and press **Build
index**.

Once built, the assistant retrieves the right code by meaning before every message, so
"fix the login bug" pulls in the login component, the auth middleware and the JWT service
without a single `@file` mention.

```
Infinity: Build Semantic Index     full build (re-embeds everything)
Infinity: Update Index             only files whose hash changed
Infinity: Search Index             semantic search, jump to the result
Infinity: Show Index Stats         chunks, files, size, model
Infinity: Clear Index              delete it for this workspace
```

How it works, and what it costs:

| | |
|---|---|
| **Chunking** | By syntax, never fixed windows. Functions, methods, classes, interfaces, React components and hooks come from VS Code's own symbol providers; markdown splits by heading, JSON by top-level key. Files with no language server fall back to a declaration scan. |
| **Storage** | Flat files in the extension's storage: `manifest.json`, `vectors.bin`, `chunks.jsonl`. No database, no native modules, one index per workspace. |
| **Memory** | Vectors are int8-quantized — a quarter the size of float32 for under 1% cosine error. Chunk *text* stays on disk and is read back only for results that are actually returned. |
| **Incremental** | A file whose sha1 is unchanged is never re-read, re-chunked or re-embedded. Saves are debounced 2s, so a formatter or a branch switch costs one pass, not hundreds. |
| **Ranking** | Cosine similarity, then boosts for exported symbols, entry points, config files, open editors, recency and literal name matches. Similarity dominates by design — the boosts break ties rather than replacing the vector. |

Everything except the embedding request itself is local. The requests go only to the
provider you configured, exactly like chat.

**Scale.** The flat scan is comfortable to roughly 250k chunks — a large monorepo. Past
that, `maxChunks` stops indexing with a message rather than exhausting memory; the upgrade
path is an approximate index behind the same `VectorStore` interface, not a bigger machine.

## Security

- **Keys live in the OS keychain**, never in `settings.json` and never in the webview.
- **Shell tools are disabled in untrusted workspaces.** `run_command` isn't even offered
  to the model until you trust the folder, so a prompt injected into a README of a repo
  you just cloned can't execute anything.
- **Skills are read from global folders only**, never from the open project — a
  `SKILL.md` inside a cloned repo would be untrusted text becoming instructions.
- **The webview loads nothing from the network.** `highlight.js` and `marked` are
  vendored in `media/`, under a strict CSP that allows only nonce'd local scripts.
- **Web fetches are SSRF-guarded.** http/https only, and every host — including each
  redirect hop — is resolved and rejected if it lands on a loopback, private, link-local
  or cloud-metadata address.
- **Destructive shell commands are refused** by a denylist, and `delete_item` goes to the
  Recycle Bin / Trash rather than deleting outright.
- **No telemetry.** The only network calls are to the AI provider you configured, plus
  `web_search` / `read_page` when the agent uses them.

## Tests

```bash
npm test
```

Four assert-based self-checks, no framework:

| Suite | Covers |
|---|---|
| `settings.test.ts` | Key storage, failover ordering, secrets never reaching globalState |
| `engine/engine.test.ts` | Tools against a temp dir, path handling, the SSRF guard, HTML extraction, history trimming |
| `engine/skills.test.ts` | Frontmatter parsing, discovery, keyword scoring, mode/command precedence |
| `webview.test.ts` | Generated HTML: CSP and nonces, no remote resources, script parses, approval-card behaviour |

## Requirements

- VS Code **1.85.0** or newer
- An API key for any OpenAI-compatible endpoint
- Node.js 18+ **only if building from source**

## License

[MIT](LICENSE) © UtkarshloneyaITG
