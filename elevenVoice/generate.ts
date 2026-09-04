/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PluginNative } from "@utils/types";

import { settings } from "./settings";

const Native = (IS_DISCORD_DESKTOP
    ? (VencordNative.pluginHelpers.ElevenVoice as PluginNative<typeof import("./native")>)
    : null);

export type AudioResult = { ok: true; bytes: number[]; mime: string; } | { ok: false; error: string; };

function key() {
    return settings.store.apiKey.trim() || undefined;
}

async function rendererPost(path: string, init: RequestInit): Promise<AudioResult> {
    const apiKey = settings.store.apiKey.trim() || "";
    if (!apiKey) return { ok: false, error: "No ElevenLabs API key in plugin settings. Web clients cannot read the OS environment variable." };
    try {
        const res = await fetch(`https://api.elevenlabs.io${path}`, {
            ...init,
            headers: {
                "xi-api-key": apiKey,
                ...(init.headers as Record<string, string> | undefined),
            },
        });
        if (!res.ok) {
            const body = await res.text().catch(() => "");
            return { ok: false, error: `ElevenLabs ${res.status}: ${body.slice(0, 240) || res.statusText}` };
        }
        const buf = new Uint8Array(await res.arrayBuffer());
        return { ok: true, bytes: Array.from(buf), mime: res.headers.get("content-type") || "audio/mpeg" };
    } catch {
        return { ok: false, error: "Could not reach ElevenLabs. Discord CSP may be blocking the request; use the desktop client so native.ts can call it." };
    }
}

export async function generateTts(text: string, voiceId?: string): Promise<AudioResult> {
    const args = {
        apiKey: key(),
        voiceId: voiceId || settings.store.voiceId,
        text,
        modelId: settings.store.modelId,
        outputFormat: settings.store.outputFormat,
    };
    if (Native) return Native.tts(args);
    return rendererPost(
        `/v1/text-to-speech/${encodeURIComponent(args.voiceId)}?output_format=${encodeURIComponent(args.outputFormat)}`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "audio/*" },
            body: JSON.stringify({ text: args.text, model_id: args.modelId }),
        }
    );
}

export async function generateSts(audio: number[], mime: string, voiceId?: string): Promise<AudioResult> {
    const args = {
        apiKey: key(),
        voiceId: voiceId || settings.store.voiceId,
        audio,
        mime,
        modelId: "eleven_multilingual_sts_v2",
        outputFormat: settings.store.outputFormat,
    };
    if (Native) return Native.sts(args);
    const form = new FormData();
    form.append("audio", new Blob([Uint8Array.from(audio)], { type: mime || "audio/webm" }), "clip.webm");
    form.append("model_id", args.modelId);
    return rendererPost(
        `/v1/speech-to-speech/${encodeURIComponent(args.voiceId)}/stream?output_format=${encodeURIComponent(args.outputFormat)}`,
        { method: "POST", body: form }
    );
}

export async function listVoices() {
    if (Native) return Native.listVoices({ apiKey: key() });
    const apiKey = settings.store.apiKey.trim();
    if (!apiKey) return { ok: false as const, error: "No API key in plugin settings." };
    try {
        const res = await fetch("https://api.elevenlabs.io/v1/voices", {
            headers: { "xi-api-key": apiKey },
        });
        if (!res.ok) return { ok: false as const, error: `ElevenLabs ${res.status}` };
        const json = await res.json() as { voices?: { voice_id: string; name: string; }[]; };
        return { ok: true as const, voices: json.voices ?? [] };
    } catch {
        return { ok: false as const, error: "Could not list voices." };
    }
}
