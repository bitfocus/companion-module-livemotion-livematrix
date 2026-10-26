# LiveMatrix Companion Module

Control LiveMatrix talk/listen keys and microphone mute from Bitfocus Companion.

Connection modes:

- `server`: Connect directly to `ws://host:port/ws` (`wss://` with `Use TLS`) and authenticate with a LiveMatrix username/password. Use port `9443` with `Use TLS` on, or `9080` without TLS, unless the server's listeners were moved. The module pings the server while idle so the connection is not dropped, and reconnects after any drop.
- `Accept a self-signed certificate` (with `Use TLS`): connect to a server that has no trusted certificate for the host you entered, such as one addressed by IP address. The connection is still encrypted, but the server's identity is not checked.
- `client`: Connect to the control API of a LiveMatrix client app at `ws://127.0.0.1:9100`, with no login of its own. The app only accepts control API connections from the same machine, so it has to run on the computer Companion runs on.

If the server refuses the login because the password is wrong, the module stops and shows the error. If it refuses for a reason that clears up by itself, such as every licence being in use, the module keeps retrying. If the server ends the session on purpose (the end of a trial session, or a licence limit), the module stays disconnected until the connection config is saved again.

The module tracks key config and state updates in real time, exposes per-key variables, and provides talk/listen actions plus matching feedbacks and presets.

Microphone:

- Each user has one microphone state on the server: the device holding the mic, and whether it is muted. Muting silences the user everywhere, whichever device or panel did it. Holding a talk key sends audio through a muted mic without unmuting it.
- Actions `Mute microphone`, `Unmute microphone` and `Toggle microphone mute`. Toggle mutes a live mic and unmutes a muted one, or one no device holds. Unmuting when the holding device is gone hands the mic to the device that held it most recently.
- Feedbacks `Microphone muted` (on while muted or while no device holds the mic, amber by default, as in the client app) and `Microphone live` (on while audio is going out, including a talk key held through the mute).
- Variables `mic_muted`, `mic_open` (audio is going out), `mic_device`, `mic_holder_online` and `mic_error` (why the last unmute could not find a device, kept until a device holds the mic again or the next mute or unmute).
- Action `Move microphone to device` hands the mic to another of the user's devices and unmutes it there. Pick a device, or `Next device` to step through them from the one holding the mic. Companion panels are not offered, as they have no microphone. Needs a direct server connection; the client control API cannot move the mic.
- Feedback `Device holding the microphone` gives the holder's name as a value, for button text.
- Preset `Microphone mute` in the `Microphone and Selection` section: a mic icon while live, a struck-through mic in amber, as in the client app, while muted or while no device holds the mic. Pressing toggles the mute. The holding device's name is on the button as a `Device` element, switched off; turn it on to show it.

Keys can point at users, party lines, feeds (listen-only lines) and groups (talk-only).

Incoming activity, as the client app shows it on its key cards:

- Feedback `Listening to you`: someone the key reaches is listening to you. A group key counts its members. In client mode this needs a LiveMatrix app recent enough to list groups on its control API; with an older one a group key never lights.
- Feedback `Audio arriving`: audio from the key's user or line is reaching you right now, whether or not you listen. `Audio arrived recently` follows it for a minute after it stops.
- The key presets draw these as an amber stripe on the outer edge of the half they belong to: the talk half for `Listening to you`, the listen half for audio, dimmer while it trails. A lost connection puts every stripe out.

Listen level actions and variables use dB, from `-100 dB` (silence) to `+10 dB`.

Selected key:

- Press and hold a listen key or a combined intercom key and it is the selected key until you let go. Talk keys never select. With two keys held, the one held last wins; letting it go hands back to the other.
- The `Selected key volume` rotary and the `Selected key volume up/down` buttons act on the selected key. Hold a key with one hand and turn or press with the other. Holding a volume button keeps stepping until it is released.
- With nothing held and nothing chosen, no key is selected: the volume presets turn grey, the up button reads `Hold a key`, the down button shows a dash, and pressing them does nothing.
- The `Select key` action, or `Pressing selects this key and keeps it selected` on a key press, chooses a key that stays selected while nothing is held.
