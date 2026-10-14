/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatBarButton } from "@api/ChatButtons";
import { ApplicationCommandInputType, ApplicationCommandOptionType, findOption, sendBotMessage } from "@api/Commands";
import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { openModal } from "@utils/modal";
import definePlugin from "@utils/types";
import { RenderModalProps } from "@vencord/discord-types";
import { Forms, Menu, Modal, React, showToast, TextArea, useEffect, useRef, useState } from "@webpack/common";

import { generateSts, generateTts, listVoices } from "./generate";
import { normalizeTags } from "./parse";
import { bytesToBlob, sendAsFile, sendAsVoiceMessage } from "./sendVoice";
import { settings } from "./settings";
import { canInjectVoice, mixInput, playClipIntoVc, releaseAll, releaseInput } from "./vcInject";

async function deliver(bytes: number[], mime: string, intoVc: boolean) {
    const blob = bytesToBlob(bytes, mime);
    if (intoVc) {
        await playClipIntoVc(blob);
        return;
    }
    if (settings.store.output === "file") sendAsFile(blob, mime);
    else await sendAsVoiceMessage(blob, mime);
}

async function runTts(script: string, opts?: { voiceId?: string; intoVc?: boolean; }): Promise<boolean> {
    const text = normalizeTags(script);
    if (!text) {
        showToast("Nothing to say.", "failure");
        return false;
    }
    showToast("Generating speech…", "message");
    const requested = opts?.voiceId || settings.store.voiceId;
    const result = await generateTts(text, opts?.voiceId);
    if (!result.ok) {
        showToast(result.error, "failure");
        return false;
    }
    if (settings.store.voiceId !== requested)
        showToast("Library voices are blocked on the free API. Switched to a premade voice.", "message");
    await deliver(result.bytes, result.mime, opts?.intoVc === true);
    return true;
}

const attachMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    if (!props?.channel) return;
    children.push(
        <Menu.MenuItem
            id="eleven-voice-modal"
            label="ElevenLabs voice"
            action={() => openElevenModal()}
        />
    );
};

function ElevenIcon({ className, height = 24, width = 24 }: { className?: string; height?: number | string; width?: number | string; }) {
    return (
        <svg className={className} height={height} width={width} viewBox="0 0 24 24" fill="currentColor">
            <path d="M11 5a1 1 0 0 1 2 0v14a1 1 0 1 1-2 0V5Zm-4 4a1 1 0 0 1 2 0v10a1 1 0 1 1-2 0V9Zm8-2a1 1 0 0 1 2 0v12a1 1 0 1 1-2 0V7ZM3 11a1 1 0 0 1 2 0v6a1 1 0 1 1-2 0v-6Zm16-1a1 1 0 0 1 2 0v8a1 1 0 1 1-2 0V10Z" />
        </svg>
    );
}

function openElevenModal() {
    openModal(modalProps => <ElevenModal modalProps={modalProps} />);
}

function ElevenModal({ modalProps }: { modalProps: RenderModalProps; }) {
    const [script, setScript] = useState("");
    const [busy, setBusy] = useState(false);
    const [recording, setRecording] = useState(false);
    const recorderRef = useRef<MediaRecorder | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const unmountedRef = useRef(false);

    useEffect(() => () => {
        unmountedRef.current = true;
        if (recorderRef.current && recorderRef.current.state !== "inactive") {
            recorderRef.current.onstop = null;
            recorderRef.current.stop();
        }
        if (streamRef.current) {
            for (const t of streamRef.current.getTracks()) t.stop();
            streamRef.current = null;
        }
    }, []);

    async function go(intoVc: boolean) {
        setBusy(true);
        try {
            const ok = await runTts(script, { intoVc });
            if (ok && !unmountedRef.current) modalProps.onClose();
        } finally {
            if (!unmountedRef.current) setBusy(false);
        }
    }

    async function clone() {
        if (recording) {
            recorderRef.current?.stop();
            return;
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            if (unmountedRef.current) {
                for (const t of stream.getTracks()) t.stop();
                return;
            }
            streamRef.current = stream;
            const rec = new MediaRecorder(stream);
            const chunks: BlobPart[] = [];
            rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
            rec.onstop = async () => {
                for (const t of stream.getTracks()) t.stop();
                streamRef.current = null;
                if (unmountedRef.current) return;
                setRecording(false);
                const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
                const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
                if (unmountedRef.current) return;
                setBusy(true);
                try {
                    showToast("Converting voice…", "message");
                    const result = await generateSts(bytes, blob.type);
                    if (!result.ok) {
                        showToast(result.error, "failure");
                        return;
                    }
                    await deliver(result.bytes, result.mime, false);
                    if (!unmountedRef.current) modalProps.onClose();
                } finally {
                    if (!unmountedRef.current) setBusy(false);
                }
            };
            recorderRef.current = rec;
            rec.start();
            setRecording(true);
            showToast("Recording. Click again to convert.", "message");
        } catch {
            showToast("Microphone permission denied.", "failure");
        }
    }

    return (
        <Modal
            {...modalProps}
            title="ElevenLabs voice"
            actions={[
                {
                    text: "Send",
                    variant: "primary",
                    disabled: busy || !script.trim(),
                    onClick: () => go(false),
                },
                {
                    text: canInjectVoice() ? "Play in VC" : "VC needs Equibop",
                    variant: "secondary",
                    disabled: busy || !script.trim() || !canInjectVoice(),
                    onClick: () => go(true),
                },
                {
                    text: recording ? "Stop and convert" : "Record clone",
                    variant: "secondary",
                    disabled: busy,
                    onClick: clone,
                },
            ]}
        >
            <Forms.FormText>
                Audio tags like [laughs], [pause], [whispers] work with the v3 model.
            </Forms.FormText>
            <TextArea
                value={script}
                onChange={setScript}
                placeholder="[laughs] hi im a demo test [pause] hows your day"
                rows={5}
            />
        </Modal>
    );
}

