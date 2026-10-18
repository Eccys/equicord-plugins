/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { ApplicationCommandInputType, ApplicationCommandOptionType, findOption } from "@api/Commands";
import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { plugins } from "@api/PluginManager";
import { Button, Divider, Flex, FormSwitch, Heading, Paragraph, Span } from "@components/index";
import { openPluginModal } from "@components/settings";
import { sendMessage } from "@utils/discord";
import { openModal } from "@utils/modal";
import { useForceUpdater } from "@utils/react";
import definePlugin, { PluginNative } from "@utils/types";
import { Message, RenderModalProps } from "@vencord/discord-types";
import { findByCodeLazy } from "@webpack";
import {
    ChannelStore,
    FluxDispatcher,
    GuildStore,
    Menu,
    MessageActions,
    MessageStore,
    Modal,
    React,
    Select,
    SelectedChannelStore,
    showToast,
    TextArea,
    TextInput,
    useEffect,
    useRef,
    UserStore,
    useState,
} from "@webpack/common";

import { DEFAULT_KATIE_PERSONA, DEFAULT_MODEL_BY_PROVIDER, PROVIDER_MODEL_SUGGESTIONS } from "./prompt";
import {
    buildProviderSettingsArgs,
    CLICK_ACTION_OPTIONS,
    EFFORT_OPTIONS,
    isChannelAutoSend,
    isChannelEnabled,
    PROMPT_MODE_OPTIONS,
    PROVIDER_OPTIONS,
    resolveModelForProvider,
    setChannelAutoSend,
    setChannelEnabled,
    settings,
    toggleChannelAutoSend,
    toggleChannelEnabled,
} from "./settings";
import type {
    ClickAction,
    ContextMessage,
    EffortLevel,
    GenerateDecisionArgs,
    GenerateDecisionResult,
    OrchestratorDecision,
    PersonaProfile,
    PromptMode,
    ProviderHealthResult,
    ProviderKind,
} from "./types";

const createBotMessage = findByCodeLazy('username:"Clyde"');

const Native = (IS_DISCORD_DESKTOP
    ? (VencordNative.pluginHelpers?.Autocord as PluginNative<typeof import("./native")>)
    : null);

const rerenderListeners = new Set<() => void>();
const channelDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const channelLastDecisionAt = new Map<string, number>();
const inFlightChannels = new Set<string>();
const pendingRetriggerChannels = new Set<string>();
const lastDispatchedByChannel = new Map<string, { content: string; at: number; }>();
let pluginStopped = false;

const FALLBACK_PERSONA_LIST: PersonaProfile[] = [
    DEFAULT_KATIE_PERSONA,
    { id: "shanks", display_name: "shanks", style: "Confident, competitive factions PvPer; quick casual remarks and banter.", constraints: [] },
    { id: "ana", display_name: "ana", style: "Lively, playful, and friendly; teases and reacts naturally in chat.", constraints: [] },
    { id: "mfok", display_name: "mfok", style: "Sharp, direct factions player; quick to push back or clarify facts.", constraints: [] },
    { id: "vnnnm", display_name: "vnnnm", style: "Chill, blunt gamer; skeptical or dry reactions, keeps it real.", constraints: [] },
    { id: "mason", display_name: "mason", style: "Observant, sarcastic wit; speaks candidly about server play and fights.", constraints: [] },
    { id: "Casualties", display_name: "Casualties", style: "High energy, competitive factions grinder; punchy banter.", constraints: [] },
    { id: "Anthony", display_name: "Anthony", style: "Level-headed, dry humor; practical takes on server mechanics and gear.", constraints: [] },
    { id: "joseph", display_name: "joseph", style: "Bold, feisty banter; quick-witted flexes and competitive trash talk.", constraints: [] },
    { id: "Vivek", display_name: "Vivek", style: "Analytical and opinionated; discusses tactics, rules, and server dynamics.", constraints: [] },
];

function triggerAutocordRerender(): void {
    for (const listener of rerenderListeners) {
        try {
            listener();
        } catch {
            // ignore stale listener
        }
    }
}

function getChannelLabel(channelId: string): string {
    const ch = ChannelStore.getChannel(channelId);
    if (!ch) return channelId;
    if (ch.name) return `#${ch.name}`;
    return `DM (${channelId})`;
}

/**
 * Injects a blue Clyde-style ephemeral message whose username & globalName are overridden to "Autocord".
 * Mutates `botMessage` in place (avoiding `mergeDefaults` null-to-object corruption) and syncs
 * `UserStore.getUser("1")` so plugins like `ShowMeYourName` also render "Autocord" instead of "Clyde".
 * Never sends anything over the network; visible only to the local user.
 */
export function sendAutocordBanner(channelId: string, content: string): Message | null {
    if (!channelId || !content.trim()) return null;
    try {
        const botMessage = createBotMessage({ channelId, content, embeds: [] });
        if (!botMessage) return null;

        botMessage.content = content;
        botMessage.flags = (Number(botMessage.flags ?? 0) | 64);

        if (botMessage.author && typeof botMessage.author === "object") {
            botMessage.author.id = "1";
            botMessage.author.username = "Autocord";
            (botMessage.author as any).globalName = "Autocord";
            (botMessage.author as any).global_name = "Autocord";
            botMessage.author.discriminator = "0000";
            botMessage.author.bot = true;
        } else {
            botMessage.author = {
                id: "1",
                username: "Autocord",
                globalName: "Autocord",
                global_name: "Autocord",
                discriminator: "0000",
                bot: true,
            };
        }

        const clydeStoreUser = (UserStore as any)?.getUser?.("1");
        if (clydeStoreUser && typeof clydeStoreUser === "object") {
            clydeStoreUser.username = "Autocord";
            clydeStoreUser.globalName = "Autocord";
            clydeStoreUser.global_name = "Autocord";
        }

        MessageActions.receiveMessage(channelId, botMessage);
        return botMessage as Message;
    } catch (err) {
        console.error("[Autocord] Failed to inject Autocord ephemeral banner:", err);
        return null;
    }
}

/**
 * Formats and displays an OrchestratorDecision as a blue ephemeral "Autocord" preview message.
 * Suppresses silence decisions unless manually triggered or `showSilencePreviews` is enabled.
 */
export function sendAutocordPreview(
    channelId: string,
    decision: OrchestratorDecision,
    isManual = false,
    meta?: {
        provider?: ProviderKind;
        model?: string;
        effort?: EffortLevel;
        durationMs?: number;
        sessionId?: string | null;
        targetAuthorName?: string | null;
    }
): Message | null {
    const isSilence = decision.action === "silence" || !decision.content?.trim();
    if (isSilence && !isManual && !settings.store.showSilencePreviews) {
        return null;
    }

    const lines: string[] = [];
    if (isSilence) {
        lines.push("*(Silence — orchestrator decided not to reply)*");
    } else {
        lines.push(decision.content!.trim());
    }

    if (settings.store.showMetadataFooter) {
        const personaLabel = decision.persona_id || settings.store.personaId || "itsjskt";
        const prov = (meta?.provider || decision.provider || settings.store.provider || "antigravity") as ProviderKind;
        const mod = resolveModelForProvider(prov, meta?.model || decision.model || settings.store.model);
        const eff = meta?.effort || decision.effort || settings.store.effort || "low";
        const dur = meta?.durationMs ?? decision.durationMs;
        const durPart = typeof dur === "number" && dur > 0 ? ` • ${Math.round(dur)}ms` : "";
        const sess = meta?.sessionId ?? decision.sessionId;
        const sessPart = sess ? ` • session \`${String(sess).slice(0, 12)}\`` : "";
        const replyPart = decision.reply_to
            ? `reply_to \`${decision.reply_to}\`${meta?.targetAuthorName ? ` (@${meta.targetAuthorName})` : ""}`
            : "channel message (no reply ping)";

        lines.push("");
        lines.push(`-# **Persona:** \`${personaLabel}\` • **Engine:** \`${prov}/${mod}\` (\`${eff}\`)${durPart}${sessPart} • **Target:** ${replyPart}`);

        const reasonText = (decision.reasoning || decision.diagnostic || "").trim();
        if (reasonText) {
            lines.push(`-# **Reasoning:** ${reasonText}`);
        }
    }

    return sendAutocordBanner(channelId, lines.join("\n"));
}

