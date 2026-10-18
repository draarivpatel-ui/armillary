import { easeInCubic, easeInOutCubic, span } from "../math/ease";
import { mulMM, rotX, rotY, type Camera, type M3 } from "../math/vec";

/** Uniform scale of every layout length: 1 at 1440 x 900 CSS px. */
export const uiScale = (w: number, h: number): number => Math.min(w / 1440, h / 900);

export const ELEVATION = 0.27;
export const AZIMUTH_REF = -0.44;
/** Very slow orbit of the camera around the instrument, radians per ms (about 0.25 degrees a second). */
export const AZIMUTH_DRIFT = 0.0000044;

export function viewAt(t: number): M3 {
  return mulMM(rotX(ELEVATION), rotY(AZIMUTH_REF + (t - 12000) * AZIMUTH_DRIFT));
}

/** The reference view used to place the catalogue (the view a little after consent). */
export const PLACEMENT_VIEW: M3 = mulMM(rotX(ELEVATION), rotY(AZIMUTH_REF));

export interface CameraInputs {
  w: number;
  h: number;
  t: number;
  consentAt?: number;
  handoffAt?: number;
  reduced: boolean;
}

/** Base framing, the push-in after consent, and the hand-over dolly. */
export function cameraAt(c: CameraInputs): Camera & { dolly: number } {
  const { w, h, t } = c;
  let scale = h * 0.284;
  let cy = h * 0.44;
  let dolly = 0;
  if (c.consentAt !== undefined && t > c.consentAt) {
    const p = c.reduced ? 1 : easeInOutCubic(span(t, c.consentAt + 80, 1700));
    scale *= 1 + 0.12 * p;
    cy += (h * 0.478 - cy) * p;
  }
  if (c.handoffAt !== undefined && t > c.handoffAt && !c.reduced) {
    dolly = easeInCubic(span(t, c.handoffAt, 1500));
    scale *= 1 + 2.6 * dolly;
  }
  return { cx: w / 2, cy, scale, dist: 7.5, view: viewAt(c.reduced ? 12000 : t), dolly };
}
