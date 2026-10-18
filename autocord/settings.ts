/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

import type { ClickAction, EffortLevel, PromptMode, ProviderKind } from "./types";

export const PROVIDER_OPTIONS: readonly { label: string; value: ProviderKind; default?: boolean; }[] = [
    { label: "Local Antigravity (Language Server Connect-RPC)", value: "antigravity", default: true },
    { label: "NVIDIA Build (NIM / integrate.api.nvidia.com)", value: "nvidia" },
    { label: "OpenAI / OpenAI-Compatible API", value: "openai" },
    { label: "Local OpenAI Codex CLI (codex exec)", value: "codex" },
    { label: "Local Claude Code CLI (claude -p)", value: "claude" },
    { label: "Grok (Local Grok CLI or xAI API)", value: "grok" },
];

export const EFFORT_OPTIONS: readonly { label: string; value: EffortLevel; default?: boolean; }[] = [
    { label: "Low (Fastest / Minimal Deliberation)", value: "low", default: true },
    { label: "Medium (Balanced)", value: "medium" },
    { label: "High (Deep Reasoning)", value: "high" },
    { label: "Extra High (Maximum Effort / xhigh)", value: "xhigh" },
];

export const PROMPT_MODE_OPTIONS: readonly { label: string; value: PromptMode; default?: boolean; }[] = [
    { label: "Append to Autocord + Persona System Prompt", value: "append", default: true },
    { label: "Override Full System Prompt", value: "override" },
];

export const CLICK_ACTION_OPTIONS: readonly { label: string; value: ClickAction; default?: boolean; }[] = [
    { label: "Toggle Autocord in Channel (Preview / Active)", value: "toggle_channel" },
    { label: "Toggle Auto-Send Mode in Channel", value: "toggle_autosend" },
    { label: "Trigger One-Shot Autocord Preview Now", value: "trigger_preview" },
    { label: "Trigger One-Shot Auto-Send Reply Now", value: "trigger_autosend" },
    { label: "Toggle Autocord Globally", value: "toggle_global" },
    { label: "Open Autocord Control Modal", value: "open_modal" },
    { label: "Open Plugin Settings", value: "open_settings" },
];

export const DEFAULT_MODELS_BY_PROVIDER: Record<ProviderKind, string[]> = {
    antigravity: [
        "pro",
        "flash",
        "flash_lite",
    ],
    nvidia: [
        "deepseek-ai/deepseek-v3.2",
        "meta/llama-3.3-70b-instruct",
        "qwen/qwen3-235b-a22b",
        "nvidia/llama-3.1-nemotron-ultra-253b-v1",
        "moonshotai/kimi-k2-instruct",
    ],
    openai: [
        "gpt-4.1-mini",
        "gpt-4.1",
        "gpt-4o-mini",
        "gpt-4o",
        "o4-mini",
    ],
    codex: [
        "gpt-6.1-sol",
        "gpt-6-astra",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
    ],
    claude: [
        "claude-sonnet-4-6",
        "claude-sonnet-5",
        "claude-sonnet-5-5",
        "claude-opus-4-7",
        "claude-opus-5-5",
        "claude-haiku-4-5",
    ],
    grok: [
        "grok-4.7",
        "grok-4.7-build-fast",
        "grok-4.6",
        "grok-4.5",
        "grok-3-mini",
    ],
};