function sleepMs(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function computeNaturalTypingDelayMs(text: string, suggestedDelaySeconds?: number | null): number {
    if (!settings.store.simulateTypingDelay) return 0;
    if (typeof suggestedDelaySeconds === "number" && Number.isFinite(suggestedDelaySeconds) && suggestedDelaySeconds > 0) {
        return Math.min(8000, Math.max(650, Math.round(suggestedDelaySeconds * 1000)));
    }
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    return Math.min(5500, Math.max(900, words * 240));
}

/**
 * Dispatches a real Discord message in the channel using Discord's internal MessageActions via `sendMessage`.
 * Supports optional natural typing delay and reply messageReference.
 */
export async function dispatchRealReply(
    channelId: string,
    decision: OrchestratorDecision,
    opts?: { bypassChannelCheck?: boolean; }
): Promise<boolean> {
    if (pluginStopped) return false;
    if (decision.action !== "reply" || !decision.content?.trim()) return false;

    const fullContent = decision.content.trim();
    const prev = lastDispatchedByChannel.get(channelId);
    const now = Date.now();
    if (prev && prev.content.toLowerCase() === fullContent.toLowerCase() && now - prev.at < 30_000) {
        return false;
    }

    const parts = fullContent
        .split("\n")
        .map(p => p.trim())
        .filter(Boolean);
    const firstPart = parts[0] || fullContent;
    const secondPart = parts.length > 1 ? parts.slice(1).join(" ") : "";

    const delayMs = computeNaturalTypingDelayMs(firstPart, decision.delay_seconds);
    if (delayMs > 0) {
        try {
            FluxDispatcher.dispatch({ type: "TYPING_START_LOCAL", channelId });
        } catch {
            // ignore
        }
        await sleepMs(delayMs);
    }

    if (pluginStopped) return false;
    if (!opts?.bypassChannelCheck && (!settings.store.enabledGlobally || !isChannelEnabled(channelId))) {
        return false;
    }

    const channelObj = ChannelStore.getChannel(channelId);
    const guildId = channelObj?.guild_id ?? undefined;

    lastDispatchedByChannel.set(channelId, { content: fullContent, at: Date.now() });

    await sendMessage(
        channelId,
        { content: firstPart },
        true,
        decision.reply_to
            ? {
                messageReference: {
                    channel_id: channelId,
                    message_id: decision.reply_to,
                    ...(guildId ? { guild_id: guildId } : {}),
                } as any,
            }
            : {}
    );

    if (secondPart && !pluginStopped) {
        const followupDelay = computeNaturalTypingDelayMs(secondPart, null);
        if (followupDelay > 0) {
            try {
                FluxDispatcher.dispatch({ type: "TYPING_START_LOCAL", channelId });
            } catch {
                // ignore
            }
            await sleepMs(Math.min(3800, Math.max(1400, followupDelay)));
        }
        if (!pluginStopped && (opts?.bypassChannelCheck || (settings.store.enabledGlobally && isChannelEnabled(channelId)))) {
            await sendMessage(channelId, { content: secondPart }, true, {});
        }
    }

    return true;
}

function isEphemeralOrPreviewMessage(msg: any): boolean {
    if (!msg) return true;
    if (msg.deleted) return true;
    const idStr = String(msg.id ?? "");
    if (!idStr || idStr.startsWith("-")) return true;
    const flags = Number(msg.flags ?? 0);
    if ((flags & 64) !== 0) return true;
    const authorId = String(msg.author?.id ?? "");
    const authorUsername = String(msg.author?.username ?? "").toLowerCase();
    if (authorId === "1" || authorUsername === "autocord" || authorUsername === "clyde") return true;
    if (typeof msg.type === "number" && msg.type !== 0 && msg.type !== 19) return true;
    return false;
}

/**
 * Reads recent channel messages strictly from Discord's in-memory `MessageStore` (zero REST requests).
 */
export function collectChannelContext(channelId: string): {
    messages: ContextMessage[];
    addressed: boolean;
    targetMessageId: string | null;
    targetAuthorName: string | null;
    latestIsSelf: boolean;
} {
    const currentUser = UserStore.getCurrentUser();
    const selfId = currentUser?.id ? String(currentUser.id) : "";
    const selfUsername = (currentUser?.username || "").toLowerCase();
    const activePersonaId = (settings.store.personaId || "itsjskt").trim().toLowerCase();

    const storeMessagesObj = MessageStore.getMessages(channelId) as {
        _array?: Message[];
        toArray?: () => Message[];
    } | undefined;
    const rawArray: Message[] = storeMessagesObj?._array
        ?? (typeof storeMessagesObj?.toArray === "function" ? storeMessagesObj.toArray() : [])
        ?? [];

    const maxCount = Math.min(50, Math.max(5, Number(settings.store.contextMessageCount) || 25));
    const filtered = rawArray.filter(m => !isEphemeralOrPreviewMessage(m)).slice(-maxCount);

    const byId = new Map<string, Message>();
    for (const m of rawArray) {
        if (m?.id && !isEphemeralOrPreviewMessage(m)) {
            byId.set(String(m.id), m);
        }
    }

    const resolveParentMessage = (refMsgId: string, childMsg?: any): any => {
        if (!refMsgId) return null;
        if (byId.has(refMsgId)) return byId.get(refMsgId);
        const fromStore = (MessageStore as any)?.getMessage?.(channelId, refMsgId);
        if (fromStore) return fromStore;
        if (childMsg?.referenced_message) return childMsg.referenced_message;
        return null;
    };

    const contextMessages: ContextMessage[] = filtered.map(m => {
        const author = m.author as any;
        const authorId = String(author?.id ?? "");
        const authorName = String(author?.globalName || author?.global_name || author?.username || authorId || "user");
        const rawRefId = (m as any).messageReference?.message_id ?? (m as any).message_reference?.message_id;
        const refMsgId = rawRefId ? String(rawRefId) : null;
        let replyToAuthorName: string | null = null;
        if (refMsgId) {
            const parentMsg = resolveParentMessage(refMsgId, m);
            const parentAuthor = parentMsg?.author;
            replyToAuthorName = parentAuthor
                ? String(parentAuthor.globalName || parentAuthor.global_name || parentAuthor.username || "")
                : null;
        }
        const mentionsList: string[] = Array.isArray((m as any).mentions)
            ? (m as any).mentions.map((u: any) => String(u?.id ?? u ?? "")).filter(Boolean)
            : [];
        const isSelf = Boolean(selfId && authorId === selfId);
        const isBot = Boolean(author?.bot);
        const isWebhook = Boolean((m as any).webhookId || (m as any).webhook_id);
        const tsIso = m.timestamp
            ? (typeof (m.timestamp as any).toISOString === "function"
                ? (m.timestamp as any).toISOString()
                : String(m.timestamp))
            : "";

        return {
            id: String(m.id),
            authorId,
            author_id: authorId,
            authorName,
            author_name: authorName,
            content: String(m.content ?? ""),
            timestamp: tsIso,
            replyTo: refMsgId,
            reply_to: refMsgId,
            replyToAuthorName,
            isBot,
            is_bot: isBot,
            isWebhook,
            is_webhook: isWebhook,
            isSystem: false,
            is_system: false,
            isSelf,
            isOwnPersona: isSelf,
            is_own_persona: isSelf,
            mentions: mentionsList,
        };
    });

    const latestMessage = contextMessages.length > 0 ? contextMessages[contextMessages.length - 1] : null;
    const latestIsSelf = Boolean(latestMessage?.isSelf);

    const lastNonSelf = [...contextMessages].reverse().find(m => !m.isSelf && !m.isBot && !m.isWebhook);
    let addressed = false;
    if (lastNonSelf) {
        const lowerText = lastNonSelf.content.toLowerCase();
        if (selfId && (lastNonSelf.mentions?.includes(selfId) || lowerText.includes(`<@${selfId}>`) || lowerText.includes(`<@!${selfId}>`))) {
            addressed = true;
        } else if (lastNonSelf.replyTo) {
            const repliedMsg = contextMessages.find(cm => cm.id === lastNonSelf.replyTo);
            if (repliedMsg?.isSelf) {
                addressed = true;
            } else if (selfId) {
                const rawTarget = byId.get(lastNonSelf.id);
                const parentMsg = resolveParentMessage(lastNonSelf.replyTo, rawTarget);
                if (parentMsg?.author?.id && String(parentMsg.author.id) === selfId) {
                    addressed = true;
                }
            }
        }
        if (!addressed) {
            const nameCandidates = new Set<string>(["katie", "itsjskt"]);
            if (selfUsername) nameCandidates.add(selfUsername);
            if (activePersonaId) nameCandidates.add(activePersonaId);
            for (const name of nameCandidates) {
                if (name && new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(lowerText)) {
                    addressed = true;
                    break;
                }
            }
        }
    }

    return {
        messages: contextMessages,
        addressed,
        targetMessageId: lastNonSelf?.id ?? null,
        targetAuthorName: lastNonSelf?.authorName ?? null,
        latestIsSelf,
    };
}

/**
 * Executes an orchestrator evaluation for `channelId` and routes the result to Preview or Auto-Send.
 */
export async function runOrchestratorForChannel(
    channelId: string,
    options?: {
        isManual?: boolean;
        forceMode?: "preview" | "autosend";
    }
): Promise<GenerateDecisionResult | null> {
    if (!channelId || pluginStopped) return null;
    const isManual = Boolean(options?.isManual);

    if (!isManual) {
        if (!settings.store.enabledGlobally || !isChannelEnabled(channelId)) {
            return null;
        }
    }

    if (inFlightChannels.has(channelId)) {
        if (isManual) {
            showToast("Autocord is already evaluating this channel…", "message");
        } else {
            pendingRetriggerChannels.add(channelId);
        }
        return null;
    }

    const { messages, addressed, targetMessageId, targetAuthorName, latestIsSelf } = collectChannelContext(channelId);
    if (!isManual && (messages.length === 0 || latestIsSelf || !targetMessageId)) {
        return null;
    }

    const now = Date.now();
    const cooldownMs = Math.max(0, (Number(settings.store.cooldownSeconds) || 0) * 1000);
    const lastAt = channelLastDecisionAt.get(channelId) || 0;
    if (!isManual && !addressed && cooldownMs > 0 && now - lastAt < cooldownMs) {
        return null;
    }

    if (!Native || typeof (Native as any).generateDecision !== "function") {
        if (isManual) {
            sendAutocordBanner(
                channelId,
                "⚠️ **Autocord Native helper is unavailable.** Make sure you are running the Equicord desktop client with the Autocord plugin built."
            );
        }
        return null;
    }

    inFlightChannels.add(channelId);
    channelLastDecisionAt.set(channelId, now);
    triggerAutocordRerender();

    try {
        const currentUser = UserStore.getCurrentUser();
        const channelObj = ChannelStore.getChannel(channelId);
        const guildObj = channelObj?.guild_id ? GuildStore.getGuild(channelObj.guild_id) : undefined;
        const baseArgs = buildProviderSettingsArgs();

        const args: GenerateDecisionArgs = {
            ...baseArgs,
            channelId,
            guildId: channelObj?.guild_id ?? null,
            channelName: channelObj?.name || undefined,
            guildName: guildObj?.name || undefined,
            messages,
            selfUserId: currentUser?.id ? String(currentUser.id) : undefined,
            selfUsername: currentUser?.username || undefined,
            targetMessageId,
            targetAuthorName,
            addressed,
            requireReply: isManual,
        };

        if (isManual) {
            showToast(`Autocord (${args.provider}/${args.model}) thinking…`, "message");
        }

        const result: GenerateDecisionResult = await (Native as any).generateDecision(args);
        if (pluginStopped) return result;

        if (!result || !result.ok || !result.decision) {
            const errMsg = result?.error || "Unknown orchestrator error";
            if (isManual) {
                sendAutocordBanner(
                    channelId,
                    `⚠️ **Autocord Orchestrator Error** (\`${args.provider}/${args.model}\`):\n\`\`\`\n${errMsg}\n\`\`\``
                );
            } else {
                console.warn("[Autocord] Decision error:", errMsg);
            }
            return result;
        }

        const decision = result.decision;
        const postEvalContext = !isManual ? collectChannelContext(channelId) : null;
        const userSpokeDuringInference = Boolean(postEvalContext?.latestIsSelf);

        const shouldAutoSend = !userSpokeDuringInference && (
            options?.forceMode === "autosend"
                ? true
                : options?.forceMode === "preview"
                    ? false
                    : isChannelAutoSend(channelId)
        );

        if (shouldAutoSend) {
            if (decision.action === "reply" && decision.content?.trim()) {
                await dispatchRealReply(channelId, decision, { bypassChannelCheck: isManual });
            } else if (isManual || settings.store.showSilencePreviews) {
                sendAutocordPreview(channelId, decision, isManual, {
                    provider: result.provider,
                    model: result.model,
                    effort: result.effort,
                    durationMs: result.durationMs,
                    sessionId: result.sessionId,
                    targetAuthorName,
                });
            }
        } else {
            sendAutocordPreview(channelId, decision, isManual, {
                provider: result.provider,
                model: result.model,
                effort: result.effort,
                durationMs: result.durationMs,
                sessionId: result.sessionId,
                targetAuthorName,
            });
        }

        return result;
    } catch (err: any) {
        const message = err?.message || String(err);
        if (isManual) {
            sendAutocordBanner(channelId, `⚠️ **Autocord Exception:** \`${message}\``);
        }
        return null;
    } finally {
        inFlightChannels.delete(channelId);
        triggerAutocordRerender();
        if (pendingRetriggerChannels.has(channelId)) {
            pendingRetriggerChannels.delete(channelId);
            if (!pluginStopped && settings.store.enabledGlobally && isChannelEnabled(channelId)) {
                scheduleChannelEvaluation(channelId);
            }
        }
    }
}

function scheduleChannelEvaluation(channelId: string): void {
    const existing = channelDebounceTimers.get(channelId);
    if (existing) clearTimeout(existing);

    const debounceMs = Math.min(15_000, Math.max(250, Number(settings.store.debounceMs) || 1800));
    const timer = setTimeout(() => {
        channelDebounceTimers.delete(channelId);
        void runOrchestratorForChannel(channelId, { isManual: false });
    }, debounceMs);

    channelDebounceTimers.set(channelId, timer);
}

function performClickAction(action: ClickAction, channelId: string): void {
    const label = getChannelLabel(channelId);
    switch (action) {
        case "toggle_channel": {
            const enabled = toggleChannelEnabled(channelId);
            if (enabled && !settings.store.enabledGlobally) {
                settings.store.enabledGlobally = true;
            }
            triggerAutocordRerender();
            const modeStr = isChannelAutoSend(channelId) ? "Auto-Send Mode" : "Blue Preview Mode";
            showToast(
                enabled
                    ? `Autocord ON in ${label} (${modeStr})`
                    : `Autocord OFF in ${label}`,
                enabled ? "success" : "message"
            );
            break;
        }
        case "toggle_autosend": {
            const autoSend = toggleChannelAutoSend(channelId);
            if (autoSend && !settings.store.enabledGlobally) {
                settings.store.enabledGlobally = true;
            }
            triggerAutocordRerender();
            showToast(
                autoSend
                    ? `Autocord Auto-Send ENABLED in ${label}`
                    : `Autocord switched to Blue Preview Mode in ${label}`,
                autoSend ? "success" : "message"
            );
            break;
        }
        case "trigger_preview": {
            void runOrchestratorForChannel(channelId, { isManual: true, forceMode: "preview" });
            break;
        }
        case "trigger_autosend": {
            void runOrchestratorForChannel(channelId, { isManual: true, forceMode: "autosend" });
            break;
        }
        case "toggle_global": {
            settings.store.enabledGlobally = !settings.store.enabledGlobally;
            triggerAutocordRerender();
            showToast(
                settings.store.enabledGlobally ? "Autocord enabled globally" : "Autocord disabled globally",
                settings.store.enabledGlobally ? "success" : "message"
            );
            break;
        }
        case "open_modal": {
            openAutocordControlModal(channelId);
            break;
        }
        case "open_settings": {
            openPluginModal(plugins.Autocord);
            break;
        }
    }
}

function AutocordIcon({ className, height = 20, width = 20 }: { className?: string; height?: number | string; width?: number | string; }) {
    return (
        <svg className={className} width={width} height={height} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path
                fill="currentColor"
                d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h3a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4v-6a4 4 0 0 1 4-4h3V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2Zm-3.5 9a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm-6.25 5.25a.75.75 0 0 0 0 1.5h5.5a.75.75 0 0 0 0-1.5h-5.5ZM2 12a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0v-2a1 1 0 0 1 1-1Zm20 0a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0v-2a1 1 0 0 1 1-1Z"
            />
        </svg>
    );
}

const AutocordChatBarButton: ChatBarButtonFactory = ({ channel, type, isMainChat }) => {
    const {
        enabledGlobally,
        chatIcon,
        enabledChannels,
        autoSendChannels,
        autoSendGlobally,
        provider,
        model,
        effort,
        personaId,
        leftClickAction,
        rightClickAction,
        middleClickAction,
    } = settings.use([
        "enabledGlobally",
        "chatIcon",
        "enabledChannels",
        "autoSendChannels",
        "autoSendGlobally",
        "provider",
        "model",
        "effort",
        "personaId",
        "leftClickAction",
        "rightClickAction",
        "middleClickAction",
    ]);

    const forceUpdate = useForceUpdater();

    useEffect(() => {
        rerenderListeners.add(forceUpdate);
        return () => {
            rerenderListeners.delete(forceUpdate);
        };
    }, [forceUpdate]);

    const validChat = type?.analyticsName
        ? ["normal", "sidebar"].includes(type.analyticsName)
        : Boolean(isMainChat ?? true);

    if (!validChat || !chatIcon || !channel?.id) return null;

    // Reference reactive settings so hooks re-evaluate when lists change
    void enabledChannels;
    void autoSendChannels;
    void autoSendGlobally;

    const channelActive = enabledGlobally && isChannelEnabled(channel.id);
    const autoSendActive = channelActive && isChannelAutoSend(channel.id);
    const isBusy = inFlightChannels.has(channel.id);

    const activeModel = resolveModelForProvider((provider || "antigravity") as ProviderKind, model);
    const statusLabel = !enabledGlobally
        ? "Autocord Disabled Globally"
        : !channelActive
            ? `Autocord OFF (${getChannelLabel(channel.id)})`
            : autoSendActive
                ? `Autocord AUTO-SEND ON (${getChannelLabel(channel.id)})`
                : `Autocord PREVIEW ON (${getChannelLabel(channel.id)})`;

    const tooltip = `${statusLabel} • ${provider}/${activeModel} (${effort}) • ${personaId || "itsjskt"}${isBusy ? " • Thinking…" : ""} (L: Toggle | R: Auto-Send | M: Config)`;

    const iconColor = isBusy
        ? "#f0b232"
        : autoSendActive
            ? "var(--status-positive)"
            : channelActive
                ? "#5865f2"
                : "currentColor";

    return (
        <ChatBarButton
            tooltip={tooltip}
            buttonProps={{
                onMouseDown: e => {
                    if (e.button === 1) {
                        e.preventDefault();
                    }
                },
            }}
            onClick={e => {
                if (e.button === 0) {
                    performClickAction((leftClickAction || "toggle_channel") as ClickAction, channel.id);
                }
            }}
            onAuxClick={e => {
                if (e.button === 1) {
                    e.preventDefault();
                    e.stopPropagation();
                    performClickAction((middleClickAction || "open_modal") as ClickAction, channel.id);
                }
            }}
            onContextMenu={e => {
                e.preventDefault();
                e.stopPropagation();
                performClickAction((rightClickAction || "toggle_autosend") as ClickAction, channel.id);
            }}
        >
            <svg width="20" height="20" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" style={{ scale: "1.18", color: iconColor }}>
                <path
                    fill="currentColor"
                    mask={!channelActive ? `url(#autocord-msg-mask-${channel.id})` : undefined}
                    d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h3a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4v-6a4 4 0 0 1 4-4h3V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2Zm-3.5 9a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm-6.25 5.25a.75.75 0 0 0 0 1.5h5.5a.75.75 0 0 0 0-1.5h-5.5ZM2 12a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0v-2a1 1 0 0 1 1-1Zm20 0a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0v-2a1 1 0 0 1 1-1Z"
                />
                {!channelActive && (
                    <>
                        <mask id={`autocord-msg-mask-${channel.id}`}>
                            <path fill="#fff" d="M0 0h24v24H0Z" />
                            <path stroke="#000" strokeWidth="5.99068" d="M0 24 24 0" />
                        </mask>
                        <path
                            fill="var(--status-danger)"
                            d="m21.178 1.70703 1.414 1.414L4.12103 21.593l-1.414-1.415L21.178 1.70703Z"
                        />
                    </>
                )}
                {channelActive && autoSendActive && (
                    <g>
                        <circle cx="18.5" cy="18.5" r="5.2" fill="#111214" />
                        <circle cx="18.5" cy="18.5" r="4.2" fill="var(--status-positive)" />
                        <path
                            fill="#ffffff"
                            d="M19.1 15.2 16.4 18.6h1.7l-.4 2.2 2.7-3.4h-1.7l.4-2.2Z"
                        />
                    </g>
                )}
                {channelActive && !autoSendActive && (
                    <g>
                        <circle cx="18.5" cy="18.5" r="4.6" fill="#111214" />
                        <circle cx="18.5" cy="18.5" r="3.4" fill="#5865f2" />
                    </g>
                )}
            </svg>
        </ChatBarButton>
    );
};

export function openAutocordControlModal(channelId?: string): void {
    const resolvedChannelId = channelId || SelectedChannelStore.getChannelId() || "1433348311502422129";
    openModal(modalProps => <AutocordControlModal modalProps={modalProps} channelId={resolvedChannelId} />);
}

function AutocordControlModal({ modalProps, channelId }: { modalProps: RenderModalProps; channelId: string; }) {
    const s = settings.use([
        "enabledGlobally",
        "enabledChannels",
        "autoSendChannels",
        "autoSendGlobally",
        "provider",
        "model",
        "effort",
        "personaId",
        "personasPath",
        "promptMode",
        "customPrompt",
        "openaiApiKey",
        "openaiBaseUrl",
        "nvidiaApiKey",
        "nvidiaBaseUrl",
        "grokApiKey",
        "grokBaseUrl",
        "anthropicApiKey",
        "antigravityProject",
        "antigravityPath",
        "codexCliPath",
        "claudeCliPath",
        "grokCliPath",
        "reuseLocalSession",
        "showMetadataFooter",
        "showSilencePreviews",
        "simulateTypingDelay",
        "leftClickAction",
        "rightClickAction",
        "middleClickAction",
    ]);

    void s.enabledChannels;
    void s.autoSendChannels;

    const mountedRef = useRef(true);
    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    const [personas, setPersonas] = useState<PersonaProfile[]>(FALLBACK_PERSONA_LIST);
    const [liveModels, setLiveModels] = useState<string[]>([]);
    const [healthReport, setHealthReport] = useState<ProviderHealthResult | null>(null);
    const [sessionMap, setSessionMap] = useState<Record<string, string>>({});
    const [busyAction, setBusyAction] = useState<string | null>(null);

    const activeProvider = (s.provider || "antigravity") as ProviderKind;
    const resolvedActiveModel = resolveModelForProvider(activeProvider, s.model);
    const channelEnabled = isChannelEnabled(channelId);
    const channelAutoSend = isChannelAutoSend(channelId);
    const channelLabel = getChannelLabel(channelId);

    const refreshSessionInfo = () => {
        if (Native && typeof (Native as any).getSessionInfo === "function") {
            Promise.resolve((Native as any).getSessionInfo({ channelId }))
                .then((res: any) => {
                    if (!mountedRef.current) return;
                    if (res?.sessionMap && typeof res.sessionMap === "object" && !Array.isArray(res.sessionMap)) {
                        setSessionMap(res.sessionMap);
                    } else if (Array.isArray(res?.sessions)) {
                        const map: Record<string, string> = {};
                        for (const item of res.sessions) {
                            if (item?.provider && item?.channelId && item?.sessionId) {
                                map[`${item.provider}::${item.channelId}`] = String(item.sessionId);
                                map[`${item.provider}:${item.channelId}`] = String(item.sessionId);
                            }
                        }
                        setSessionMap(map);
                    } else if (res?.sessions && typeof res.sessions === "object") {
                        setSessionMap(res.sessions);
                    }
                })
                .catch(() => {
                    // ignore
                });
        }
    };

    useEffect(() => {
        if (Native && typeof (Native as any).loadPersonas === "function") {
            Promise.resolve((Native as any).loadPersonas(s.personasPath || undefined))
                .then((res: any) => {
                    if (!mountedRef.current) return;
                    const loaded: PersonaProfile[] = Array.isArray(res)
                        ? res
                        : Array.isArray(res?.personas)
                            ? res.personas
                            : [];
                    if (loaded.length > 0) {
                        setPersonas(loaded);
                    }
                })
                .catch(() => {
                    // keep fallback personas
                });
        }
    }, [s.personasPath]);

    useEffect(() => {
        refreshSessionInfo();
    }, [channelId, activeProvider]);

    const suggestedModels = Array.from(
        new Set([
            ...(liveModels.length > 0 ? liveModels : []),
            ...(PROVIDER_MODEL_SUGGESTIONS[activeProvider] || []),
        ])
    );

    async function handleFetchModels() {
        if (!Native || typeof (Native as any).listProviderModels !== "function") {
            showToast("Model discovery requires the Equicord desktop native helper.", "failure");
            return;
        }
        setBusyAction("models");
        try {
            const res = await (Native as any).listProviderModels(buildProviderSettingsArgs());
            if (!mountedRef.current) return;
            const discovered: string[] = Array.isArray(res)
                ? res
                : Array.isArray(res?.models)
                    ? res.models
                    : [];
            if (discovered.length > 0) {
                setLiveModels(discovered);
                showToast(`Loaded ${discovered.length} models for ${activeProvider}`, "success");
            } else {
                showToast(res?.error || `No dynamic models returned for ${activeProvider}; using presets`, "message");
            }
        } catch (err: any) {
            showToast(`Model fetch failed: ${err?.message || err}`, "failure");
        } finally {
            if (mountedRef.current) setBusyAction(null);
        }
    }

    async function handleCheckHealth() {
        if (!Native || typeof (Native as any).checkProvidersHealth !== "function") {
            showToast("Health check requires the Equicord desktop native helper.", "failure");
            return;
        }
        setBusyAction("health");
        try {
            const res: ProviderHealthResult = await (Native as any).checkProvidersHealth(buildProviderSettingsArgs());
            if (!mountedRef.current) return;
            setHealthReport(res);
            showToast("Provider health check complete", res?.ok ? "success" : "message");
        } catch (err: any) {
            showToast(`Health check failed: ${err?.message || err}`, "failure");
        } finally {
            if (mountedRef.current) setBusyAction(null);
        }
    }

    async function handleResetSession() {
        if (!Native || typeof (Native as any).resetSession !== "function") {
            showToast("Session reset requires the Equicord desktop native helper.", "failure");
            return;
        }
        setBusyAction("reset");
        try {
            await (Native as any).resetSession({ channelId, provider: activeProvider });
            refreshSessionInfo();
            showToast(`Reset local ${activeProvider} session for ${channelLabel}`, "success");
        } catch (err: any) {
            showToast(`Failed to reset session: ${err?.message || err}`, "failure");
        } finally {
            if (mountedRef.current) setBusyAction(null);
        }
    }

    async function handleTriggerNow(mode: "preview" | "autosend") {
        setBusyAction(mode);
        try {
            await runOrchestratorForChannel(channelId, { isManual: true, forceMode: mode });
            refreshSessionInfo();
        } finally {
            if (mountedRef.current) setBusyAction(null);
        }
    }

    const activeProviderSessionKey = `${activeProvider}::${channelId}`;
    const activeProviderSessionId = sessionMap[activeProviderSessionKey] || null;

    return (
        <Modal
            {...modalProps}
            title={`Autocord Orchestrator — ${channelLabel}`}
            actions={[
                {
                    text: busyAction === "preview" ? "Drafting Preview…" : "Preview Now (Autocord Banner)",
                    variant: "primary",
                    disabled: Boolean(busyAction),
                    onClick: () => handleTriggerNow("preview"),
                },
                {
                    text: busyAction === "autosend" ? "Sending…" : "Auto-Send Reply Now",
                    variant: "secondary",
                    disabled: Boolean(busyAction),
                    onClick: () => handleTriggerNow("autosend"),
                },
                {
                    text: busyAction === "health" ? "Testing…" : "Test Providers",
                    variant: "secondary",
                    disabled: Boolean(busyAction),
                    onClick: handleCheckHealth,
                },
                {
                    text: busyAction === "reset" ? "Resetting…" : "Reset Local Session",
                    variant: "secondary",
                    disabled: Boolean(busyAction),
                    onClick: handleResetSession,
                },
            ]}
        >
            <Flex flexDirection="column" gap="12px" style={{ padding: "4px 0" }}>
                <FormSwitch
                    title={`Enable Autocord in ${channelLabel}`}
                    description="Left-click the chat bar icon to toggle. Defaults to blue 'Autocord' preview mode when enabled."
                    value={channelEnabled}
                    onChange={val => {
                        setChannelEnabled(channelId, val);
                        if (val && !settings.store.enabledGlobally) {
                            settings.store.enabledGlobally = true;
                        }
                        triggerAutocordRerender();
                    }}
                    hideBorder
                />

                <FormSwitch
                    title={`Auto-Send Mode in ${channelLabel}`}
                    description="Right-click the chat bar icon to toggle. When ON, replies are dispatched directly to chat instead of showing a blue 'Autocord' preview."
                    value={channelAutoSend}
                    onChange={val => {
                        setChannelAutoSend(channelId, val);
                        if (val && !channelEnabled) {
                            setChannelEnabled(channelId, true);
                        }
                        triggerAutocordRerender();
                    }}
                    hideBorder
                />

                <Divider />

                <Heading tag="h5">Provider, Model & Effort</Heading>
                <Select
                    placeholder="Select AI Provider"
                    options={PROVIDER_OPTIONS}
                    maxVisibleItems={6}
                    closeOnSelect={true}
                    select={(val: ProviderKind) => {
                        settings.store.provider = val;
                        const defaultForProv = DEFAULT_MODEL_BY_PROVIDER[val] || PROVIDER_MODEL_SUGGESTIONS[val]?.[0] || "pro";
                        settings.store.model = defaultForProv;
                        setLiveModels([]);
                        triggerAutocordRerender();
                    }}
                    isSelected={(val: ProviderKind) => val === activeProvider}
                    serialize={(val: ProviderKind) => String(val)}
                />

                <Flex flexDirection="row" gap="8px" alignItems="center">
                    <div style={{ flex: 1 }}>
                        <TextInput
                            type="text"
                            value={resolvedActiveModel}
                            onChange={(val: string) => {
                                settings.store.model = val;
                                triggerAutocordRerender();
                            }}
                            placeholder={DEFAULT_MODEL_BY_PROVIDER[activeProvider] || "Model ID"}
                        />
                    </div>
                    <Button
                        size="small"
                        variant="secondary"
                        disabled={Boolean(busyAction)}
                        onClick={handleFetchModels}
                    >
                        {busyAction === "models" ? "Loading…" : "Fetch Models"}
                    </Button>
                </Flex>

                <Flex flexDirection="row" gap="6px" style={{ flexWrap: "wrap" }}>
                    {suggestedModels.slice(0, 8).map(presetModel => (
                        <Button
                            key={presetModel}
                            size="xs"
                            variant={resolvedActiveModel === presetModel ? "primary" : "secondary"}
                            onClick={() => {
                                settings.store.model = presetModel;
                                triggerAutocordRerender();
                            }}
                        >
                            {presetModel}
                        </Button>
                    ))}
                </Flex>

                <Select
                    placeholder="Select Reasoning Effort"
                    options={EFFORT_OPTIONS}
                    maxVisibleItems={4}
                    closeOnSelect={true}
                    select={(val: EffortLevel) => {
                        settings.store.effort = val;
                        triggerAutocordRerender();
                    }}
                    isSelected={(val: EffortLevel) => val === (s.effort || "low")}
                    serialize={(val: EffortLevel) => String(val)}
                />

                <Divider />
                <Heading tag="h5">Provider Configuration ({activeProvider.toUpperCase()})</Heading>
                {activeProvider === "antigravity" && (
                    <>
                        <TextInput
                            type="text"
                            value={s.antigravityProject || ""}
                            onChange={(val: string) => { settings.store.antigravityProject = val; }}
                            placeholder="Antigravity Project ID (5f396b27-5d07-5e60-9343-41bbd9061036)"
                        />
                        <TextInput
                            type="text"
                            value={s.antigravityPath || ""}
                            onChange={(val: string) => { settings.store.antigravityPath = val; }}
                            placeholder="Local agy CLI path (optional fallback; Connect-RPC used by default)"
                        />
                    </>
                )}
                {activeProvider === "nvidia" && (
                    <>
                        <TextInput
                            type="password"
                            value={s.nvidiaApiKey || ""}
                            onChange={(val: string) => { settings.store.nvidiaApiKey = val; }}
                            placeholder="nvapi-... (or set NVIDIA_API_KEY env var)"
                        />
                        <TextInput
                            type="text"
                            value={s.nvidiaBaseUrl || ""}
                            onChange={(val: string) => { settings.store.nvidiaBaseUrl = val; }}
                            placeholder="https://integrate.api.nvidia.com/v1"
                        />
                    </>
                )}
                {activeProvider === "openai" && (
                    <>
                        <TextInput
                            type="password"
                            value={s.openaiApiKey || ""}
                            onChange={(val: string) => { settings.store.openaiApiKey = val; }}
                            placeholder="sk-... (or set OPENAI_API_KEY env var)"
                        />
                        <TextInput
                            type="text"
                            value={s.openaiBaseUrl || ""}
                            onChange={(val: string) => { settings.store.openaiBaseUrl = val; }}
                            placeholder="https://api.openai.com/v1"
                        />
                    </>
                )}
                {activeProvider === "codex" && (
                    <TextInput
                        type="text"
                        value={s.codexCliPath || ""}
                        onChange={(val: string) => { settings.store.codexCliPath = val; }}
                        placeholder="Local codex CLI path (leave empty for PATH discovery)"
                    />
                )}
                {activeProvider === "claude" && (
                    <>
                        <TextInput
                            type="text"
                            value={s.claudeCliPath || ""}
                            onChange={(val: string) => { settings.store.claudeCliPath = val; }}
                            placeholder="Local claude CLI path (leave empty for PATH discovery)"
                        />
                        <TextInput
                            type="password"
                            value={s.anthropicApiKey || ""}
                            onChange={(val: string) => { settings.store.anthropicApiKey = val; }}
                            placeholder="sk-ant-... (optional if Claude Code CLI is logged in)"
                        />
                    </>
                )}
                {activeProvider === "grok" && (
                    <>
                        <TextInput
                            type="password"
                            value={s.grokApiKey || ""}
                            onChange={(val: string) => { settings.store.grokApiKey = val; }}
                            placeholder="xai-... (optional if using local Grok CLI)"
                        />
                        <TextInput
                            type="text"
                            value={s.grokBaseUrl || ""}
                            onChange={(val: string) => { settings.store.grokBaseUrl = val; }}
                            placeholder="https://api.x.ai/v1"
                        />
                        <TextInput
                            type="text"
                            value={s.grokCliPath || ""}
                            onChange={(val: string) => { settings.store.grokCliPath = val; }}
                            placeholder="Local grok CLI path (leave empty for PATH discovery)"
                        />
                    </>
                )}

                <Span size="sm" color="text-subtle">
                    <strong>Active Channel Session ({activeProvider}):</strong>{" "}
                    {activeProviderSessionId ? <code>{activeProviderSessionId}</code> : "No persistent session bound yet for this channel."}
                </Span>

                <Divider />

                <Heading tag="h5">Persona & Orchestrator Prompting</Heading>
                <Select
                    placeholder="Select Active Persona"
                    options={personas.map(p => ({
                        label: `${p.display_name || p.id} (${p.id}) — ${(p.style || "").slice(0, 65)}…`,
                        value: p.id,
                    }))}
                    maxVisibleItems={6}
                    closeOnSelect={true}
                    select={(val: string) => {
                        settings.store.personaId = val;
                        triggerAutocordRerender();
                    }}
                    isSelected={(val: string) => val.toLowerCase() === (s.personaId || "itsjskt").toLowerCase()}
                    serialize={(val: string) => String(val)}
                />

                <Select
                    placeholder="Select Custom Prompt Mode"
                    options={PROMPT_MODE_OPTIONS}
                    maxVisibleItems={2}
                    closeOnSelect={true}
                    select={(val: PromptMode) => { settings.store.promptMode = val; }}
                    isSelected={(val: PromptMode) => val === (s.promptMode || "append")}
                    serialize={(val: PromptMode) => String(val)}
                />

                <TextArea
                    value={s.customPrompt || ""}
                    onChange={(val: string) => { settings.store.customPrompt = val; }}
                    placeholder="Add custom orchestrator instructions here (e.g., 'keep replies under 7 words, ask about their Valorant rank, stay extra sweet')…"
                    rows={3}
                />

                <FormSwitch
                    title="Show Metadata Footer in Blue Autocord Previews"
                    description="Display persona, provider/model/effort, latency, session ID, target message, and reasoning below the drafted text."
                    value={Boolean(s.showMetadataFooter)}
                    onChange={val => { settings.store.showMetadataFooter = val; }}
                    hideBorder
                />

                <FormSwitch
                    title="Show Silence Previews"
                    description="Show a blue 'Autocord' preview even when the orchestrator decides action='silence'."
                    value={Boolean(s.showSilencePreviews)}
                    onChange={val => { settings.store.showSilencePreviews = val; }}
                    hideBorder
                />

                <FormSwitch
                    title="Reuse Persistent Local Chat Sessions per Channel"
                    description="Maintain stateful per-channel local sessions for Antigravity, Codex, Claude Code, and Grok."
                    value={Boolean(s.reuseLocalSession)}
                    onChange={val => { settings.store.reuseLocalSession = val; }}
                    hideBorder
                />

                <Divider />
                <Heading tag="h5">Chat Bar Button Click Bindings</Heading>
                <Select
                    placeholder="Left-Click Action"
                    options={CLICK_ACTION_OPTIONS}
                    maxVisibleItems={7}
                    closeOnSelect={true}
                    select={(val: ClickAction) => { settings.store.leftClickAction = val; }}
                    isSelected={(val: ClickAction) => val === (s.leftClickAction || "toggle_channel")}
                    serialize={(val: ClickAction) => String(val)}
                />
                <Select
                    placeholder="Right-Click Action"
                    options={CLICK_ACTION_OPTIONS}
                    maxVisibleItems={7}
                    closeOnSelect={true}
                    select={(val: ClickAction) => { settings.store.rightClickAction = val; }}
                    isSelected={(val: ClickAction) => val === (s.rightClickAction || "toggle_autosend")}
                    serialize={(val: ClickAction) => String(val)}
                />
                <Select
                    placeholder="Middle-Click Action"
                    options={CLICK_ACTION_OPTIONS}
                    maxVisibleItems={7}
                    closeOnSelect={true}
                    select={(val: ClickAction) => { settings.store.middleClickAction = val; }}
                    isSelected={(val: ClickAction) => val === (s.middleClickAction || "open_modal")}
                    serialize={(val: ClickAction) => String(val)}
                />

                {healthReport && (
                    <>
                        <Divider />
                        <Heading tag="h5">Provider Connectivity Status</Heading>
                        <Flex flexDirection="column" gap="4px">
                            {Object.values(healthReport.providers || {}).map(item => (
                                <Span key={item.provider} size="sm" color={item.healthy ? "text-strong" : "text-subtle"}>
                                    {item.healthy ? "✅" : "⚠️"} <strong>{item.provider}</strong> ({item.mode}) — {item.detail}
                                </Span>
                            ))}
                        </Flex>
                    </>
                )}
            </Flex>
        </Modal>
    );
}

function AutocordSettingsAbout() {
    const currentChannelId = SelectedChannelStore.getChannelId() || "1433348311502422129";
    return (
        <Flex flexDirection="column" gap="8px" style={{ marginBottom: "12px" }}>
            <Paragraph>
                <strong>Chat Bar Button Controls:</strong> Left-Click toggles Autocord ON/OFF for the current channel (defaults to blue <strong>Autocord</strong> preview mode); Right-Click toggles <strong>Auto-Send Mode</strong> ON/OFF; Middle-Click opens the live <strong>Autocord Control Modal</strong>. All click bindings are customizable below.
            </Paragraph>
            <Flex flexDirection="row" gap="8px" style={{ flexWrap: "wrap" }}>
                <Button size="small" variant="primary" onClick={() => openAutocordControlModal(currentChannelId)}>
                    Open Autocord Control Modal
                </Button>
                <Button
                    size="small"
                    variant="secondary"
                    onClick={() => void runOrchestratorForChannel(currentChannelId, { isManual: true, forceMode: "preview" })}
                >
                    Trigger Preview in Current Channel
                </Button>
            </Flex>
        </Flex>
    );
}

const ChatBarContextMenuPatch: NavContextMenuPatchCallback = children => {
    const {
        chatContextMenu,
        enabledGlobally,
        showMetadataFooter,
        showSilencePreviews,
        provider,
        effort,
    } = settings.use([
        "chatContextMenu",
        "enabledGlobally",
        "showMetadataFooter",
        "showSilencePreviews",
        "provider",
        "effort",
    ]);

    if (!chatContextMenu) return;

    const channelId = SelectedChannelStore.getChannelId();
    if (!channelId) return;

    const group = findGroupChildrenByChildId("submit-button", children as (React.ReactElement | null | undefined)[]) ?? children;
    if (!group) return;

    const channelEnabled = isChannelEnabled(channelId);
    const channelAutoSend = isChannelAutoSend(channelId);
    const idx = group.findIndex((c: any) => c?.props?.id === "submit-button");

    group.splice(
        idx >= 0 ? idx : group.length,
        0,
        <Menu.MenuItem id="vc-autocord-menu" label="Autocord">
            <Menu.MenuCheckboxItem
                id="vc-autocord-channel-enabled"
                label={`Enabled in ${getChannelLabel(channelId)}`}
                checked={channelEnabled}
                action={() => performClickAction("toggle_channel", channelId)}
            />
            <Menu.MenuCheckboxItem
                id="vc-autocord-channel-autosend"
                label="Auto-Send Mode (Live Dispatch)"
                checked={channelAutoSend}
                action={() => performClickAction("toggle_autosend", channelId)}
            />
            <Menu.MenuCheckboxItem
                id="vc-autocord-global-enabled"
                label="Enabled Globally"
                checked={enabledGlobally}
                action={() => performClickAction("toggle_global", channelId)}
            />
            <Menu.MenuSeparator />
            <Menu.MenuItem
                id="vc-autocord-trigger-preview"
                label="Trigger 'Autocord' Blue Preview Now"
                action={() => performClickAction("trigger_preview", channelId)}
            />
            <Menu.MenuItem
                id="vc-autocord-trigger-autosend"
                label="Trigger Auto-Send Reply Now"
                action={() => performClickAction("trigger_autosend", channelId)}
            />
            <Menu.MenuSeparator />
            <Menu.MenuItem id="vc-autocord-provider-sub" label={`Provider (${provider})`}>
                {PROVIDER_OPTIONS.map(opt => (
                    <Menu.MenuRadioItem
                        key={opt.value}
                        group="vc-autocord-provider"
                        id={`vc-autocord-prov-${opt.value}`}
                        label={opt.label}
                        checked={provider === opt.value}
                        action={() => {
                            settings.store.provider = opt.value;
                            settings.store.model = DEFAULT_MODEL_BY_PROVIDER[opt.value] || "pro";
                            triggerAutocordRerender();
                        }}
                    />
                ))}
            </Menu.MenuItem>
            <Menu.MenuItem id="vc-autocord-effort-sub" label={`Effort (${effort})`}>
                {EFFORT_OPTIONS.map(opt => (
                    <Menu.MenuRadioItem
                        key={opt.value}
                        group="vc-autocord-effort"
                        id={`vc-autocord-eff-${opt.value}`}
                        label={opt.label}
                        checked={effort === opt.value}
                        action={() => {
                            settings.store.effort = opt.value;
                            triggerAutocordRerender();
                        }}
                    />
                ))}
            </Menu.MenuItem>
            <Menu.MenuCheckboxItem
                id="vc-autocord-metadata-footer"
                label="Show Metadata Footer in Previews"
                checked={showMetadataFooter}
                action={() => { settings.store.showMetadataFooter = !settings.store.showMetadataFooter; }}
            />
            <Menu.MenuCheckboxItem
                id="vc-autocord-silence-previews"
                label="Show Silence Previews"
                checked={showSilencePreviews}
                action={() => { settings.store.showSilencePreviews = !settings.store.showSilencePreviews; }}
            />
            <Menu.MenuSeparator />
            <Menu.MenuItem
                id="vc-autocord-open-modal"
                label="Open Autocord Control Modal…"
                action={() => openAutocordControlModal(channelId)}
            />
            <Menu.MenuItem
                id="vc-autocord-open-settings"
                label="Open Plugin Settings…"
                action={() => openPluginModal(plugins.Autocord)}
            />
        </Menu.MenuItem>
    );
};

export default definePlugin({
    name: "Autocord",
    description: "Multi-provider AI chat orchestrator (Local Antigravity, Codex, Claude Code, Grok, NVIDIA Build & OpenAI-compatible APIs) with SilentTyping-style chat bar toggle, right-click Auto-Send, and blue 'Autocord' ephemeral previews.",
    authors: [{ name: "Eccys", id: 0n }],
    tags: ["Chat", "Utility", "Customisation"],
    dependencies: ["CommandsAPI", "ChatInputButtonAPI", "ContextMenuAPI"],
    settings,
    settingsAboutComponent: AutocordSettingsAbout,

    chatBarButton: {
        icon: AutocordIcon,
        render: AutocordChatBarButton,
    },

    contextMenus: {
        "textarea-context": ChatBarContextMenuPatch,
    },

    flux: {
        MESSAGE_CREATE({ message, optimistic }: { message: Message; optimistic?: boolean; }) {
            if (pluginStopped || optimistic || !message) return;
            const channelId = message.channel_id;
            if (!channelId) return;
            if (!settings.store.enabledGlobally || !isChannelEnabled(channelId)) return;

            const currentUserId = UserStore.getCurrentUser()?.id;
            if (!message.author) return;
            if (currentUserId && message.author.id === currentUserId) {
                const pendingTimer = channelDebounceTimers.get(channelId);
                if (pendingTimer) {
                    clearTimeout(pendingTimer);
                    channelDebounceTimers.delete(channelId);
                }
                pendingRetriggerChannels.delete(channelId);
                return;
            }
            if (isEphemeralOrPreviewMessage(message)) return;
            if (message.author.bot || (message as any).webhook_id || (message as any).webhookId) return;

            scheduleChannelEvaluation(channelId);
        },
    },

    commands: [
        {
            name: "autocord",
            description: "Control the Autocord AI orchestrator, trigger a blue 'Autocord' preview, or check local/API providers.",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "action",
                    description: "Action to run in the current channel",
                    type: ApplicationCommandOptionType.STRING,
                    required: false,
                    choices: [
                        { name: "Trigger Blue 'Autocord' Preview Now", label: "Trigger Blue 'Autocord' Preview Now", value: "preview" },
                        { name: "Trigger Auto-Send Reply Now", label: "Trigger Auto-Send Reply Now", value: "autosend" },
                        { name: "Toggle Channel ON/OFF", label: "Toggle Channel ON/OFF", value: "toggle" },
                        { name: "Toggle Channel Auto-Send Mode", label: "Toggle Channel Auto-Send Mode", value: "toggle-autosend" },
                        { name: "Check Local & API Providers Health", label: "Check Local & API Providers Health", value: "health" },
                        { name: "Reset Local Chat Session for Channel", label: "Reset Local Chat Session for Channel", value: "reset-session" },
                        { name: "Open Autocord Control Modal", label: "Open Autocord Control Modal", value: "modal" },
                    ],
                },
                {
                    name: "provider",
                    description: "Switch active AI provider",
                    type: ApplicationCommandOptionType.STRING,
                    required: false,
                    choices: [
                        { name: "Antigravity (Local Connect-RPC)", label: "Antigravity (Local Connect-RPC)", value: "antigravity" },
                        { name: "NVIDIA Build (NIM)", label: "NVIDIA Build (NIM)", value: "nvidia" },
                        { name: "OpenAI / Compatible API", label: "OpenAI / Compatible API", value: "openai" },
                        { name: "Codex (Local CLI)", label: "Codex (Local CLI)", value: "codex" },
                        { name: "Claude Code (Local CLI)", label: "Claude Code (Local CLI)", value: "claude" },
                        { name: "Grok (Local CLI / xAI API)", label: "Grok (Local CLI / xAI API)", value: "grok" },
                    ],
                },
                {
                    name: "model",
                    description: "Override model name for the orchestrator",
                    type: ApplicationCommandOptionType.STRING,
                    required: false,
                },
                {
                    name: "effort",
                    description: "Reasoning / thinking effort level",
                    type: ApplicationCommandOptionType.STRING,
                    required: false,
                    choices: [
                        { name: "Low", label: "Low", value: "low" },
                        { name: "Medium", label: "Medium", value: "medium" },
                        { name: "High", label: "High", value: "high" },
                        { name: "Extra High (xhigh)", label: "Extra High (xhigh)", value: "xhigh" },
                    ],
                },
                {
                    name: "persona",
                    description: "Switch active persona ID (e.g. itsjskt, shanks, ana, mfok, vnnnm, mason)",
                    type: ApplicationCommandOptionType.STRING,
                    required: false,
                },
                {
                    name: "prompt",
                    description: "Set custom orchestrator steering prompt",
                    type: ApplicationCommandOptionType.STRING,
                    required: false,
                },
            ],
            execute: async (args, ctx) => {
                const channelId = ctx.channel.id;
                const action = findOption<string>(args, "action");
                const providerOpt = findOption<ProviderKind>(args, "provider");
                const modelOpt = findOption<string>(args, "model");
                const effortOpt = findOption<EffortLevel>(args, "effort");
                const personaOpt = findOption<string>(args, "persona");
                const promptOpt = findOption<string>(args, "prompt");

                const changes: string[] = [];
                if (providerOpt) {
                    settings.store.provider = providerOpt;
                    if (!modelOpt) {
                        settings.store.model = DEFAULT_MODEL_BY_PROVIDER[providerOpt] || "pro";
                    }
                    changes.push(`provider → \`${providerOpt}\``);
                }
                if (modelOpt) {
                    settings.store.model = modelOpt.trim();
                    changes.push(`model → \`${modelOpt.trim()}\``);
                }
                if (effortOpt) {
                    settings.store.effort = effortOpt;
                    changes.push(`effort → \`${effortOpt}\``);
                }
                if (personaOpt) {
                    settings.store.personaId = personaOpt.trim();
                    changes.push(`persona → \`${personaOpt.trim()}\``);
                }
                if (typeof promptOpt === "string") {
                    settings.store.customPrompt = promptOpt;
                    changes.push(promptOpt.trim() ? `customPrompt updated` : `customPrompt cleared`);
                }
                if (changes.length > 0) {
                    triggerAutocordRerender();
                }

                if (action === "modal") {
                    openAutocordControlModal(channelId);
                    return;
                }
                if (action === "toggle") {
                    performClickAction("toggle_channel", channelId);
                    return;
                }
                if (action === "toggle-autosend") {
                    performClickAction("toggle_autosend", channelId);
                    return;
                }
                if (action === "reset-session") {
                    if (Native && typeof (Native as any).resetSession === "function") {
                        await (Native as any).resetSession({ channelId, provider: settings.store.provider });
                        sendAutocordBanner(channelId, `🔄 Reset local **${settings.store.provider}** chat session for ${getChannelLabel(channelId)}.`);
                    }
                    return;
                }
                if (action === "health") {
                    if (Native && typeof (Native as any).checkProvidersHealth === "function") {
                        const report: ProviderHealthResult = await (Native as any).checkProvidersHealth(buildProviderSettingsArgs());
                        const lines = Object.values(report.providers || {}).map(
                            p => `• ${p.healthy ? "✅" : "⚠️"} **${p.provider}** (\`${p.mode}\` • default \`${p.defaultModel}\`): ${p.detail}`
                        );
                        sendAutocordBanner(channelId, `**Autocord Provider Health Report**\n${lines.join("\n")}`);
                    }
                    return;
                }
                if (action === "autosend") {
                    await runOrchestratorForChannel(channelId, { isManual: true, forceMode: "autosend" });
                    return;
                }
                if (action === "preview" || changes.length === 0) {
                    await runOrchestratorForChannel(channelId, { isManual: true, forceMode: "preview" });
                    return;
                }

                const activeProv = (settings.store.provider || "antigravity") as ProviderKind;
                const activeMod = resolveModelForProvider(activeProv, settings.store.model);
                sendAutocordBanner(
                    channelId,
                    `Updated Autocord settings: ${changes.join(", ")}. Current engine: \`${activeProv}/${activeMod}\` (\`${settings.store.effort}\`).`
                );
            },
        },
    ],

    start() {
        pluginStopped = false;
        triggerAutocordRerender();
    },

    stop() {
        pluginStopped = true;
        for (const timer of channelDebounceTimers.values()) {
            clearTimeout(timer);
        }
        channelDebounceTimers.clear();
        inFlightChannels.clear();
        pendingRetriggerChannels.clear();
        triggerAutocordRerender();
    },
});
