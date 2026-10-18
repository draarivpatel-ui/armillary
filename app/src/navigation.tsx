/**
 * App navigation: which view is showing, and which session the Folio should open (with an optional
 * anchor: a search hit's message id, seq and block index). Search, the Almanac and the Orrery call
 * openSession(); the Folio reads folioTarget.
 *
 * The shell (App.tsx) owns the view state and provides this context with useNavigationController().
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SessionAnchor } from "./api/types";
import { registerTourAction } from "./presentation/locators";

export type ViewKey =
  | "orrery"
  | "almanac"
  | "folio"
  | "field-guide"
  | "switchboard"
  | "launchpad"
  | "search";

export interface FolioTarget {
  sessionId: string;
  anchor: SessionAnchor | null;
  /** Increases on every openSession call, so opening the same hit twice still scrolls. */
  nonce: number;
}

export interface Navigation {
  view: ViewKey;
  setView: (view: ViewKey) => void;
  /** Show this session in the Folio, optionally at an anchor. */
  openSession: (sessionId: string, anchor?: SessionAnchor | null) => void;
  folioTarget: FolioTarget | null;
}

const NavigationContext = createContext<Navigation | null>(null);

/** Build the navigation value from the shell's view state. */
export function useNavigationController(view: ViewKey, setView: (view: ViewKey) => void): Navigation {
  const [folioTarget, setFolioTarget] = useState<FolioTarget | null>(null);
  const nonce = useRef(0);
  const openSession = useCallback(
    (sessionId: string, anchor?: SessionAnchor | null) => {
      nonce.current += 1;
      setFolioTarget({ sessionId, anchor: anchor ?? null, nonce: nonce.current });
      setView("folio");
    },
    [setView],
  );
  // The presentation tour (window.__armillaryTour.openSession) opens sessions through the same path.
  useEffect(() => registerTourAction("openSession", (id: string) => openSession(id)), [openSession]);
  return useMemo(() => ({ view, setView, openSession, folioTarget }), [view, setView, openSession, folioTarget]);
}

export function NavigationProvider({ value, children }: { value: Navigation; children: ReactNode }) {
  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

/** Standalone provider (tests, previews): owns its own view state. */
export function StandaloneNavigation({ initialView = "orrery", children }: { initialView?: ViewKey; children: ReactNode }) {
  const [view, setView] = useState<ViewKey>(initialView);
  const value = useNavigationController(view, setView);
  return <NavigationProvider value={value}>{children}</NavigationProvider>;
}

/** Navigation for views. Outside a provider it is inert (views still render in isolation and tests). */
export function useNavigation(): Navigation {
  const ctx = useContext(NavigationContext);
  return (
    ctx ?? {
      view: "orrery",
      setView: () => {},
      openSession: () => {},
      folioTarget: null,
    }
  );
}