export const settings = definePluginSettings({
    enabledGlobally: {
        type: OptionType.BOOLEAN,
        description: "Master switch to enable or disable Autocord globally.",
        default: true,
    },
    chatIcon: {
        type: OptionType.BOOLEAN,
        description: "Show the Autocord toggle button in the chat bar.",
        default: true,
    },
    chatContextMenu: {
        type: OptionType.BOOLEAN,
        description: "Show Autocord quick controls in the chat input right-click context menu.",
        default: true,
    },
    leftClickAction: {
        type: OptionType.SELECT,
        description: "Action when Left-Clicking the Autocord chat bar button.",
        options: CLICK_ACTION_OPTIONS.map(o => ({ ...o, default: o.value === "toggle_channel" })),
    },
    rightClickAction: {
        type: OptionType.SELECT,
        description: "Action when Right-Clicking the Autocord chat bar button.",
        options: CLICK_ACTION_OPTIONS.map(o => ({ ...o, default: o.value === "toggle_autosend" })),
    },
    middleClickAction: {
        type: OptionType.SELECT,
        description: "Action when Middle-Clicking the Autocord chat bar button.",
        options: CLICK_ACTION_OPTIONS.map(o => ({ ...o, default: o.value === "open_modal" })),
    },
    enabledChannels: {
        type: OptionType.STRING,
        description: "Comma-separated channel IDs where Autocord is enabled (Left-Click the chat bar icon to toggle the current channel).",
        default: "1433348311502422129",
        placeholder: "1433348311502422129, 1470298715943207046",
    },
    autoSendChannels: {
        type: OptionType.STRING,
        description: "Comma-separated channel IDs where Auto-Send mode is active (Right-Click the chat bar icon to toggle Auto-Send; otherwise enabled channels use blue 'Autocord' preview mode).",
        default: "",
        placeholder: "Channel IDs for automatic sending",
    },
    autoSendGlobally: {
        type: OptionType.BOOLEAN,
        description: "When enabled, all active Autocord channels automatically send replies instead of showing blue 'Autocord' previews.",
        default: false,
    },
    provider: {
        type: OptionType.SELECT,
        description: "AI provider used by the Autocord orchestrator.",
        options: PROVIDER_OPTIONS,
        onChange(newValue: ProviderKind) {
            const nextProvider = (newValue || "antigravity") as ProviderKind;
            settings.store.model = resolveModelForProvider(nextProvider, settings.store.model);
        },
    },
    model: {
        type: OptionType.STRING,
        description: "Model name for the active provider (e.g. 'pro' or 'flash' for Antigravity, 'deepseek-ai/deepseek-v3.2' for NVIDIA Build, 'gpt-4.1-mini' for OpenAI, 'gpt-6.1-sol' for Codex, 'claude-sonnet-4-6' for Claude Code, 'grok-4.7' for Grok).",
        default: "pro",
        placeholder: "pro",
    },
    effort: {
        type: OptionType.SELECT,
        description: "Reasoning / thinking effort level passed to the orchestrator model.",
        options: EFFORT_OPTIONS,
    },
    personaId: {
        type: OptionType.STRING,
        description: "Active persona ID from personas.json (default: itsjskt = Katie; also supports shanks, ana, mfok, vnnnm, mason, Casualties, Anthony, joseph, Vivek).",
        default: "itsjskt",
        placeholder: "itsjskt",
    },
    personasPath: {
        type: OptionType.STRING,
        description: "Absolute path to Autocord personas.json file.",
        default: "c:\\Users\\user\\Documents\\antigravity\\autocord\\personas.json",
        placeholder: "c:\\Users\\user\\Documents\\antigravity\\autocord\\personas.json",
    },
    promptMode: {
        type: OptionType.SELECT,
        description: "Whether Custom Orchestrator Prompt appends steering instructions to the default Autocord + Katie prompt or overrides the entire system prompt.",
        options: PROMPT_MODE_OPTIONS,
    },
    customPrompt: {
        type: OptionType.STRING,
        multiline: true,
        description: "Custom orchestrator prompt instructions (appended to the Autocord + persona prompt, or full override when Prompt Mode is set to Override).",
        default: "",
        placeholder: "Optional custom steering instructions for the orchestrator...",
    },
    openaiApiKey: {
        type: OptionType.STRING,
        description: "OpenAI or OpenAI-compatible API key / bearer token (falls back to OPENAI_API_KEY env var if empty).",
        default: "",
        placeholder: "sk-...",
    },
    openaiBaseUrl: {
        type: OptionType.STRING,
        description: "OpenAI-compatible API Base URL (supports OpenAI, OpenRouter, Vercel AI Gateway, local Ollama/vLLM/LM Studio).",
        default: "https://api.openai.com/v1",
        placeholder: "https://api.openai.com/v1",
    },
    nvidiaApiKey: {
        type: OptionType.STRING,
        description: "NVIDIA Build (NIM) API key / token starting with nvapi- (falls back to NVIDIA_API_KEY or NGC_API_KEY env var if empty).",
        default: "",
        placeholder: "nvapi-...",
    },
    nvidiaBaseUrl: {
        type: OptionType.STRING,
        description: "NVIDIA Build NIM OpenAI-compatible API Base URL.",
        default: "https://integrate.api.nvidia.com/v1",
        placeholder: "https://integrate.api.nvidia.com/v1",
    },
    grokApiKey: {
        type: OptionType.STRING,
        description: "xAI / Grok API key (falls back to XAI_API_KEY / GROK_API_KEY env var or local Grok CLI if empty).",
        default: "",
        placeholder: "xai-...",
    },
    grokBaseUrl: {
        type: OptionType.STRING,
        description: "xAI Grok OpenAI-compatible API Base URL.",
        default: "https://api.x.ai/v1",
        placeholder: "https://api.x.ai/v1",
    },
    anthropicApiKey: {
        type: OptionType.STRING,
        description: "Optional Anthropic API key for Claude Code fallback (falls back to local Claude Code login or ANTHROPIC_API_KEY env var).",
        default: "",
        placeholder: "sk-ant-...",
    },
    antigravityProject: {
        type: OptionType.STRING,
        description: "Antigravity project name for isolated local sessions (default 'Discord' maps to 5f396b27-5d07-5e60-9343-41bbd9061036 so sessions never clutter autocord).",
        default: "Discord",
        placeholder: "Discord",
    },
    antigravityPath: {
        type: OptionType.STRING,
        description: "Optional custom path to Antigravity language_server.exe or agentapi binary (auto-discovered if empty).",
        default: "",
        placeholder: "language_server.exe",
    },
    codexCliPath: {
        type: OptionType.STRING,
        description: "Optional custom executable path for local OpenAI Codex CLI (leave empty to auto-discover 'codex' in PATH).",
        default: "",
        placeholder: "codex",
    },
    claudeCliPath: {
        type: OptionType.STRING,
        description: "Optional custom executable path for local Claude Code CLI (leave empty to auto-discover 'claude' in PATH).",
        default: "",
        placeholder: "claude",
    },
    grokCliPath: {
        type: OptionType.STRING,
        description: "Optional custom executable path for local Grok CLI (leave empty to auto-discover 'grok' in PATH).",
        default: "",
        placeholder: "grok",
    },
    reuseLocalSession: {
        type: OptionType.BOOLEAN,
        description: "Reuse persistent local chat sessions per channel for Antigravity, Codex, Claude Code, and Grok.",
        default: true,
    },
    showMetadataFooter: {
        type: OptionType.BOOLEAN,
        description: "Include metadata footer (persona, provider/model/effort, target message, reasoning) in blue 'Autocord' preview messages.",
        default: true,
    },
    showSilencePreviews: {
        type: OptionType.BOOLEAN,
        description: "Show a blue 'Autocord' preview message even when the orchestrator decides action='silence'.",
        default: false,
    },
    simulateTypingDelay: {
        type: OptionType.BOOLEAN,
        description: "Simulate natural typing indicator and delay (delay_seconds) before sending replies in Auto-Send mode.",
        default: true,
    },
    contextMessageCount: {
        type: OptionType.NUMBER,
        description: "Number of recent channel messages from MessageStore to include in orchestrator context (5 to 50).",
        default: 25,
    },
    debounceMs: {
        type: OptionType.NUMBER,
        description: "Debounce window in milliseconds after an incoming human message before evaluating a reply.",
        default: 1800,
    },
    cooldownSeconds: {
        type: OptionType.NUMBER,
        description: "Minimum cooldown in seconds between automatic orchestrator evaluations in the same channel.",
        default: 8,
    },
});

