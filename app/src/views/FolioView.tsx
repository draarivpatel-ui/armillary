import React, { useEffect, useMemo, useState } from "react";
import { ArmillaryMark, Mark } from "@orrery/design";
import "./folio-view.css";
import { Folio, anchorSeqFor, fromContract } from "@orrery/folio";
import type { Message, Session } from "@armillary/model";
import { loadSessionMessages, sessionGet, sessionsQuery } from "../api/archive";
import { dataMode } from "../api/client";
import { useNavigation } from "../navigation";

type Load =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "missing" }
  | { status: "error"; message: string }
  | { status: "ready"; session: Session; messages: Message[]; total: number; complete: boolean };

function useDocumentTheme(): "dark" | "light" {
  const read = () =>
    typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") === "light"
      ? "light"
      : "dark";
  const [theme, setTheme] = useState<"dark" | "light">(read);
  useEffect(() => {
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

/**
 * The Folio inside the app: the real ui/folio reader fed by session_get and messages_page (page by page,
 * first page rendered at once) through the contract adapter. Opens the session the navigation asks for,
 * at its anchor; with no target it opens the most recent session.
 */
export const FolioView: React.FC = () => {
  const { folioTarget } = useNavigation();
  const theme = useDocumentTheme();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const mode = dataMode();

  useEffect(() => {
    let active = true;
    setLoad({ status: "loading" });
    (async () => {
      let session: Session | null = null;
      if (folioTarget) {
        session = await sessionGet(folioTarget.sessionId);
      } else {
        session = (await sessionsQuery({ limit: 1 })).items[0] ?? null;
      }
      if (!active) return;
      if (!session) {
        setLoad({ status: folioTarget ? "missing" : "empty" });
        return;
      }
      const opened = session;
      const result = await loadSessionMessages(opened.id, {
        onPage: (soFar, total) => {
          if (active) setLoad({ status: "ready", session: opened, messages: soFar, total, complete: soFar.length >= total });
        },
      });
      if (active) {
        setLoad({ status: "ready", session: opened, messages: result.messages, total: result.total, complete: true });
      }
    })().catch((err: unknown) => {
      if (active) setLoad({ status: "error", message: err instanceof Error ? err.message : String(err) });
    });
    return () => {
      active = false;
    };
  }, [folioTarget]);

  const folio = useMemo(
    () => {
      if (load.status !== "ready") return null;
      const out = fromContract(load.session, load.messages);
      // show the derived title when the agent recorded none (the contract title stays unknown)
      const display = (load.session as Session & { display_title?: string | null }).display_title;
      if (!out.session.title && display) out.session.title = display;
      return out;
    },
    [load],
  );

  const anchorSeq = useMemo(() => {
    if (load.status !== "ready" || !folioTarget?.anchor) return null;
    const { seq, message_id } = folioTarget.anchor;
    if (typeof seq === "number") return seq;
    return message_id ? anchorSeqFor(load.messages, message_id) : null;
  }, [load, folioTarget]);

  // With an anchor, wait until its message has arrived so the reader opens exactly there.
  const showFolio =
    load.status === "ready" &&
    folio !== null &&
    (anchorSeq === null || load.complete || load.messages.some((m) => m.seq >= anchorSeq));

  return (
    <section className="folio-view" aria-label="Folio" data-data-mode={mode} data-folio-state={load.status}>
      {mode === "mock" && (
        <Mark tone="neutral" shape="ring" className="folio-view__mode" title="No archive is connected in this window; this session is an example">
          Demo data
        </Mark>
      )}
      {load.status === "loading" && <FolioNote title="Opening the folio" />}
      {load.status === "empty" && (
        <FolioNote
          title="No sessions in the archive yet."
          body="Import from the Field Guide, then open one from the Almanac or Search."
        />
      )}
      {load.status === "missing" && (
        <FolioNote
          title="This session is not in the archive yet."
          body="It appears here once its agent's history has been imported."
        />
      )}
      {load.status === "error" && <FolioNote title="This session could not be opened." body={load.message} alert />}
      {load.status === "ready" && folio && showFolio && (
        <Folio
          key={`${load.session.id}:${folioTarget?.nonce ?? 0}`}
          session={folio.session}
          messages={folio.messages}
          toolCalls={folio.toolCalls}
          theme={theme}
          anchorSeq={anchorSeq}
          eyebrow="Folio"
        />
      )}
      {load.status === "ready" && !load.complete && (
        <p className="folio-view__progress" aria-live="polite">
          {`Loaded ${load.messages.length} of ${load.total} messages`}
        </p>
      )}
    </section>
  );
};

/** An engraved note in the middle of the stage: loading, empty, missing or failed. */
function FolioNote({ title, body, alert = false }: { title: string; body?: string; alert?: boolean }) {
  return (
    <div className="folio-view__note" role={alert ? "alert" : "status"}>
      <ArmillaryMark size={48} className="folio-view__note-mark" />
      <p className="folio-view__note-title">{title}</p>
      {body && <p className="folio-view__note-body">{body}</p>}
    </div>
  );
}

export default FolioView;
