/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PluginNative } from "@utils/types";

import { pcmToWav } from "./sendVoice";
import { settings } from "./settings";

const Native = (IS_DISCORD_DESKTOP
    ? (VencordNative.pluginHelpers.ElevenVoice as PluginNative<typeof import("./native")>)
    : null);

export type AudioResult = { ok: true; bytes: number[]; mime: string; } | { ok: false; error: string; };

function normalizeAudioResult(result: AudioResult, outputFormat: string): AudioResult {
    if (!result.ok) return result;
    if (outputFormat.startsWith("pcm_")) {
        const sampleRate = Number(outputFormat.split("_")[1]) || 24000;
        const wav = pcmToWav(result.bytes, sampleRate);
        return { ok: true, bytes: Array.from(wav), mime: "audio/wav" };
    }
    return result;
}

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

export function isLibraryVoiceError(error: string) {
    return /library voices|payment_required|paid_plan_required|free users cannot use/i.test(error);
}

export async function pickPremadeVoice() {
    const listed = await listVoices();
    if (!listed.ok) return null;
    const premade = listed.voices.filter(v => v.category === "premade");
    const preferred = premade.find(v => v.voice_id === "bIHbv24MWmeRgasZH58o")
        || premade.find(v => v.voice_id === "EXAVITQu4vr4xnSDxMaL")
        || premade[0];
    return preferred?.voice_id ?? null;
}

export async function generateTts(text: string, voiceId?: string): Promise<AudioResult> {
    const args = {
        apiKey: key(),
        voiceId: voiceId || settings.store.voiceId,
        text,
        modelId: settings.store.modelId,
        outputFormat: settings.store.outputFormat,
    };
    const first = Native
        ? await Native.tts(args)
        : await rendererPost(
            `/v1/text-to-speech/${encodeURIComponent(args.voiceId)}?output_format=${encodeURIComponent(args.outputFormat)}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json", Accept: "audio/*" },
                body: JSON.stringify({ text: args.text, model_id: args.modelId }),
            }
        );
    if (first.ok || !isLibraryVoiceError(first.error)) return normalizeAudioResult(first, args.outputFormat);

    const fallback = await pickPremadeVoice();
    if (!fallback || fallback === args.voiceId) return first;
    settings.store.voiceId = fallback;
    const retryArgs = { ...args, voiceId: fallback };
    const retried = Native
        ? await Native.tts(retryArgs)
        : await rendererPost(
            `/v1/text-to-speech/${encodeURIComponent(fallback)}?output_format=${encodeURIComponent(args.outputFormat)}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json", Accept: "audio/*" },
                body: JSON.stringify({ text: args.text, model_id: args.modelId }),
            }
        );
    return normalizeAudioResult(retried, args.outputFormat);
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
    if (Native) return normalizeAudioResult(await Native.sts(args), args.outputFormat);
    const form = new FormData();
    form.append("audio", new Blob([Uint8Array.from(audio)], { type: mime || "audio/webm" }), "clip.webm");
    form.append("model_id", args.modelId);
    const res = await rendererPost(
        `/v1/speech-to-speech/${encodeURIComponent(args.voiceId)}/stream?output_format=${encodeURIComponent(args.outputFormat)}`,
        { method: "POST", body: form }
    );
    return normalizeAudioResult(res, args.outputFormat);
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
        const json = await res.json() as { voices?: { voice_id: string; name: string; category?: string; }[]; };
        return {
            ok: true as const,
            voices: (json.voices ?? []).map(v => ({
                voice_id: v.voice_id,
                name: v.name,
                category: v.category || "unknown",
            })),
        };
    } catch {
        return { ok: false as const, error: "Could not list voices." };
    }
}
