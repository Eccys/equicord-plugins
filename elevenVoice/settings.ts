/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

export const DEFAULT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";

export const settings = definePluginSettings({
    apiKey: {
        type: OptionType.STRING,
        default: "",
        placeholder: "Leave empty to use ELEVENLABS_API_KEY",
        description: "ElevenLabs API key. Optional if ELEVENLABS_API_KEY is set as a user environment variable.",
    },
    voiceId: {
        type: OptionType.STRING,
        default: DEFAULT_VOICE_ID,
        description: "Default ElevenLabs voice id.",
    },
    modelId: {
        type: OptionType.SELECT,
        description: "TTS model. eleven_v3 is required for audio tags like [laughs] and [pause].",
        options: [
            { label: "eleven_v3 (audio tags)", value: "eleven_v3", default: true },
            { label: "eleven_multilingual_v2", value: "eleven_multilingual_v2" },
            { label: "eleven_flash_v2_5 (fast, no v3 tags)", value: "eleven_flash_v2_5" },
            { label: "eleven_turbo_v2_5", value: "eleven_turbo_v2_5" },
        ],
    },
    output: {
        type: OptionType.SELECT,
        description: "How to send generated audio in chat.",
        options: [
            { label: "Voice message", value: "voice", default: true },
            { label: "File attachment", value: "file" },
        ],
    },
    outputFormat: {
        type: OptionType.SELECT,
        description: "ElevenLabs output format. Opus is required for iOS voice-message playback.",
        options: [
            { label: "opus 48k (voice messages)", value: "opus_48000_128", default: true },
            { label: "mp3 44.1k", value: "mp3_44100_128" },
            { label: "pcm 24k", value: "pcm_24000" },
        ],
    },
});
