/**
 * Access state: whether the user has given Armillary access to the agent folders (first-run consent).
 *
 * After "Not now" the core refuses every command that reads agent folders or the process table with
 * the code consent_required. The views that need those commands show NoAccessNotice instead, with a
 * button that replays the consent plaque.
 */
import React, { createContext, useContext } from "react";
import { ApiError } from "./api/client";

export interface AccessState {
  granted: boolean;
  /** Show the consent plaque again (the first-run replay). */
  review?: () => void;
}

const AccessContext = createContext<AccessState>({ granted: true });

export const AccessProvider = AccessContext.Provider;

export function useAccess(): AccessState {
  return useContext(AccessContext);
}

/** Sentinel a view stores as its load error when the core answered consent_required. */
export const NO_ACCESS = "\u0000consent_required";

/** True for the core's refusal when consent is not recorded. */
export function isConsentRequired(err: unknown): boolean {
  if (err instanceof ApiError) return err.code === "consent_required";
  return Boolean(err && typeof err === "object" && (err as { code?: unknown }).code === "consent_required");
}

export function NoAccessNotice({ what }: { what?: string }): React.ReactElement {
  const { review } = useAccess();
  return (
    <section className="no-access" data-no-access="" aria-labelledby="no-access-title">
      <h2 id="no-access-title" className="no-access__title">
        Armillary has not been given access
      </h2>
      <p className="no-access__body">
        Armillary reads your agent folders only after you say yes on the first-run screen
        {what ? `, so ${what} stays empty for now` : ""}.
      </p>
      {review ? (
        <button type="button" className="obs-button obs-button--gilt no-access__button" onClick={review}>
          Give access
        </button>
      ) : null}
    </section>
  );
}
