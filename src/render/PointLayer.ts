import {
  BlendOption,
  Cartesian2,
  Cartesian3,
  type Color,
  type DistanceDisplayCondition,
  type Label,
  LabelCollection,
  LabelStyle,
  type NearFarScalar,
  type PointPrimitive,
  PointPrimitiveCollection,
  type Scene,
  VerticalOrigin,
} from 'cesium';

import type { Satellite } from '../tle/parseCatalog.js';
import type { PositionSource } from './PositionSource.js';

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

/**
 * Every satellite as one point of a single `PointPrimitiveCollection`, moved in
 * place when the clock changes. One draw call for the whole catalog, where an
 * `Entity` per satellite would re-evaluate a property graph per frame.
 */
export class PointLayer {
  private readonly scene: Scene;
  private readonly satellites: readonly Satellite[];
  private readonly tracks: PositionSource;
  private readonly labelOptions: LabelOptions;
  private readonly collection: PointPrimitiveCollection;
  private readonly points: PointPrimitive[];
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
    tracks: PositionSource,
    style: PointStyle,
    labelOptions: LabelOptions,
  ) {
    this.scene = scene;
    this.satellites = satellites;
    this.tracks = tracks;
    this.labelOptions = labelOptions;
    // Translucent: overlapping points add up to brightness, so a dense shell
    // reads as a density rather than a flat disc.
    this.collection = scene.primitives.add(
      new PointPrimitiveCollection({ blendOption: BlendOption.TRANSLUCENT }),
    );
    this.points = satellites.map((satellite, i) =>
      this.collection.add({
        id: i,
        show: false,
        pixelSize: style.pixelSize,
        color: style.colorOf(satellite),
        scaleByDistance: style.scaleByDistance,
        translucencyByDistance: style.translucencyByDistance,
      }),
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
      this.labels = this.scene.primitives.add(new LabelCollection({ scene: this.scene }));
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

    const { points, tracks, labelOf } = this;
    for (let i = 0; i < points.length; i++) {
      const point = points[i]!;
      const position = this.isVisible(i) ? tracks.positionAt(i, ms, scratch) : null;
      if (position) {
        point.position = position as Cartesian3;
        point.show = true;
      } else {
        point.show = false;
      }
    }

    for (const [i, label] of labelOf) {
      const point = points[i]!;
      label.show = point.show;
      if (point.show) label.position = point.position;
    }

    if (this.hovered !== undefined && this.hoverLabel) {
      const point = points[this.hovered]!;
      this.hoverLabel.show = point.show;
      if (point.show) this.hoverLabel.position = point.position;
    }
  }

  /** Catalog index of the point drawn at `windowPosition`, if any. */
  pick(windowPosition: Cartesian2): number | undefined {
    const picked = this.scene.pick(windowPosition) as
      { collection?: unknown; id?: unknown } | undefined;
    return picked?.collection === this.collection && typeof picked.id === 'number'
      ? picked.id
      : undefined;
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
      const point = this.points[i]!;
      label.show = point.show;
      label.position = point.position;
    }
    this.scene.requestRender();
  }

  /** Current position of satellite `i` as drawn, if it is drawn. */
  drawnPosition(i: number): Cartesian3 | undefined {
    const point = this.points[i];
    return point?.show ? point.position : undefined;
  }

  destroy(): void {
    this.disposeLabels();
    this.scene.primitives.remove(this.collection);
  }

  private isVisible(i: number): boolean {
    return this.visible === null || this.visible[i] !== 0;
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
