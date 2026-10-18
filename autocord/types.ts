/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type ProviderKind = "antigravity" | "nvidia" | "openai" | "codex" | "claude" | "grok";

export type EffortLevel = "low" | "medium" | "high" | "xhigh";

export type PromptMode = "append" | "override";

export type ClickAction =
    | "toggle_channel"
    | "toggle_autosend"
    | "trigger_preview"
    | "trigger_autosend"
    | "toggle_global"
    | "open_modal"
    | "open_settings";

export interface ContextMessage {
    id: string;
    authorId?: string;
    authorName?: string;
    author?: string;
    displayName?: string;
    content: string;
    timestamp?: string;
    replyTo?: string | null;
    replyToAuthorName?: string | null;
    isBot?: boolean;
    isWebhook?: boolean;
    isSystem?: boolean;
    isSelf?: boolean;
    isOwnPersona?: boolean;
    mentions?: string[];
    // Optional snake_case fields for direct compatibility with Python orchestrator schema
    author_id?: string;
    author_name?: string;
    reply_to?: string | null;
    is_bot?: boolean;
    is_webhook?: boolean;
    is_system?: boolean;
    is_own_persona?: boolean;
}

export interface PersonaExample {
    content: string;
    context_before?: { author: string; content: string; };
    context_after?: { author: string; content: string; };
}

export interface PersonaProfile {
    id: string;
    display_name: string;
    displayName?: string;
    style: string;
    constraints: string[];
    read_only?: boolean;
    corpus?: { source_author?: string; };
    examples?: PersonaExample[];
}

export interface OrchestratorDecision {
    action: "silence" | "reply";
    persona_id: string | null;
    content: string | null;
    reply_to: string | null;
    delay_seconds?: number | null;
    reasoning?: string | null;
    diagnostic?: string | null;
    provider?: ProviderKind;
    model?: string;
    effort?: EffortLevel;
    sessionId?: string | null;
    durationMs?: number;
    rawResponse?: string;
}

export interface GenerateDecisionArgs {
    provider: ProviderKind;
    model?: string;
    effort?: EffortLevel;
    channelId?: string;
    guildId?: string | null;
    channelName?: string;
    guildName?: string;
    prompt?: string;
    systemPrompt?: string;
    customPrompt?: string;
    customSystemPrompt?: string;
    messages?: ContextMessage[];
    persona?: PersonaProfile;
    personas?: PersonaProfile[];
    activePersonaId?: string;
    personasPath?: string;
    selfUserId?: string;
    selfUsername?: string;
    targetMessageId?: string | null;
    targetAuthorName?: string | null;
    addressed?: boolean;
    requireReply?: boolean;
    spontaneousStarter?: boolean;
    closingTurn?: boolean;
    allowDoubleText?: boolean;
    promptMode?: PromptMode;
    reuseLocalSession?: boolean;
    sessionId?: string | null;
    timeoutMs?: number;
    // API Keys & Endpoints
    apiKey?: string;
    baseUrl?: string;
    nvidiaApiKey?: string;
    openaiApiKey?: string;
    openaiBaseUrl?: string;
    nvidiaBaseUrl?: string;
    anthropicApiKey?: string;
    xaiApiKey?: string;
    grokApiKey?: string;
    grokBaseUrl?: string;
    antigravityProject?: string;
    // Optional CLI binary path overrides
    antigravityPath?: string;
    codexPath?: string;
    codexCliPath?: string;
    claudePath?: string;
    claudeCliPath?: string;
    grokPath?: string;
    grokCliPath?: string;
}

export interface GenerateDecisionResult {
    ok: boolean;
    decision?: OrchestratorDecision;
    provider: ProviderKind;
    model: string;
    effort: EffortLevel;
    sessionId?: string | null;
    durationMs?: number;
    rawText?: string;
    promptUsed?: string;
    error?: string;
}

export interface ProviderStatusItem {
    provider: ProviderKind;
    available: boolean;
    healthy: boolean;
    mode: "local_cli" | "local_rpc" | "remote_api" | "unavailable";
    detail: string;
    binaryPath?: string | null;
    defaultModel: string;
    models?: string[];
    sessionCount?: number;
}

export interface ProviderHealthResult {
    ok: boolean;
    checkedAt: number;
    providers: Record<ProviderKind, ProviderStatusItem>;
    error?: string;
}
