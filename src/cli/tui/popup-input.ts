// Keyboard gate for popups.
//
// <App> keeps the open popup MOUNTED (display="none") while the `?`
// help overlay covers it, so popup-local state (cursor, filter query,
// drill pin, drill scroll) survives a help round trip. A hidden popup
// must not react to keys meant for the overlay, so every popup reads
// its keyboard through `usePopupInput`, which turns ink's `useInput`
// off while the App says the popup is covered.

import { useInput } from "ink";
import { createContext, useContext } from "react";

/** False while the help overlay covers the open popup. */
export const PopupInputActive = createContext(true);

type InputHandler = Parameters<typeof useInput>[0];

export function usePopupInput(handler: InputHandler): void {
  const isActive = useContext(PopupInputActive);
  useInput(handler, { isActive });
}
