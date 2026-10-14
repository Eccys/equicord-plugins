/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { CloudUpload as TCloudUpload } from "@vencord/discord-types";
import { CloudUploadPlatform } from "@vencord/discord-types/enums";
import { findLazy } from "@webpack";
import { ChannelStore, Constants, FluxDispatcher, lodash, MessageActions, PendingReplyStore, RestAPI, SelectedChannelStore, showToast, SnowflakeUtils, UploadHandler } from "@webpack/common";

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

export function pcmToWav(pcmBytes: number[] | Uint8Array, sampleRate = 24000): Uint8Array<ArrayBuffer> {
    const raw = pcmBytes instanceof Uint8Array ? pcmBytes : Uint8Array.from(pcmBytes);
    if (
        raw.byteLength >= 12 &&
        raw[0] === 0x52 && raw[1] === 0x49 && raw[2] === 0x46 && raw[3] === 0x46 &&
        raw[8] === 0x57 && raw[9] === 0x41 && raw[10] === 0x56 && raw[11] === 0x45
    ) {
        return Uint8Array.from(raw);
    }
    const dataLen = raw.byteLength - (raw.byteLength % 2);
    const wav = new Uint8Array(44 + dataLen);
    const view = new DataView(wav.buffer);
    wav.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
    view.setUint32(4, 36 + dataLen, true);
    wav.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"
    wav.set([0x66, 0x6d, 0x74, 0x20], 12); // "fmt "
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    wav.set([0x64, 0x61, 0x74, 0x61], 36); // "data"
    view.setUint32(40, dataLen, true);
    wav.set(raw.subarray(0, dataLen), 44);
    return wav;
}

function mimeToExt(mime: string) {
    const lower = (mime || "").toLowerCase();
    if (lower.includes("ogg") || lower.includes("opus")) return { ext: "ogg", type: "audio/ogg; codecs=opus" };
    if (lower.includes("mpeg") || lower.includes("mp3")) return { ext: "mp3", type: "audio/mpeg" };
    if (lower.includes("wav") || lower.includes("pcm") || lower.includes("l16")) return { ext: "wav", type: "audio/wav" };
    if (lower.includes("webm")) return { ext: "webm", type: "audio/webm" };
    return { ext: "ogg", type: mime || "audio/ogg; codecs=opus" };
}

export function bytesToBlob(bytes: number[], mime: string) {
    const lower = (mime || "").toLowerCase();
    if (lower.includes("pcm") || lower.includes("l16")) {
        const rateMatch = lower.match(/rate=(\d+)|pcm_(\d+)/);
        const sampleRate = Number(rateMatch?.[1] || rateMatch?.[2]) || 24000;
        const wav = pcmToWav(bytes, sampleRate);
        return new Blob([wav], { type: "audio/wav" });
    }
    return new Blob([Uint8Array.from(bytes)], { type: mimeToExt(mime).type });
}

export function sendAsFile(blob: Blob, mime: string, channelId = SelectedChannelStore.getChannelId()) {
    if (!channelId) {
        showToast("No channel selected.", "failure");
        return;
    }
    const { ext, type } = mimeToExt(mime);
    const file = new File([blob], `eleven-voice.${ext}`, { type });
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) {
        showToast("No channel selected.", "failure");
        return;
    }
    try {
        UploadHandler.promptToUpload([file], channel, 0);
    } catch (e) {
        logger.error("File upload failed", e);
        showToast("Could not attach the audio file.", "failure");
    }
}

export async function sendAsVoiceMessage(blob: Blob, mime: string, channelId = SelectedChannelStore.getChannelId()) {
    if (!channelId) {
        showToast("No channel selected.", "failure");
        return;
    }

    const { ext, type } = mimeToExt(mime);
    const isOpus = type.includes("ogg") && type.includes("opus");
    if (!isOpus) {
        sendAsFile(blob, mime, channelId);
        showToast("Sent as a file because this clip is not Ogg Opus.", "message");
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
            showToast("Upload worked, but sending the voice message failed.", "failure");
        });
    });
    upload.on("error", () => showToast("Failed to upload voice message.", "failure"));
    upload.upload();
}
