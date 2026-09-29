import {
  Cartesian2,
  Cartesian3,
  type Color,
  type DistanceDisplayCondition,
  type Label,
  LabelCollection,
  LabelStyle,
  type NearFarScalar,
  type Scene,
  SceneMode,
  VerticalOrigin,
} from 'cesium';

import type { Satellite } from '../tle/parseCatalog.js';
import { hidePoint, writePoint } from './pointShaders.js';
import { type PickedPoint, PointsPrimitive } from './PointsPrimitive.js';
import type { TrackStore } from './TrackStore.js';

export interface PointStyle {
  /** Point diameter in pixels. */
  pixelSize: number;
  /** One colour per satellite. */
  colorOf: (satellite: Satellite) => Color;
  scaleByDistance?: NearFarScalar;
  translucencyByDistance?: NearFarScalar;
}

export interface LabelOptions {
  /** A CSS font shorthand, rasterised by the browser into Cesium's glyph atlas. */
  font: string;
  fillColor: Color;
  outlineColor: Color;
  outlineWidth: number;
  pixelOffset: Cartesian2;
  /** In `'all'` mode: hide names beyond this camera distance. */
  distanceDisplayCondition?: DistanceDisplayCondition;
  /** In `'all'` mode: shrink names with the camera distance. */
  scaleByDistance?: NearFarScalar;
}

/**
 * - `'none'`: no names.
 * - `'hover'`: the name of the satellite under the cursor (cheap).
 * - `'all'`: every visible satellite's name. A label is a billboard per glyph:
 *   with tens of thousands of satellites, filter first.
 */
export type LabelMode = 'none' | 'hover' | 'all';

const scratch = new Cartesian3();
const labelScratch = new Cartesian3();

/**
 * Every satellite as one point of a single {@link PointsPrimitive}, moved in
 * place when the clock changes: one loop over typed arrays and one upload per
 * frame, where an `Entity` per satellite would re-evaluate a property graph.
 */
export class PointLayer {
  private readonly scene: Scene;
  private readonly satellites: readonly Satellite[];
  private readonly tracks: TrackStore;
  private readonly labelOptions: LabelOptions;
  private readonly primitive: PointsPrimitive;
  /** Earth-fixed position of each point as drawn, metres. */
  private readonly positions: Float64Array;
  /** 1 where the point is drawn. */
  private readonly drawn: Uint8Array;
  private readonly removeMorphStart: () => void;
  private visible: Uint8Array | null = null;
  private lastMs = Number.NaN;

  private mode: LabelMode = 'none';
  private labels: LabelCollection | undefined;
  /** In `'all'` mode, the label of each catalog index that has one. */
  private labelOf = new Map<number, Label>();
  private hoverLabel: Label | undefined;
  private hovered: number | undefined;

  constructor(
    scene: Scene,
    satellites: readonly Satellite[],
    tracks: TrackStore,
    style: PointStyle,
    labelOptions: LabelOptions,
  ) {
    this.scene = scene;
    this.satellites = satellites;
    this.tracks = tracks;
    this.labelOptions = labelOptions;
    this.primitive = scene.primitives.add(
      new PointsPrimitive(satellites.map(style.colorOf), style),
    ) as PointsPrimitive;
    this.positions = new Float64Array(satellites.length * 3);
    this.drawn = new Uint8Array(satellites.length);
    // A morph to or from 2D ends, or starts, on a flat map. Points kept at
    // their height on the way would swell in perspective, high orbits most,
    // then jump back onto the map when the morph completes.
    this.removeMorphStart = scene.morphStart.addEventListener(
      (_: unknown, from: SceneMode, to: SceneMode) => {
        this.primitive.morphHeight = from === SceneMode.SCENE2D || to === SceneMode.SCENE2D ? 0 : 1;
      },
    );
  }

  /** Which catalog indices to draw (non-zero), or all of them with `null`. */
  setVisibility(visible: Uint8Array | null): void {
    this.visible = visible;
    if (this.mode === 'all') this.syncAllLabels();
    if (this.hovered !== undefined && !this.isVisible(this.hovered)) this.setHovered(undefined);
    this.invalidate();
  }

  setLabelMode(mode: LabelMode): void {
    if (mode === this.mode) return;
    this.disposeLabels();
    this.mode = mode;
    if (mode !== 'none') {
      this.labels = this.scene.primitives.add(
        new LabelCollection({ scene: this.scene }),
      ) as LabelCollection;
    }
    if (mode === 'all') this.syncAllLabels();
    if (mode === 'hover') {
      this.hoverLabel = this.labels!.add({ ...this.labelTemplate(), show: false });
    }
    this.invalidate();
  }

