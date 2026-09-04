/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const ALLOWED_HOSTS = new Set([
    "api.elevenlabs.io",
    "api.us.elevenlabs.io",
]);

const ALLOWED_MODELS = new Set([
    "eleven_v3",
    "eleven_multilingual_v2",
    "eleven_flash_v2_5",
    "eleven_turbo_v2_5",
    "eleven_multilingual_sts_v2",
    "eleven_english_sts_v2",
]);

const ALLOWED_FORMATS = new Set([
    "opus_48000_128",
    "opus_48000_64",
    "mp3_44100_128",
    "mp3_44100_64",
    "pcm_24000",
    "pcm_16000",
]);

const MAX_TEXT = 5000;
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const VOICE_ID_RE = /^[a-zA-Z0-9]{8,64}$/;

type Result = { ok: true; bytes: number[]; mime: string; } | { ok: false; error: string; };

function resolveKey(apiKey?: string) {
    const key = (apiKey || process.env.ELEVENLABS_API_KEY || "").trim();
    if (!key) return { error: "No ElevenLabs API key. Set ELEVENLABS_API_KEY or paste one in plugin settings." };
    if (key.length > 200) return { error: "API key looks invalid." };
    return { key };
}

function assertVoice(voiceId: string) {
    return VOICE_ID_RE.test(voiceId) ? null : "Voice id looks invalid.";
}

async function elevenFetch(pathAndQuery: string, init: RequestInit, apiKey?: string): Promise<Result> {
    const auth = resolveKey(apiKey);
    if ("error" in auth) return { ok: false, error: auth.error };

    const url = new URL(pathAndQuery, "https://api.elevenlabs.io");
    if (!ALLOWED_HOSTS.has(url.hostname)) return { ok: false, error: "Blocked host." };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
        const res = await fetch(url, {
            ...init,
            signal: controller.signal,
            headers: {
                "xi-api-key": auth.key,
                ...(init.headers as Record<string, string> | undefined),
            },
        });
        if (!res.ok) {
            const body = await res.text().catch(() => "");
            const short = body.slice(0, 240) || res.statusText;
            return { ok: false, error: `ElevenLabs ${res.status}: ${short}` };
        }
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.byteLength > MAX_AUDIO_BYTES) return { ok: false, error: "Audio response too large." };
        const mime = res.headers.get("content-type") || "application/octet-stream";
        return { ok: true, bytes: Array.from(buf), mime };
    } catch (e) {
        const aborted = e instanceof Error && e.name === "AbortError";
        return { ok: false, error: aborted ? "ElevenLabs request timed out." : "ElevenLabs request failed." };
    } finally {
        clearTimeout(timer);
    }
}

export async function tts(
    _event: Electron.IpcMainInvokeEvent,
    args: { apiKey?: string; voiceId: string; text: string; modelId: string; outputFormat: string; }
): Promise<Result> {
    const voiceErr = assertVoice(args.voiceId);
    if (voiceErr) return { ok: false, error: voiceErr };
    if (typeof args.text !== "string" || !args.text.trim()) return { ok: false, error: "Text is empty." };
    if (args.text.length > MAX_TEXT) return { ok: false, error: "Text is too long." };
    if (!ALLOWED_MODELS.has(args.modelId)) return { ok: false, error: "Unknown model." };
    if (!ALLOWED_FORMATS.has(args.outputFormat)) return { ok: false, error: "Unknown output format." };

    return elevenFetch(
        `/v1/text-to-speech/${args.voiceId}?output_format=${encodeURIComponent(args.outputFormat)}`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "audio/*" },
            body: JSON.stringify({
                text: args.text,
                model_id: args.modelId,
            }),
        },
        args.apiKey,
    );
}

export async function sts(
    _event: Electron.IpcMainInvokeEvent,
    args: { apiKey?: string; voiceId: string; audio: number[]; mime?: string; modelId?: string; outputFormat?: string; }
): Promise<Result> {
    const voiceErr = assertVoice(args.voiceId);
    if (voiceErr) return { ok: false, error: voiceErr };
    if (!Array.isArray(args.audio) || args.audio.length < 64) return { ok: false, error: "Audio clip is empty." };
    if (args.audio.length > MAX_AUDIO_BYTES) return { ok: false, error: "Audio clip is too large." };
    const modelId = args.modelId || "eleven_multilingual_sts_v2";
    if (!ALLOWED_MODELS.has(modelId)) return { ok: false, error: "Unknown model." };
    const outputFormat = args.outputFormat || "opus_48000_128";
    if (!ALLOWED_FORMATS.has(outputFormat)) return { ok: false, error: "Unknown output format." };

    const bytes = Uint8Array.from(args.audio);
    const form = new FormData();
    form.append("audio", new Blob([bytes], { type: args.mime || "audio/webm" }), "clip.webm");
    form.append("model_id", modelId);

    return elevenFetch(
        `/v1/speech-to-speech/${args.voiceId}/stream?output_format=${encodeURIComponent(outputFormat)}`,
        { method: "POST", body: form },
        args.apiKey,
    );
}

export async function listVoices(
    _event: Electron.IpcMainInvokeEvent,
    args: { apiKey?: string; } = {}
): Promise<{ ok: true; voices: { voice_id: string; name: string; }[]; } | { ok: false; error: string; }> {
    const audio = await elevenFetch("/v1/voices", { method: "GET" }, args.apiKey);
    if (!audio.ok) return audio;
    try {
        const json = JSON.parse(Buffer.from(audio.bytes).toString("utf8")) as {
            voices?: { voice_id: string; name: string; }[];
        };
        const voices = (json.voices ?? []).map(v => ({
            voice_id: String(v.voice_id),
            name: String(v.name),
        })).filter(v => VOICE_ID_RE.test(v.voice_id));
        return { ok: true, voices };
    } catch {
        return { ok: false, error: "Could not parse voices list." };
    }
}