const ANTIGRAVITY_MODEL_ALIASES = new Set([
    "pro",
    "flash",
    "flash_lite",
    "flash-low",
    "flash_low",
    "3.8-flash-low",
    "gemini-3.8-flash",
    "gemini-3.8-flash-low",
    "model_placeholder_m320",
    "model_placeholder_m419",
]);

/**
 * Ensures that switching providers does not leave a stale model identifier from another provider
 * (such as Antigravity's default "pro" when switching to NVIDIA, OpenAI, Codex, Claude, or Grok).
 */
export function resolveModelForProvider(provider: ProviderKind, rawModel?: string): string {
    const defaultModel = DEFAULT_MODELS_BY_PROVIDER[provider]?.[0] || "pro";
    const trimmed = (rawModel || "").trim();
    if (!trimmed) return defaultModel;

    const lower = trimmed.toLowerCase();
    if (provider === "antigravity") {
        return ANTIGRAVITY_MODEL_ALIASES.has(lower) ? trimmed : defaultModel;
    }

    if (ANTIGRAVITY_MODEL_ALIASES.has(lower)) {
        return defaultModel;
    }

    const ownPresets = DEFAULT_MODELS_BY_PROVIDER[provider] || [];
    if (ownPresets.some(m => m.toLowerCase() === lower)) {
        return trimmed;
    }

    // If `trimmed` is a known preset of a different provider, switch to `provider`'s default model
    // (unless `provider` is "openai", which supports custom OpenAI-compatible gateways/models).
    if (provider !== "openai") {
        for (const [otherProvider, presets] of Object.entries(DEFAULT_MODELS_BY_PROVIDER) as [ProviderKind, string[]][]) {
            if (otherProvider !== provider && presets.some(m => m.toLowerCase() === lower)) {
                return defaultModel;
            }
        }
    }

    return trimmed;
}

