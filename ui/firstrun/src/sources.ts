/**
 * Where the first run's facts come from. The app provides a Tauri source (app/src/firstrun);
 * the web build and the demo recordings replay a recorded event log.
 */
import { parseCoreEvent, parseRecordedLog, type CoreEvent, type FirstRunPlan, type RecordedLog } from "./events";

export interface FirstRunSource {
  /** Registry only: the catalogue and the folders it will look in. Never scans. */
  plan(): Promise<FirstRunPlan>;
  /** Records the user's answer. Accepting must happen before scan(). */
  consent(accepted: boolean): Promise<void>;
  /**
   * Starts the scan. Calls emit for each core event; `offsetMs` (ms after consent) is given by
   * recorded sources so the host can stamp them on its timeline; live sources omit it.
   * Resolves when the scan is over (the import may continue in the background after a skip).
   */
  scan(emit: (event: CoreEvent, offsetMs?: number) => void): Promise<void>;
  /** Marks the first run complete (it will not show on the next launch). */
  complete(): Promise<void>;
}

/** Replays a recorded event log. The catalogue inside comes from the registry it was recorded from. */
export class RecordedSource implements FirstRunSource {
  constructor(private log: RecordedLog) {}

  static fromJson(json: unknown): RecordedSource {
    const log = parseRecordedLog(json);
    if (!log) throw new Error("not a first-run event log");
    return new RecordedSource(log);
  }

  get recorded(): RecordedLog {
    return this.log;
  }

  async plan(): Promise<FirstRunPlan> {
    return this.log.plan;
  }

  async consent(): Promise<void> {}

  async scan(emit: (event: CoreEvent, offsetMs?: number) => void): Promise<void> {
    for (const e of this.log.events) {
      const ev = parseCoreEvent(e.name, e.payload);
      if (ev) emit(ev, e.at);
    }
  }

  async complete(): Promise<void> {}
}