export default definePlugin({
    name: "ElevenVoice",
    description: "Generate ElevenLabs speech with /11, send it as a voice message, convert a recorded clip, or play it into VC on Equibop/Vesktop/web.",
    authors: [{ name: "Eccys", id: 0n }],
    tags: ["Voice", "Chat"],
    settings,
    dependencies: ["CommandsAPI", "ChatInputButtonAPI", "ContextMenuAPI"],

    commands: [
        {
            name: "11",
            description: "Generate ElevenLabs speech and send it",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "script",
                    description: "What to say. Tags like [laughs] and [pause] work with v3.",
                    type: ApplicationCommandOptionType.STRING,
                    required: true,
                },
                {
                    name: "voice",
                    description: "Voice id override",
                    type: ApplicationCommandOptionType.STRING,
                    required: false,
                },
            ],
            execute: async (args, ctx) => {
                const script = findOption(args, "script", "");
                const voice = findOption(args, "voice", "");
                sendBotMessage(ctx.channel.id, { content: "Generating ElevenLabs audio…" });
                await runTts(script, { voiceId: voice || undefined });
            },
        },
        {
            name: "11vc",
            description: "Generate speech and play it into the current voice channel",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "script",
                    description: "What to say",
                    type: ApplicationCommandOptionType.STRING,
                    required: true,
                },
            ],
            execute: async (args, ctx) => {
                if (!canInjectVoice()) {
                    sendBotMessage(ctx.channel.id, { content: "VC playback needs Equibop, Vesktop, or Discord web. Official Discord Desktop cannot inject into the native voice engine." });
                    return;
                }
                const script = findOption(args, "script", "");
                sendBotMessage(ctx.channel.id, { content: "Generating and playing into VC…" });
                await runTts(script, { intoVc: true });
            },
        },
        {
            name: "11voices",
            description: "List ElevenLabs voices on your account",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: async (_args, ctx) => {
                const result = await listVoices();
                if (!result.ok) {
                    sendBotMessage(ctx.channel.id, { content: result.error });
                    return;
                }
                const lines = result.voices.slice(0, 30).map(v => {
                    const free = v.category === "premade" ? "premade, free API" : `${v.category}, paid API`;
                    return `• **${v.name}** \`${v.voice_id}\` (${free})`;
                });
                sendBotMessage(ctx.channel.id, { content: lines.join("\n") || "No voices." });
            },
        },
    ],

    chatBarButton: {
        icon: ElevenIcon,
        render: ({ isMainChat }) => {
            if (!isMainChat) return null;
            return (
                <ChatBarButton tooltip="ElevenLabs voice" onClick={openElevenModal}>
                    <ElevenIcon />
                </ChatBarButton>
            );
        },
    },

    contextMenus: {
        "channel-attach": attachMenuPatch,
    },

    patches: !IS_DISCORD_DESKTOP ? [
        {
            find: "AudioInput: No MediaStream",
            group: true,
            replacement: [
                {
                    match: /(?<=}else this\.stream=\i;)return this\.updateMode\(\)/,
                    replace: "this.stream=$self.mixInput(this,this.stream);return this.updateMode()",
                },
                {
                    match: /release\((\i)\)\{\1\.getTracks\(\)/,
                    replace: "release($1){$self.releaseInput($1);$1.getTracks()",
                },
            ],
        },
    ] : [],

    mixInput,
    releaseInput,

    stop() {
        releaseAll();
    },
});
