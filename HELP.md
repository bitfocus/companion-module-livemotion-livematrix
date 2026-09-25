# LiveMatrix Companion Module

Control LiveMatrix talk/listen keys and microphone mute from Bitfocus Companion.

Connection modes:

- `server`: Connect directly to `ws://host:port/ws` and authenticate with a LiveMatrix username/password.
- `client`: Connect to a local LiveMatrix client proxy at `ws://host:port` with no login handshake.

The module tracks key config and state updates in real time, exposes per-key variables, and provides talk/listen actions plus matching feedbacks and presets.

Microphone:

- Each user has one microphone state on the server: the device holding the mic, and whether it is muted. Muting silences the user everywhere, whichever device or panel did it.
- Actions `Mute microphone`, `Unmute microphone` and `Toggle microphone mute`. Toggle mutes a live mic and unmutes a muted one, or one no device holds. Unmuting when the holding device is gone hands the mic to the device that held it most recently.
- Feedbacks `Microphone muted` (on while muted or while no device holds the mic, red by default) and `Microphone live`.
- Variables `mic_muted`, `mic_device`, `mic_holder_online` and `mic_error` (why the last unmute could not find a device, cleared by the next mic state).
- Preset `Microphone mute` in the `Microphone and Selection` section: shows `MIC` and the holding device, toggles on press, and turns red while muted.

Listen level actions and variables use dB. The action range is `-100 dB` to `+6 dB`; direct user listen levels are clamped to `0 dB` max, while party lines can go up to `+6 dB`.
