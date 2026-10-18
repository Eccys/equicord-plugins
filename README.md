# Equicord userplugins

Private Equicord plugins. Equicord will not merge these. Drop each folder into `src/userplugins/` on a **source build**.

| Plugin | What it does |
| --- | --- |
| `fakeDeafen` | Appear deafened/muted in VC while you can still hear and speak |
| `elevenVoice` | `/11` ElevenLabs TTS, voice messages, clip clone, VC playback on Equibop/Vesktop/web |
| `autocord` | Multi-provider AI chat orchestrator (Antigravity, Codex, Claude Code, Grok, NVIDIA Build, OpenAI) with ChatBar toggle, right-click Auto-Send, and blue `"Autocord"` ephemeral previews |

## Install

Userplugins need an Equicord source checkout. The stock installer cannot load these.

```powershell
git clone https://github.com/Equicord/Equicord
cd Equicord
pnpm install --frozen-lockfile
mkdir src\userplugins
```

Copy `fakeDeafen`, `elevenVoice`, and `autocord` into `src/userplugins/`, then:

```powershell
pnpm build
pnpm inject
```

Restart Discord. Enable the plugins under Equicord settings.

If you already have a source tree, just copy the folders and `pnpm build`. Restart is enough if it is already injected.

## FakeDeafen

