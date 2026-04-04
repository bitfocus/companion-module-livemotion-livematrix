# LiveMatrix Companion Module

Control LiveMatrix talk/listen keys and global state from Bitfocus Companion.

Connection modes:

- `server`: Connect directly to `ws://host:port/ws` and authenticate with a LiveMatrix username/password.
- `client`: Connect to a local LiveMatrix client proxy at `ws://host:port` with no login handshake.

The module tracks key config and state updates in real time, exposes per-key variables, and provides talk/listen/global actions plus matching feedbacks and presets.
