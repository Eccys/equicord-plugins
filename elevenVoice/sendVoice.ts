/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { CloudUpload as TCloudUpload } from "@vencord/discord-types";
import { CloudUploadPlatform } from "@vencord/discord-types/enums";
import { findLazy } from "@webpack";
import { ChannelStore, Constants, FluxDispatcher, lodash, MessageActions, PendingReplyStore, RestAPI, SelectedChannelStore, showToast, SnowflakeUtils, Toasts, UploadHandler } from "@webpack/common";

const logger = new Logger("ElevenVoice");
const CloudUpload: typeof TCloudUpload = findLazy(m => m.prototype?.trackUploadFinished);

export type AudioMeta = { waveform: string; duration: number; };

const EMPTY_META: AudioMeta = { waveform: "AAAAAAAAAAAA", duration: 1 };

export async function computeMeta(blob: Blob): Promise<AudioMeta> {
    const audioContext = new AudioContext();
    try {
        const audioBuffer = await audioContext.decodeAudioData(await blob.arrayBuffer());
        const channelData = audioBuffer.getChannelData(0);
        const bins = new Uint8Array(lodash.clamp(Math.floor(audioBuffer.duration * 10), Math.min(32, channelData.length), 256));
        const samplesPerBin = Math.floor(channelData.length / bins.length) || 1;
        for (let binIdx = 0; binIdx < bins.length; binIdx++) {
            let squares = 0;
            for (let sampleOffset = 0; sampleOffset < samplesPerBin; sampleOffset++) {
                const sampleIdx = binIdx * samplesPerBin + sampleOffset;
                squares += (channelData[sampleIdx] ?? 0) ** 2;
            }
            bins[binIdx] = ~~(Math.sqrt(squares / samplesPerBin) * 0xFF);
        }
        const maxBin = Math.max(1, ...bins);
        const ratio = 1 + (0xFF / maxBin - 1) * Math.min(1, 100 * (maxBin / 0xFF) ** 3);
        for (let i = 0; i < bins.length; i++) bins[i] = Math.min(0xFF, ~~(bins[i] * ratio));
        return {
            waveform: window.btoa(String.fromCharCode(...bins)),
            duration: audioBuffer.duration,
        };
    } catch (e) {
        logger.error("Failed to compute waveform", e);
        return EMPTY_META;
    } finally {
        void audioContext.close();
    }
}

function mimeToExt(mime: string) {
    if (mime.includes("ogg") || mime.includes("opus")) return { ext: "ogg", type: "audio/ogg; codecs=opus" };
    if (mime.includes("mpeg") || mime.includes("mp3")) return { ext: "mp3", type: "audio/mpeg" };
    if (mime.includes("wav")) return { ext: "wav", type: "audio/wav" };
    if (mime.includes("webm")) return { ext: "webm", type: "audio/webm" };
    return { ext: "ogg", type: mime || "audio/ogg; codecs=opus" };
}

export function bytesToBlob(bytes: number[], mime: string) {
    return new Blob([Uint8Array.from(bytes)], { type: mimeToExt(mime).type });
}

export function sendAsFile(blob: Blob, mime: string, channelId = SelectedChannelStore.getChannelId()) {
    if (!channelId) {
        showToast("No channel selected.", Toasts.Type.FAILURE);
        return;
    }
    const { ext, type } = mimeToExt(mime);
    const file = new File([blob], `eleven-voice.${ext}`, { type });
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) {
        showToast("No channel selected.", Toasts.Type.FAILURE);
        return;
    }
    try {
        UploadHandler.promptToUpload([file], channel, 0);
    } catch (e) {
        logger.error("File upload failed", e);
        showToast("Could not attach the audio file.", Toasts.Type.FAILURE);
    }
}

export async function sendAsVoiceMessage(blob: Blob, mime: string, channelId = SelectedChannelStore.getChannelId()) {
    if (!channelId) {
        showToast("No channel selected.", Toasts.Type.FAILURE);
        return;
    }

    const { ext, type } = mimeToExt(mime);
    const isOpus = type.includes("ogg") && type.includes("opus");
    if (!isOpus) {
        sendAsFile(blob, mime, channelId);
        showToast("Sent as a file because this clip is not Ogg Opus.", Toasts.Type.MESSAGE);
        return;
    }

    const meta = await computeMeta(blob);
    const reply = PendingReplyStore.getPendingReply(channelId);
    if (reply) FluxDispatcher.dispatch({ type: "DELETE_PENDING_REPLY", channelId });

    const upload = new CloudUpload({
        file: new File([blob], `voice-message.${ext}`, { type }),
        isThumbnail: false,
        platform: CloudUploadPlatform.WEB,
    }, channelId);

    upload.on("complete", () => {
        RestAPI.post({
            url: Constants.Endpoints.MESSAGES(channelId),
            body: {
                flags: 1 << 13,
                channel_id: channelId,
                content: "",
                nonce: SnowflakeUtils.fromTimestamp(Date.now()),
                sticker_ids: [],
                type: 0,
                attachments: [{
                    id: "0",
                    filename: upload.filename,
                    uploaded_filename: upload.uploadedFilename,
                    waveform: meta.waveform,
                    duration_secs: meta.duration,
                }],
                message_reference: reply ? MessageActions.getSendMessageOptionsForReply(reply)?.messageReference : null,
            }
        }).catch(e => {
            logger.error("Voice message post failed", e);
            showToast("Upload worked, but sending the voice message failed.", Toasts.Type.FAILURE);
        });
    });
    upload.on("error", () => showToast("Failed to upload voice message.", Toasts.Type.FAILURE));
    upload.upload();
}
