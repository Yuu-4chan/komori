import { createContext, useContext } from "react";

/**
 * The shell's top-bar search slot. A page that searches renders its field there through a
 * portal; null outside the shell, as in tests, where the page shows the field itself.
 */
export const ShellSearchSlot = createContext<HTMLElement | null>(null);

export const useShellSearchSlot = () => useContext(ShellSearchSlot);
