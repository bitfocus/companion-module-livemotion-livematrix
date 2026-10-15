# companion-module-livematrix

A [Bitfocus Companion](https://bitfocus.io/companion) module for controlling
[LiveMatrix](https://github.com/yannisgu/livematrix) talk and listen keys, and
microphone mute, from hardware panels.

The module is control-only: it speaks the LiveMatrix WebSocket protocol on `/ws`
and never negotiates WebRTC, so adding a panel does not create an audio pipeline
on the server. It connects either straight to a LiveMatrix server or to the
local control API exposed by a logged-in LiveMatrix desktop client.

## What it gives you

- Talk and listen keys with the same momentary/latching behaviour as the client
- A layered key button: listen fills the left half green, talk the right half
  red, with the listen level along the bottom
- A key selection, so one rotary can trim whichever key was last pressed
- Mute, unmute and toggle-mute actions for the user's one microphone, with a
  `mic_button` preset that shows the device holding the mic and turns red while
  it is muted. Mute state lives on the server, so the button follows changes
  made in the app and the app follows changes made here.
- Variables and feedbacks addressed by index, by target, or by selected key

## Requirements

- Companion 5.0 or newer (this module uses module API 2.x)
- Node 22.20+ or 26.5+ to build

## Development

```bash
npm install
npm run build
```

Point Companion's developer modules path at the folder that contains this
repository, then add a "LiveMatrix" connection. Companion runs modules under
Node's permission model with filesystem access scoped to the module directory,
so this needs to be a real directory with its own `node_modules` — a symlink
into another checkout will fail to load.

## Tests

```bash
npm test
```

The suite runs the module against a fake LiveMatrix WebSocket endpoint
(`test/support/`), in both connection modes, with Companion's `InstanceBase`
mocked out.

## Layout

- `src/index.ts`: the instance, with its actions, feedbacks, variables and key
  press handling
- `src/connection.ts`: the WebSocket, reconnects and keepalive
- `src/protocol.ts`: wire message types
- `src/key-state.ts`: which part of a state update each kind of key reads
- `src/presets.ts`, `src/options.ts`: presets, and the option fields they share
  with actions and feedbacks
- `src/config.ts`, `src/levels.ts`: connection config, and level conversions

## Packaging

```bash
npm run package
```
