// mu — tmux substrate (back-compat re-export hub).
//
// The tmux implementation moved to src/mux/tmux.ts when the MuxBackend
// interface was extracted, so mu could grow a second multiplexer. This
// file re-exports it for tests and tmux-only callers
// (`import { ... } from "./tmux.js"`).
//
// NEW CODE SHOULD IMPORT `./mux.js` and go through `activeMux()`.
// Importing this module pins you to tmux specifically, which is correct
// only for genuinely tmux-only concerns (the `MU_TMUX_SOCKET` test
// isolation seam, `mu doctor`'s tmux version probe).

export * from "./mux/tmux.js";