  /** Samples were replaced: positions must be re-read even if the clock stood still. */
  invalidate(): void {
    this.lastMs = Number.NaN;
    this.scene.requestRender();
  }

  /** Moves every visible point to its position at `ms`. */
  update(ms: number): void {
    if (ms === this.lastMs) return;
    this.lastMs = ms;

    const { positions, drawn, tracks, labelOf } = this;
    const { vertices } = this.primitive;
    let radiusSquared = 0;
    for (let i = 0; i < drawn.length; i++) {
      const position = this.isVisible(i) ? tracks.positionAt(i, ms, scratch) : null;
      if (position) {
        const { x, y, z } = position;
        positions[i * 3] = x;
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] = z;
        writePoint(vertices, i, x, y, z);
        drawn[i] = 1;
        radiusSquared = Math.max(radiusSquared, x * x + y * y + z * z);
      } else {
        hidePoint(vertices, i);
        drawn[i] = 0;
      }
    }
    this.primitive.markDirty(Math.sqrt(radiusSquared));

    for (const [i, label] of labelOf) this.placeLabel(label, i);
    if (this.hovered !== undefined && this.hoverLabel) {
      this.placeLabel(this.hoverLabel, this.hovered);
    }
  }

  /** Catalog index of the point drawn at `windowPosition`, if any. */
  pick(windowPosition: Cartesian2): number | undefined {
    const picked = this.scene.pick(windowPosition) as Partial<PickedPoint> | undefined;
    return picked?.primitive === this.primitive ? picked.index : undefined;
  }

  /** Shows the hover label on satellite `i` (in `'hover'` mode), or hides it. */
  setHovered(i: number | undefined): void {
    if (i === this.hovered) return;
    this.hovered = i;
    const label = this.hoverLabel;
    if (!label) return;
    if (i === undefined) {
      label.show = false;
    } else {
      label.text = this.satellites[i]!.name;
      this.placeLabel(label, i);
    }
    this.scene.requestRender();
  }

  /** Current position of satellite `i` as drawn, if it is drawn. */
  drawnPosition(i: number, result?: Cartesian3): Cartesian3 | undefined {
    if (this.drawn[i] !== 1) return undefined;
    const { positions } = this;
    return Cartesian3.fromElements(
      positions[i * 3]!,
      positions[i * 3 + 1]!,
      positions[i * 3 + 2]!,
      result,
    );
  }

  destroy(): void {
    this.removeMorphStart();
    this.disposeLabels();
    this.scene.primitives.remove(this.primitive);
  }

  private isVisible(i: number): boolean {
    return this.visible === null || this.visible[i] !== 0;
  }

  private placeLabel(label: Label, i: number): void {
    const position = this.drawnPosition(i, labelScratch);
    label.show = position !== undefined;
    if (position) label.position = position;
  }

  private labelTemplate() {
    const { font, fillColor, outlineColor, outlineWidth, pixelOffset } = this.labelOptions;
    return {
      font,
      fillColor,
      outlineColor,
      outlineWidth,
      pixelOffset,
      style: LabelStyle.FILL_AND_OUTLINE,
      verticalOrigin: VerticalOrigin.BOTTOM,
      position: Cartesian3.ZERO,
    };
  }

  /** One label per visible satellite, keeping the ones that stay visible. */
  private syncAllLabels(): void {
    const labels = this.labels!;
    for (const [i, label] of this.labelOf) {
      if (!this.isVisible(i)) {
        labels.remove(label);
        this.labelOf.delete(i);
      }
    }
    const template = {
      ...this.labelTemplate(),
      distanceDisplayCondition: this.labelOptions.distanceDisplayCondition,
      scaleByDistance: this.labelOptions.scaleByDistance,
      show: false,
    };
    for (let i = 0; i < this.satellites.length; i++) {
      if (!this.isVisible(i) || this.labelOf.has(i)) continue;
      this.labelOf.set(i, labels.add({ ...template, text: this.satellites[i]!.name }));
    }
  }

  private disposeLabels(): void {
    if (this.labels) this.scene.primitives.remove(this.labels);
    this.labels = undefined;
    this.labelOf = new Map();
    this.hoverLabel = undefined;
    this.hovered = undefined;
  }
}
