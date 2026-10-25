# companion-module-livemotion-livematrix

A [Bitfocus Companion](https://bitfocus.io/companion) module that controls
livematrix talk and listen keys, and the microphone mute, from hardware panels.

The module only sends control messages. It never negotiates WebRTC, so a panel
does not add an audio pipeline on the server. It connects either to a livematrix
server at `/ws`, or to the control API of a logged-in livematrix client app on
the same machine.

See [HELP.md](./companion/HELP.md) for the actions, feedbacks and presets, and
[LICENSE](./LICENSE) for the licence.

## What it does

- Talk and listen keys latch or act as momentary keys the same way they do in
  the client app.
- Key presets look like the client app's key cards, in its colours. The name and
  listen level are on top. The L and T halves underneath fill green and red while
  on, and get a ring while latched.
- A key's talk half gets an amber stripe while someone the key reaches is
  listening to you. Its listen half gets one while their audio is arriving.
- Holding a key selects it, so one rotary or a pair of volume buttons can set the
  level of whichever key you hold.
- Mute, unmute, toggle and move actions control the user's one microphone. The
  `Microphone mute` preset turns amber while the mic is muted. The server keeps
  the mute state, so the button follows mutes made in the app, and the app
  follows mutes made here.
- Variables and feedbacks find their key by position, by target, or as the
  selected key.

## Requirements

- Companion 5.0 or newer, because the module uses module API 2.x
- Node 26.5+ to build

## Development

```bash
yarn install
yarn build
```

Point Companion's developer modules path at the folder that contains this
repository, then add a "livematrix" connection. Companion runs
modules under Node's permission model, which limits file access to the module
directory. The checkout therefore has to be a real directory with its own
`node_modules`. A symlink into another checkout fails to load.

## Tests

```bash
yarn test
```

The tests run the module against a fake livematrix WebSocket endpoint in
`test/support/`, in both connection modes, with a mock of Companion's
`InstanceBase`.

## Layout

- `src/index.ts` has the instance, with its actions, feedbacks, variables and
  key press handling.
- `src/connection.ts` has the WebSocket, with reconnects and keepalive.
- `src/protocol.ts` has the wire message types.
- `src/key-state.ts` decides which part of a state update each kind of key reads.
- `src/activity.ts` tracks who is listening to you and whose audio is arriving.
- `src/presets.ts` has the presets, and `src/options.ts` has the option fields
  they share with the actions and feedbacks.
- `src/brand.ts` and `src/icons.ts` have the client app's colours and icons.
- `src/config.ts` has the connection config, and `src/levels.ts` converts levels.

## Packaging

```bash
yarn package
```
