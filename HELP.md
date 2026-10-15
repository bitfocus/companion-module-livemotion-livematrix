# LiveMatrix Companion Module

Control LiveMatrix talk/listen keys and microphone mute from Bitfocus Companion.

Connection modes:

- `server`: Connect directly to `ws://host:port/ws` and authenticate with a LiveMatrix username/password. Installed servers listen on port `55678`. The module pings the server while idle so the connection is not dropped, and reconnects after any drop.
- `client`: Connect to the control API of a LiveMatrix client app at `ws://127.0.0.1:9100`, with no login of its own. The app only accepts control API connections from the same machine, so it has to run on the computer Companion runs on.

If the server refuses the login because the password is wrong, the module stops and shows the error. If it refuses for a reason that clears up by itself, such as every licence being in use, the module keeps retrying. If the server ends the session on purpose (the end of a trial session, or a licence limit), the module stays disconnected until the connection config is saved again.

The module tracks key config and state updates in real time, exposes per-key variables, and provides talk/listen actions plus matching feedbacks and presets.

Microphone:

- Each user has one microphone state on the server: the device holding the mic, and whether it is muted. Muting silences the user everywhere, whichever device or panel did it. Holding a talk key sends audio through a muted mic without unmuting it.
- Actions `Mute microphone`, `Unmute microphone` and `Toggle microphone mute`. Toggle mutes a live mic and unmutes a muted one, or one no device holds. Unmuting when the holding device is gone hands the mic to the device that held it most recently.
- Feedbacks `Microphone muted` (on while muted or while no device holds the mic, red by default) and `Microphone live` (on while audio is going out, including a talk key held through the mute).
- Variables `mic_muted`, `mic_open` (audio is going out), `mic_device`, `mic_holder_online` and `mic_error` (why the last unmute could not find a device, kept until a device holds the mic again or the next mute or unmute).
- Preset `Microphone mute` in the `Microphone and Selection` section: shows `MIC` and the holding device, toggles on press, and turns red while muted.

Keys can point at users, party lines, feeds (listen-only lines) and groups (talk-only).

Listen level actions and variables use dB, from `-100 dB` (silence) to `+10 dB`.
