import type { Color, ComponentDatatype, IndexDatatype, JulianDate, SceneMode } from 'cesium';
import * as Cesium from 'cesium';

/*
 * The part of CesiumJS's renderer the orbit primitive needs. These classes are
 * exported by the `cesium` package but are not part of its documented API nor
 * of its type definitions, hence the narrow types below. They have been stable
 * for many releases; they are the first thing to check after a Cesium upgrade.
 */

export interface Destroyable {
  destroy(): void;
}

export interface GpuBuffer extends Destroyable {
  /** When `true` (the default), destroying a vertex array destroys this buffer too. */
  vertexArrayDestroyable: boolean;
  copyFromArrayView(arrayView: ArrayBufferView, offsetInBytes?: number): void;
}

export interface CesiumInternals {
  Buffer: {
    createVertexBuffer(options: {
      context: unknown;
      typedArray: Float32Array | Uint8Array;
      usage: unknown;
    }): GpuBuffer;
    createIndexBuffer(options: {
      context: unknown;
      typedArray: Uint32Array;
      usage: unknown;
      indexDatatype: IndexDatatype;
    }): GpuBuffer;
  };
  BufferUsage: { STATIC_DRAW: unknown; DYNAMIC_DRAW: unknown };
  VertexArray: new (options: {
    context: unknown;
    attributes: readonly {
      index: number;
      vertexBuffer: GpuBuffer;
      componentsPerAttribute: number;
      componentDatatype: ComponentDatatype;
      normalize?: boolean;
      offsetInBytes: number;
      strideInBytes: number;
    }[];
    indexBuffer?: GpuBuffer;
  }) => Destroyable;
  ShaderProgram: {
    fromCache(options: {
      context: unknown;
      vertexShaderSource: string;
      fragmentShaderSource: string;
      attributeLocations: Record<string, number>;
    }): Destroyable;
  };
  RenderState: { fromCache(options: object): unknown };
  DrawCommand: new (options: object) => unknown;
  Pass: { OPAQUE: number };
}

/** The part of Cesium's (untyped) `FrameState` a primitive reads. */
export interface FrameState {
  context: unknown;
  mode: SceneMode;
  time: JulianDate;
  passes: { render: boolean; pick: boolean };
  commandList: unknown[];
}

/** What `context.createPickId` returns: `scene.pick` answers with `object`. */
export interface PickId extends Destroyable {
  color: Color;
}

const REQUIRED = [
  'Buffer',
  'BufferUsage',
  'VertexArray',
  'ShaderProgram',
  'RenderState',
  'DrawCommand',
  'Pass',
] as const;

let checked: CesiumInternals | null | undefined;

/**
 * The internal renderer classes, or `null` (with a warning, once) when this
 * Cesium build does not expose them. Callers then draw no orbits rather than
 * break the scene.
 */
export const getCesiumInternals = (): CesiumInternals | null => {
  if (checked !== undefined) return checked;
  const namespace = Cesium as unknown as Record<string, unknown>;
  const missing = REQUIRED.filter((name) => namespace[name] === undefined);
  if (missing.length > 0) {
    console.warn(
      `[cesium-sgp4-viewer] orbits disabled: this CesiumJS build does not expose ${missing.join(', ')}.`,
    );
    checked = null;
  } else {
    checked = namespace as unknown as CesiumInternals;
  }
  return checked;
};
