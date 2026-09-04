# Equicord userplugins

Private Equicord plugins. Equicord will not merge these. Drop each folder into `src/userplugins/` on a **source build**.

| Plugin | What it does |
| --- | --- |
| `fakeDeafen` | Appear deafened/muted in VC while you can still hear and speak |
| `elevenVoice` | `/11` ElevenLabs TTS, voice messages, clip clone, VC playback on Equibop/Vesktop/web |

## Install

Userplugins need an Equicord source checkout. The stock installer cannot load these.

```powershell
git clone https://github.com/Equicord/Equicord
cd Equicord
pnpm install --frozen-lockfile
mkdir src\userplugins
```

Copy `fakeDeafen` and `elevenVoice` into `src/userplugins/`, then:

```powershell
pnpm build
pnpm inject
```

Restart Discord. Enable the plugins under Equicord settings.

If you already have a source tree, just copy the folders and `pnpm build`. Restart is enough if it is already injected.

## FakeDeafen

Adapted from [hyyven/Vencord-FakeDeafen](https://github.com/hyyven/Vencord-FakeDeafen) for Equicord.

- Button in the user area
- Ctrl+Shift+Q
- Settings: fake mute, fake deafen, or both
- Rewrites outbound voice-state (`op 4`) so others see you as muted/deafened while local capture/playback stays on

This is a Discord ToS client-state spoof. Equicord will not accept it upstream. Use a throwaway if you care.

## ElevenVoice

```
/11 [laughs] hi im a demo test [pause] hows your day
/11vc same thing, play into current VC (Equibop / Vesktop / web only)
/11voices list voices on the account
```

Chat-bar button and attach-menu item open a modal: send, play in VC, or record a clip and speech-to-speech convert it.

API key:

1. User environment variable `ELEVENLABS_API_KEY` (desktop native path reads this)
2. Or paste it in plugin settings (needed on web; desktop can use either)

Do not commit the key. Fully restart Discord after setting the user env var so Electron sees it.

Official Discord Desktop cannot inject audio into the native voice encoder. `/11vc` and "Play in VC" need Equibop, Vesktop, or Discord web. Delay of a couple of seconds is expected. ElevenLabs has no live speech-to-speech websocket.

iOS voice-message bubbles need Ogg Opus. The default output format is `opus_48000_128`. If your plan rejects that, switch to mp3 and send as a file.

## Credits

- FakeDeafen: [hyyven](https://github.com/hyyven/Vencord-FakeDeafen), plus yofukashino and SiriusBYT as credited upstream
- Voice-message upload path follows Vencord VoiceMessages
- VC mix path follows the public AudioInput wrap used by web soundboard userplugins
