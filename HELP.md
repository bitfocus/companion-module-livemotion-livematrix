# LiveMatrix Companion Module

Control LiveMatrix talk/listen keys and global state from Bitfocus Companion.

Connection modes:

- `server`: Connect directly to `ws://host:port/ws` and authenticate with a LiveMatrix username/password.
- `client`: Connect to a local LiveMatrix client proxy at `ws://host:port` with no login handshake.

The module tracks key config and state updates in real time, exposes per-key variables, and provides talk/listen/global actions plus matching feedbacks and presets.

Listen level actions and variables use dB. The action range is `-100 dB` to `+6 dB`; direct user listen levels are clamped to `0 dB` max, while party lines can go up to `+6 dB`.
