# livematrix

This module controls livematrix talk and listen keys and the microphone mute from Bitfocus Companion.

## Connection

The module connects in one of two modes.

- `Direct to server` connects to `ws://host:port/ws`, or `wss://` with TLS on, and logs in with a livematrix username and password. An installed server listens on port `55678`. The module pings the server while the link is idle so the server does not drop it, and reconnects after any drop.
- `Via a client's control API` connects to a livematrix client app at `ws://127.0.0.1:9100` and needs no login, because the app is already logged in. The app only accepts control API connections from its own machine, so it has to run on the computer that runs Companion.

A wrong password stops the module, which shows the error. If the server refuses the login for a reason that clears up by itself, such as every licence being in use, the module keeps retrying. If the server ends the session on purpose, for example at the end of a trial session, the module stays disconnected until you save the connection config again.

## Keys

A key points at a user, a party line, a feed or a group. Feeds are listen-only lines, and groups are talk-only.

The module follows key config and state changes as the server sends them. It has talk and listen actions, feedbacks and variables for each key, and presets drawn like the client app's key cards. Actions and feedbacks find their key by target, by position in the key list, or as the selected key.

Listen levels are in dB, from `-100 dB` (silence) to `+10 dB`.

## Microphone

Each user has one microphone state on the server. It records which device holds the mic and whether the mic is muted. A mute silences the user on every device, whichever device or panel muted it. Holding a talk key sends audio through a muted mic without unmuting it.

- `Mute microphone` and `Unmute microphone` set the mute. If the device holding the mic is gone, unmuting hands the mic to the device that held it most recently.
- `Toggle microphone mute` mutes a live mic. It unmutes a muted mic, or a mic that no device holds.
- `Move microphone to device` hands the mic to another of the user's devices and unmutes it there. Pick a device, or pick `Next device` to step through them, starting after the device that holds the mic. Companion panels have no microphone, so the list leaves them out. Moving the mic needs a direct server connection, because the client control API cannot move it.
- The `Microphone muted` feedback is on while the mic is muted or no device holds it. Its default style is amber, as in the client app.
- The `Microphone live` feedback is on while audio is going out. That includes a talk key held through the mute.
- The `Device holding the microphone` feedback gives the device's name as a value, for button text.
- The variables are `mic_muted`, `mic_open` (audio is going out), `mic_device`, `mic_holder_online` and `mic_error`. `mic_error` says why the last unmute found no device. It keeps that text until a device holds the mic again, or until the next mute or unmute.

The `Microphone mute` preset is in the `Microphone and selection` section. It shows a mic while the mic is live. While the mic is muted or no device holds it, the button turns amber and shows a struck-through mic. Pressing it toggles the mute. The preset has a `Device` element with the holding device's name, switched off by default. Turn it on to show the name.

## Incoming activity

These feedbacks match the stripes the client app draws on its key cards.

- `Listening to you` is on while someone the key reaches is listening to you. A group key counts its members.
- `Audio arriving` is on while audio from the key's user or line reaches you, whether or not you listen to it.
- `Audio arrived recently` stays on for one minute after that audio stops.

The key presets draw these as an amber stripe on the outer edge of a key half. `Listening to you` goes on the talk half, and arriving audio goes on the listen half. The listen stripe dims for the minute after the audio stops. When the connection drops, every stripe goes out.

## Selected key

The selected key is the key that the volume presets and every `Selected key` action and feedback act on.

- While you hold a listen key or an intercom key, it is the selected key. Letting go ends the selection. A talk key does not select, unless you turn on `Holding selects this key` in its `Talk key down` action. With two keys held, the one you pressed last wins, and letting it go hands the selection back to the other.
- The `Selected key volume` rotary turns the selected key's level up and down in 1 dB steps, and pressing it sets the level to 0 dB. The `Selected key volume up` and `Selected key volume down` buttons step it by 1 dB, and keep stepping while you hold them. Hold a key with one hand and use the volume controls with the other.
- With no key held and none chosen, nothing is selected. The volume presets turn grey, the up button reads `Hold a key`, the down button shows a dash, and pressing them does nothing.
- The `Select key` action chooses a key that stays selected while you hold no other key. The `Pressing selects this key and keeps it selected` option on a key press does the same.