Adapted from [hyyven/Vencord-FakeDeafen](https://github.com/hyyven/Vencord-FakeDeafen) for Equicord.

- Button in the user area
- Ctrl+Shift+Q
- Settings: fake mute, fake deafen, or both
- Rewrites outbound voice-state (`op 4`) so others see you as muted/deafened while local capture/playback stays on

This is a Discord ToS client-state spoof. Equicord will not accept it upstream. Use a throwaway if you care.

## ElevenVoice

```
/11 [laughs] hi im a demo test [pause] hows your day
/11vc same thing, play into current VC (Equibop / Vesktop / web only)
/11voices list voices on the account
```

Chat-bar button and attach-menu item open a modal: send, play in VC, or record a clip and speech-to-speech convert it.

API key:

1. User environment variable `ELEVENLABS_API_KEY` (desktop native path reads this)
2. Or paste it in plugin settings (needed on web; desktop can use either)

Do not commit the key. Fully restart Discord after setting the user env var so Electron sees it.

Official Discord Desktop cannot inject audio into the native voice encoder. `/11vc` and "Play in VC" need Equibop, Vesktop, or Discord web. Delay of a couple of seconds is expected. ElevenLabs has no live speech-to-speech websocket.

iOS voice-message bubbles need Ogg Opus. The default output format is `opus_48000_128`. If your plan rejects that, switch to mp3 and send as a file.

## Autocord

In-client multi-persona AI chat orchestrator that reads recent context directly from Discord's in-memory `MessageStore` (zero background REST scraping) and evaluates whether to reply or stay silent (`action: "reply" | "silence"`).

### ChatBar Toggle & Right-Click Auto-Send

- **Left-Click ChatBar Button**: Toggles Autocord **ON/OFF** in the current channel (defaults to blue `"Autocord"` ephemeral preview mode when enabled).
- **Right-Click ChatBar Button**: Toggles **Auto-Send (Live Dispatch)** mode in the current channel (automatically enables the channel if off). When Auto-Send is active, `action: "reply"` decisions are dispatched directly to the channel via `sendMessage` with natural typing delay (`TYPING_START_LOCAL` + `delay_seconds`) and optional `messageReference` reply threading.
- **Middle-Click ChatBar Button**: Opens the **Autocord Control Modal** for live provider/model/effort switching, session inspection, and one-shot testing.
- **Chat Input Context Menu**: Right-click the message input box (`textarea-context`) for quick toggles (Channel Enabled, Auto-Send Mode, Global Master Switch, Provider & Effort radio selectors, Metadata Footer, Silence Previews, and one-shot triggers).
- All three mouse click bindings (`leftClickAction`, `rightClickAction`, `middleClickAction`) are customizable in plugin settings.

### Blue `"Autocord"` Ephemeral Preview Mode

When a channel is enabled without Auto-Send (or when triggered via `/autocord action:preview`), Autocord injects a local-only Clyde-style blue ephemeral message whose author username and display name are overridden to **`Autocord`** (never sent over the network; visible only to you):

- Displays the proposed reply text (or `*(Silence — orchestrator decided not to reply)*` when manually triggered or when **Show Silence Previews** is enabled).
- Optional **Metadata Footer** (`showMetadataFooter`): shows active persona (`itsjskt` / Katie by default), engine (`provider/model` + `effort`), inference latency, local session ID prefix, target `reply_to` message/author, and orchestrator reasoning.

### Supported Cloud & Local Providers

Autocord runs provider execution in Electron's main process (`native.ts`) with persistent per-channel session reuse (`reuseLocalSession`, automatically rotated after `ANTIGRAVITY_MAX_SESSION_STEPS = 60` steps for Antigravity or `MAX_CLI_SESSION_TURNS = 24` turns for CLI providers):

| Provider | Mode | Default Model | Notes |
| --- | --- | --- | --- |
| `antigravity` | Local Connect-RPC / CLI | `pro` | Connects to local `language_server.exe` over HTTP/1.1 Connect-RPC (`StartCascade` / `SendUserCascadeMessage` / `SendAgentMessage`), strictly isolated to the `"discord"` project (`5f396b27-5d07-5e60-9343-41bbd9061036`). Supports `pro`, `flash`, `flash_lite`. |
| `codex` | Local CLI (`codex.exe`) | `gpt-6.1-sol` | Runs `codex exec` / `codex exec -s read-only resume <session_id>` with `--ignore-user-config`, `--ignore-rules`, and `-s read-only` so user config/MCP plugins are bypassed. Presets: `gpt-6.1-sol`, `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`. |
| `claude` | Local CLI / Anthropic API | `claude-sonnet-4-6` | Runs `claude -p --output-format json` with `--session-id` / `--resume` per channel; falls back to Anthropic Messages API (`ANTHROPIC_API_KEY`) if CLI is unavailable. Presets: `claude-sonnet-4-6`, `claude-sonnet-5`, `claude-sonnet-5-5`, `claude-opus-4-7`, `claude-opus-5-5`, `claude-haiku-4-5`. |
| `grok` | Local CLI / xAI API | `grok-4.7` | Runs `~/.grok/bin/grok.exe` with `--json-schema`, `--no-subagents`, `--disable-web-search`, `--no-plan`, `--max-turns 1`, `--tools ""`, `--permission-mode dontAsk`, and `--session-id` / `--resume`; falls back to xAI API (`XAI_API_KEY`). Presets: `grok-4.7`, `grok-4.7-build-fast`, `grok-4.6`, `grok-4.5`, `grok-3-mini`. |
| `nvidia` | Cloud API (NVIDIA Build NIM) | `deepseek-ai/deepseek-v3.2` | Uses `https://integrate.api.nvidia.com/v1` with `nvidiaApiKey` (`nvapi-...`) or `NVIDIA_API_KEY` / `NGC_API_KEY`. Presets: `deepseek-ai/deepseek-v3.2`, `meta/llama-3.3-70b-instruct`, `qwen/qwen3-235b-a22b`, `nvidia/llama-3.1-nemotron-ultra-253b-v1`, `moonshotai/kimi-k2-instruct`. |
| `openai` | Cloud / Local OpenAI-Compatible | `gpt-4.1-mini` | Uses `https://api.openai.com/v1` (or custom `openaiBaseUrl` for OpenRouter, Ollama, vLLM, LM Studio) with `openaiApiKey` or `OPENAI_API_KEY`. Presets: `gpt-4.1-mini`, `gpt-4.1`, `gpt-4o-mini`, `gpt-4o`, `o4-mini`. |

### Model & Effort Selection

- **Model Resolution**: Switching providers automatically updates the active model preset via `resolveModelForProvider` so stale model names from another provider are never sent, or you can query live `/v1/models` (or `grok models`) from the Control Modal.
- **Reasoning Effort (`effort`)**: Choose between `low` (fastest, minimal deliberation), `medium` (balanced), `high` (deep reasoning), and `xhigh` (maximum effort). Effort is mapped to each backend (`model_reasoning_effort` for Codex, `--reasoning-effort` for Grok, `--effort` for Claude, `reasoning_effort` / `chat_template_kwargs` for NVIDIA NIM & OpenAI reasoning models, and explicit thinking instructions).

### Custom Orchestrator Prompting & Slash Command

- **Personas**: Loads persona profiles and empirical voice examples from `personas.json` (defaults to `itsjskt` / Katie, with built-in support for `shanks`, `ana`, `mfok`, `vnnnm`, `mason`, `Casualties`, `Anthony`, `joseph`, and `Vivek`) plus server-specific rules (ChillZone, Socialize, VALORANT).
- **Custom Prompt Modes (`promptMode` + `customPrompt`)**:
  - `append` *(default)*: Appends your custom steering instructions to the built-in Autocord + persona voice prompt and server rules.
  - `override`: Replaces the system prompt with your custom instructions while preserving the strict JSON output schema (`{"action": "silence|reply", "persona_id": ..., "content": ..., "reply_to": ..., "delay_seconds": ..., "reasoning": ...}`).
- **Slash Command (`/autocord`)**:
  ```
  /autocord action:preview
  /autocord action:autosend
  /autocord action:health
  /autocord action:reset-session
  /autocord action:modal
  /autocord provider:codex model:gpt-6.1-sol effort:low persona:itsjskt prompt:keep replies playful
  ```

## Credits

- FakeDeafen: [hyyven](https://github.com/hyyven/Vencord-FakeDeafen), plus yofukashino and SiriusBYT as credited upstream
- Voice-message upload path follows Vencord VoiceMessages
- VC mix path follows the public AudioInput wrap used by web soundboard userplugins

