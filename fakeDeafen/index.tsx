/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Adapted from hyyven/Vencord-FakeDeafen for Equicord userplugins.
 */

import { UserAreaButton, UserAreaRenderProps } from "@api/UserArea";
import ErrorBoundary from "@components/ErrorBoundary";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { ChannelStore, SelectedChannelStore, showToast, Toasts, useStateFromStores } from "@webpack/common";

import { settings } from "./settings";

const logger = new Logger("FakeDeafen");
const GatewaySocket = findByPropsLazy("getSocket");
const MediaEngineStore = findByPropsLazy("isDeaf", "isMute");

type GatewaySend = (op: number, data?: any, ...args: any[]) => any;

let originalSend: GatewaySend | null = null;
let wrappedSocket: { send: GatewaySend; } | null = null;

function hookedSend(this: unknown, op: number, data?: any, ...args: any[]) {
    if (op === 4 && settings.store.currentlyEnabled && data && typeof data === "object") {
        if (settings.store.fakeMute) data.self_mute = true;
        if (settings.store.fakeDeafen) data.self_deaf = true;
    }
    return originalSend!.apply(this, [op, data, ...args]);
}

function wrapSocket() {
    const socket = GatewaySocket?.getSocket?.();
    if (!socket?.send) return;

    if (wrappedSocket === socket && socket.send === hookedSend) return;

    originalSend = socket.send.bind(socket);
    socket.send = hookedSend;
    wrappedSocket = socket;
}

function unwrapSocket() {
    const socket = wrappedSocket ?? GatewaySocket?.getSocket?.();
    if (socket && originalSend && socket.send === hookedSend)
        socket.send = originalSend;
    originalSend = null;
    wrappedSocket = null;
}

function refreshVoiceState(enabled: boolean) {
    wrapSocket();
    const socket = GatewaySocket?.getSocket?.();
    const channelId = SelectedChannelStore.getVoiceChannelId();
    if (!socket || !channelId) return;

    const channel = ChannelStore.getChannel(channelId);
    try {
        socket.send(4, {
            guild_id: channel?.guild_id ?? null,
            channel_id: channelId,
            self_mute: (enabled && settings.store.fakeMute) || (MediaEngineStore?.isMute?.() ?? false),
            self_deaf: (enabled && settings.store.fakeDeafen) || (MediaEngineStore?.isDeaf?.() ?? false),
            self_video: false,
            flags: 0,
        });
    } catch (e) {
        logger.error("Failed to refresh voice state", e);
    }
}

function setEnabled(next: boolean) {
    settings.store.currentlyEnabled = next;
    refreshVoiceState(next);
    showToast(next ? "Fake deafen on" : "Fake deafen off", next ? Toasts.Type.SUCCESS : Toasts.Type.MESSAGE);
}

function toggleEnabled() {
    setEnabled(!settings.store.currentlyEnabled);
}

function handleKeyDown(event: KeyboardEvent) {
    if (!settings.store.enableKeybind) return;
    if (!(event.ctrlKey && event.shiftKey && event.code === "KeyQ")) return;
    event.preventDefault();
    toggleEnabled();
}

function HeadphonesIcon({ className, color }: { className?: string; color?: string; }) {
    const enabled = settings.use(["currentlyEnabled"]).currentlyEnabled;
    const iconColor = color ?? (enabled ? "var(--status-danger)" : "currentColor");
    return (
        <svg width="20" height="20" viewBox="0 0 32 32" fill="none" className={className}>
            <rect x="6" y="8" width="20" height="4" rx="2" fill={iconColor} />
            <rect x="11" y="3" width="10" height="8" rx="3" fill={iconColor} />
            {enabled ? (
                <>
                    <line x1="7" y1="18" x2="13" y2="24" stroke={iconColor} strokeWidth="2" />
                    <line x1="13" y1="18" x2="7" y2="24" stroke={iconColor} strokeWidth="2" />
                    <line x1="19" y1="18" x2="25" y2="24" stroke={iconColor} strokeWidth="2" />
                    <line x1="25" y1="18" x2="19" y2="24" stroke={iconColor} strokeWidth="2" />
                </>
            ) : (
                <>
                    <circle cx="10" cy="21" r="4" stroke={iconColor} strokeWidth="2" fill="none" />
                    <circle cx="22" cy="21" r="4" stroke={iconColor} strokeWidth="2" fill="none" />
                </>
            )}
        </svg>
    );
}

function FakeDeafenButton(props: UserAreaRenderProps) {
    const enabled = settings.use(["currentlyEnabled"]).currentlyEnabled;
    useStateFromStores([SelectedChannelStore], () => SelectedChannelStore.getVoiceChannelId());
    return (
        <UserAreaButton
            tooltipText={enabled ? "Disable fake deafen" : "Enable fake deafen"}
            icon={<HeadphonesIcon />}
            role="switch"
            aria-checked={enabled}
            redGlow={enabled}
            plated={props?.nameplate != null}
            onClick={toggleEnabled}
        />
    );
}

export default definePlugin({
    name: "FakeDeafen",
    description: "Appear deafened and/or muted in voice while you can still hear and speak. Toggle from the user area or Ctrl+Shift+Q.",
    authors: [
        { name: "hyyven", id: 449282863582412850n },
        { name: "Eccys", id: 0n },
    ],
    tags: ["Voice"],
    settings,
    userAreaButton: {
        icon: HeadphonesIcon,
        render: ErrorBoundary.wrap(FakeDeafenButton, { noop: true }),
    },
    flux: {
        CONNECTION_OPEN() {
            wrapSocket();
            if (settings.store.currentlyEnabled) refreshVoiceState(true);
        },
    },
    start() {
        settings.store.currentlyEnabled = false;
        wrapSocket();
        window.addEventListener("keydown", handleKeyDown);
    },
    stop() {
        if (settings.store.currentlyEnabled) {
            settings.store.currentlyEnabled = false;
            refreshVoiceState(false);
        }
        unwrapSocket();
        window.removeEventListener("keydown", handleKeyDown);
    },
});
