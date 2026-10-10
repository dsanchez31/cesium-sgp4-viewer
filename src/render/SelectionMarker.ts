import {
  type Billboard,
  BillboardCollection,
  BoundingSphere,
  Cartesian3,
  Color,
  Ellipsoid,
  Occluder,
  type Scene,
  SceneMode,
} from 'cesium';

export interface SelectionMarkerStyle {
  color: Color;
  /** Diameter on screen, CSS pixels. */
  sizePixels: number;
}

/** One pulse every 1.6 s, growing to 2.5 times the ring. */
const PULSE_PERIOD_MS = 1_600;
const PULSE_SCALE = 2.5;
/** Opacity of the ring while the Earth hides the satellite. */
const HIDDEN_ALPHA = 0.35;
/** The ring image is drawn at this multiple of its size, for high-DPI screens. */
const OVERSAMPLE = 4;

const ringImage = (color: Color, size: number): HTMLCanvasElement => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size * OVERSAMPLE;
  const context = canvas.getContext('2d');
  if (!context) return canvas;
  const lineWidth = 2 * OVERSAMPLE;
  context.beginPath();
  context.arc(canvas.width / 2, canvas.height / 2, (canvas.width - lineWidth) / 2, 0, 2 * Math.PI);
  context.lineWidth = lineWidth;
  context.strokeStyle = color.toCssColorString();
  context.stroke();
  return canvas;
};

/**
 * A ring around the selected satellite, and a pulse growing out of it while the
 * clock runs (none under `prefers-reduced-motion`).
 *
 * The ring ignores the globe's depth so it is never clipped; whether the Earth
 * hides the satellite is decided here instead, and the ring fades rather than
 * vanishes, so the eye can still follow it round the limb.
 */
export class SelectionMarker {
  private readonly scene: Scene;
  private readonly collection: BillboardCollection;
  private readonly ring: Billboard;
  private readonly pulse: Billboard;
  private readonly ringColor = new Color(1, 1, 1, 1);
  private readonly pulseColor = new Color(1, 1, 1, 1);
  /** A sphere of the polar radius: a satellite just above the limb is never dimmed by mistake. */
  private readonly occluder = new Occluder(
    new BoundingSphere(Cartesian3.ZERO, Ellipsoid.WGS84.minimumRadius),
    new Cartesian3(),
  );
  private readonly reducedMotion: MediaQueryList;

  constructor(scene: Scene, style: SelectionMarkerStyle) {
    this.scene = scene;
    this.collection = scene.primitives.add(
      new BillboardCollection({ scene }),
    );
    const common = {
      image: ringImage(style.color, style.sizePixels),
      width: style.sizePixels,
      height: style.sizePixels,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      position: Cartesian3.ZERO,
      show: false,
    };
    // Added first, so the ring draws over its pulse.
    this.pulse = this.collection.add(common);
    this.ring = this.collection.add(common);
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  }

  /** Places the marker, or hides it with `undefined`. */
  update(position: Cartesian3 | undefined, isAnimating: boolean): void {
    const { ring, pulse } = this;
    if (!position) {
      ring.show = false;
      pulse.show = false;
      return;
    }

    let hidden = false;
    if (this.scene.mode === SceneMode.SCENE3D) {
      this.occluder.cameraPosition = this.scene.camera.positionWC;
      hidden = !this.occluder.isPointVisible(position);
    }

    ring.position = position;
    ring.show = true;
    this.ringColor.alpha = hidden ? HIDDEN_ALPHA : 1;
    ring.color = this.ringColor;

    pulse.show = isAnimating && !hidden && !this.reducedMotion.matches;
    if (!pulse.show) return;
    const phase = (performance.now() % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;
    pulse.position = position;
    pulse.scale = 1 + (PULSE_SCALE - 1) * phase;
    this.pulseColor.alpha = 0.8 * (1 - phase);
    pulse.color = this.pulseColor;
  }

  destroy(): void {
    this.scene.primitives.remove(this.collection);
  }
}
