// Consume App-level PopupAction events one per render.
//
// App emits popup actions (today: a mouse double-click's `clickRow`)
// as a sequenced queue. This hook dispatches only the next unseen
// action, stores its sequence in state, and lets React render before
// dispatching the following one, so each action sees the state the
// previous one produced.

import { useEffect, useRef, useState } from "react";
import type { PopupAction, PopupActionEnvelope } from "./keys.js";

export function usePopupActionQueue(
  actions: readonly PopupActionEnvelope[] | undefined,
  dispatch: (action: PopupAction) => void,
): void {
  const [lastSeq, setLastSeq] = useState(0);
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  useEffect(() => {
    const next = actions?.find((event) => event.seq > lastSeq);
    if (next === undefined) return;
    setLastSeq(next.seq);
    dispatchRef.current(next.action);
  }, [actions, lastSeq]);
}
