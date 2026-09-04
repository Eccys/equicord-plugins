/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const TAG_ALIASES: Record<string, string> = {
    laugh: "laughs",
    laughs: "laughs",
    haha: "laughs",
    lol: "laughs",
    lmao: "laughs",
    pause: "pause",
    wait: "pause",
    "long pause": "long pause",
    sigh: "sighs",
    sighs: "sighs",
    whisper: "whispers",
    whispers: "whispers",
    gasp: "gasps",
    gasps: "gasps",
    "clears throat": "clears throat",
    cough: "coughs",
    coughs: "coughs",
};

export function normalizeTags(script: string): string {
    return script.replace(/\[([^\]\n]{1,80})\]/g, (_match, raw: string) => {
        const key = raw.trim().toLowerCase().replace(/\s+/g, " ");
        const mapped = TAG_ALIASES[key];
        if (mapped) return `[${mapped}]`;
        return `[${raw.trim()}]`;
    }).trim();
}