export function buildProviderSettingsArgs() {
    const s = settings.store;
    const provider = (s.provider || "antigravity") as ProviderKind;
    const resolvedModel = resolveModelForProvider(provider, s.model);
    const openaiApiKey = (s.openaiApiKey || "").trim() || undefined;
    const openaiBaseUrl = (s.openaiBaseUrl || "").trim() || undefined;
    const nvidiaApiKey = (s.nvidiaApiKey || "").trim() || undefined;
    const nvidiaBaseUrl = (s.nvidiaBaseUrl || "").trim() || undefined;
    const xaiApiKey = (s.grokApiKey || "").trim() || undefined;
    const grokBaseUrl = (s.grokBaseUrl || "").trim() || undefined;
    const anthropicApiKey = (s.anthropicApiKey || "").trim() || undefined;
    const antigravityProject = (s.antigravityProject || "").trim() || "Discord";
    const antigravityPath = (s.antigravityPath || "").trim() || undefined;
    const codexCliPath = (s.codexCliPath || "").trim() || undefined;
    const claudeCliPath = (s.claudeCliPath || "").trim() || undefined;
    const grokCliPath = (s.grokCliPath || "").trim() || undefined;

    const apiKey = provider === "nvidia"
        ? nvidiaApiKey
        : provider === "openai"
            ? openaiApiKey
            : provider === "grok"
                ? xaiApiKey
                : provider === "claude"
                    ? anthropicApiKey
                    : undefined;

    const baseUrl = provider === "nvidia"
        ? nvidiaBaseUrl
        : provider === "openai"
            ? openaiBaseUrl
            : provider === "grok"
                ? grokBaseUrl
                : undefined;

    return {
        provider,
        model: resolvedModel,
        effort: (s.effort || "low") as EffortLevel,
        activePersonaId: (s.personaId || "itsjskt").trim() || "itsjskt",
        personasPath: (s.personasPath || "").trim() || undefined,
        customPrompt: s.customPrompt || "",
        promptMode: (s.promptMode || "append") as PromptMode,
        reuseLocalSession: Boolean(s.reuseLocalSession),
        apiKey,
        baseUrl,
        openaiApiKey,
        openaiBaseUrl,
        nvidiaApiKey,
        nvidiaBaseUrl,
        xaiApiKey,
        grokApiKey: xaiApiKey,
        grokBaseUrl,
        anthropicApiKey,
        antigravityProject,
        antigravityPath,
        codexPath: codexCliPath,
        codexCliPath,
        claudePath: claudeCliPath,
        claudeCliPath,
        grokPath: grokCliPath,
        grokCliPath,
    };
}

export function parseIdList(raw: string | undefined): string[] {
    if (!raw) return [];
    return raw
        .split(",")
        .map(s => s.trim())
        .filter(Boolean);
}

export function isChannelEnabled(channelId: string): boolean {
    if (!channelId) return false;
    return parseIdList(settings.store.enabledChannels).includes(channelId);
}

export function setChannelEnabled(channelId: string, enabled: boolean): boolean {
    const list = parseIdList(settings.store.enabledChannels);
    const idx = list.indexOf(channelId);
    if (enabled && idx === -1) {
        list.push(channelId);
    } else if (!enabled && idx !== -1) {
        list.splice(idx, 1);
    }
    settings.store.enabledChannels = list.join(", ");
    return enabled;
}

export function toggleChannelEnabled(channelId: string): boolean {
    const next = !isChannelEnabled(channelId);
    return setChannelEnabled(channelId, next);
}

export function isChannelAutoSend(channelId: string): boolean {
    if (!channelId) return false;
    if (settings.store.autoSendGlobally) return true;
    return parseIdList(settings.store.autoSendChannels).includes(channelId);
}

export function setChannelAutoSend(channelId: string, autoSend: boolean): boolean {
    const list = parseIdList(settings.store.autoSendChannels);
    const idx = list.indexOf(channelId);
    if (autoSend && idx === -1) {
        list.push(channelId);
    } else if (!autoSend && idx !== -1) {
        list.splice(idx, 1);
    }
    settings.store.autoSendChannels = list.join(", ");
    return autoSend;
}

export function toggleChannelAutoSend(channelId: string): boolean {
    const currentlyInList = parseIdList(settings.store.autoSendChannels).includes(channelId);
    const next = !currentlyInList;
    setChannelAutoSend(channelId, next);
    if (next && !isChannelEnabled(channelId)) {
        setChannelEnabled(channelId, true);
    }
    return next;
}
