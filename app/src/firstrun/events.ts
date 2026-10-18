import { listen } from "@tauri-apps/api/event";
import { call } from "../api/client";
import { FIRSTRUN_EVENT, parseCoreEvent, parsePlan } from "@orrery/firstrun";
import type { CoreEvent, FirstRunPlan, FirstRunSource, FirstRunStatus } from "@orrery/firstrun";

export type { CoreEvent, FirstRunPlan, FirstRunSource, FirstRunStatus };
export type {
  AgentPayload,
  CataloguePayload,
  CatalogueEntry,
  Constellation,
  DonePayload,
  FirstRunEventName,
  ImportPayload,
} from "@orrery/firstrun";
export { FIRSTRUN_EVENT, parseCoreEvent, parsePlan } from "@orrery/firstrun";

export class TauriFirstRunSource implements FirstRunSource {
  async plan(): Promise<FirstRunPlan> {
    const plan = parsePlan(await call<unknown>("firstrun_plan"));
    if (!plan) throw new Error("firstrun_plan returned something that is not a plan");
    return plan;
  }

  async consent(accepted: boolean): Promise<void> {
    await call("firstrun_consent", { accepted });
  }

  async scan(emit: (event: CoreEvent, offsetMs?: number) => void): Promise<void> {
    let finish: () => void = () => {};
    const donePromise = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const unlisteners: Array<() => void> = [];
    try {
      for (const name of Object.values(FIRSTRUN_EVENT)) {
        unlisteners.push(
          await listen<unknown>(name, (e) => {
            const event = parseCoreEvent(name, e.payload);
            if (!event) return;
            emit(event);
            if (event.name === FIRSTRUN_EVENT.done) finish();
          }),
        );
      }
      const started = call("firstrun_scan").then(() => donePromise);
      started.catch(() => {});
      await Promise.race([donePromise, started]);
    } finally {
      for (const off of unlisteners) off();
    }
    await call("services_start").catch(() => {});
  }

  async complete(): Promise<void> {
    await call("firstrun_complete");
  }
}

export function statusFromCore(): Promise<FirstRunStatus> {
  return call<FirstRunStatus>("firstrun_status");
}

export async function resetInCore(): Promise<void> {
  await call("firstrun_reset");
}
