/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Mix generated clips into Discord's Web Audio capture path.
// Official Discord Desktop uses a native encoder; this only works on
// Equibop, Vesktop, and Discord web.

import { Logger } from "@utils/Logger";
import { showToast } from "@webpack/common";

const logger = new Logger("ElevenVoice");

interface AudioInput {
    context: AudioContext;
    mute: boolean;
    setPTTActive(active: boolean): void;
    setSpeaking(active: boolean): void;
}

interface MixedInput {
    input: AudioInput;
    sourceStream: MediaStream;
    source: MediaStreamAudioSourceNode;
    microphoneGain: GainNode;
    destination: MediaStreamAudioDestinationNode;
}

const mixedInputs = new Map<MediaStream, MixedInput>();

export function canInjectVoice() {
    return !IS_DISCORD_DESKTOP;
}

export function mixInput(input: AudioInput, stream: MediaStream): MediaStream {
    const source = input.context.createMediaStreamSource(stream);
    const microphoneGain = input.context.createGain();
    const destination = input.context.createMediaStreamDestination();
    source.connect(microphoneGain).connect(destination);
    const mixedStream = destination.stream;
    mixedInputs.set(mixedStream, { input, sourceStream: stream, source, microphoneGain, destination });
    return mixedStream;
}

export function releaseInput(stream: MediaStream) {
    const mixed = mixedInputs.get(stream);
    if (mixed == null) return;
    mixedInputs.delete(stream);
    mixed.source.disconnect();
    mixed.microphoneGain.disconnect();
    for (const track of mixed.sourceStream.getTracks()) track.stop();
}

export async function playClipIntoVc(blob: Blob) {
    if (!canInjectVoice()) {
        showToast("Live VC playback needs Equibop, Vesktop, or Discord web.", "failure");
        return;
    }
    const inputs = [...mixedInputs.values()];
    if (inputs.length === 0) {
        showToast("Join a voice channel first. If you already did, toggle the plugin after joining.", "failure");
        return;
    }

    const [{ input: firstInput }] = inputs;
    let buffer: AudioBuffer;
    try {
        await firstInput.context.resume();
        buffer = await firstInput.context.decodeAudioData(await blob.arrayBuffer());
    } catch (e) {
        logger.error("VC playback failed", e);
        showToast("Could not play this clip into voice.", "failure");
        return;
    }

    await Promise.all(inputs.map(({ input, destination }) => new Promise<void>(resolve => {
        const source = input.context.createBufferSource();
        source.buffer = buffer;
        source.connect(destination);
        source.onended = () => {
            if (input.mute) input.setSpeaking(false);
            else input.setPTTActive(false);
            resolve();
        };
        for (const track of destination.stream.getAudioTracks()) track.enabled = true;
        if (input.mute) input.setSpeaking(true);
        else input.setPTTActive(true);
        source.start();
    }))).catch(e => {
        logger.error("VC playback failed", e);
        showToast("Could not play this clip into voice.", "failure");
    });
}

export function releaseAll() {
    for (const [stream] of mixedInputs) {
        releaseInput(stream);
        for (const track of stream.getTracks()) track.stop();
    }
}
