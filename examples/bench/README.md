# Render benchmark

Compares the per-object renderers of the library with CesiumJS's buffer collections (Cesium 1.146, [CesiumGS/cesium#13511](https://github.com/CesiumGS/cesium/pull/13511)), for issue [#18](https://github.com/dsanchez31/cesium-sgp4-viewer/issues/18).

| Layer  | Legacy                                       | Buffer                                                            |
| ------ | -------------------------------------------- | ----------------------------------------------------------------- |
| Points | `PointPrimitiveCollection`, one setter each  | `BufferPointCollection`, one `setPositions` per frame             |
| Orbits | `OrbitPrimitive` (internal renderer classes) | one `BufferPolylineCollection` per regime, model matrix per frame |

## Run

```sh
pnpm install
pnpm --filter example-bench dev
```

Keep the tab in the foreground and the window size fixed. Pick a size and the two implementations, then **Run**, or **Run matrix** for every combination (24 runs, about 5 minutes). **Copy JSON** puts the results, the user agent and the canvas size on the clipboard.

## What is measured

- The workload is synthetic: Kepler orbits with the regime mix of the public catalog, seeded, so every run draws the same satellites. Both implementations read the very same positions; SGP4 and the workers are out of the loop.
- Each run warms up for 3 s, then records 10 s.
- **Update ms**: main-thread time of the layers' per-frame update (`scene.preUpdate`).
- **Frame CPU ms**: main-thread time from `preUpdate` to `postRender`, that is the update plus Cesium's own work (buffer uploads, command submission).
- **FPS**: from the interval between two frames, capped by the display refresh rate. When both sides hit the cap, compare the CPU times.
- **Heap MB**: `performance.memory.usedJSHeapSize`, Chromium only.
- No GPU time: WebGL has no portable GPU timer.

## Known differences

- 3D only: the buffer collections do not render in 2D, Columbus view or during a morph.
- Buffer points have a fixed size and opacity: `BufferPointMaterial` has no `scaleByDistance` nor `translucencyByDistance`.
- Buffer orbits blend in Cesium's translucent pass (order-independent), legacy orbits in the opaque pass in regime order. Check by eye that LEO does not wash out MEO and GEO.

## Results

2026-10-10, Chrome 155 on Linux, 60 Hz display, canvas 1853 × 927, device pixel ratio 1, **Run matrix**.

| N       | Points | Orbits | Update ms (mean / p95) | Frame CPU ms (mean / p95) | FPS  | Heap MB |
| ------- | ------ | ------ | ---------------------- | ------------------------- | ---- | ------- |
| 16,000  | legacy | off    | 2.59 / 2.90            | 3.50 / 3.80               | 60.0 | 97      |
| 16,000  | buffer | off    | 3.25 / 3.60            | 3.48 / 3.80               | 60.0 | 105     |
| 16,000  | legacy | legacy | 2.61 / 3.00            | 3.53 / 3.90               | 60.0 | 171     |
| 16,000  | buffer | legacy | 3.24 / 3.60            | 3.47 / 3.80               | 60.0 | 209     |
| 16,000  | legacy | buffer | 2.61 / 3.00            | 3.51 / 3.90               | 60.0 | 347     |
| 16,000  | buffer | buffer | 3.21 / 3.60            | 3.43 / 3.80               | 60.0 | 365     |
| 50,000  | legacy | off    | 7.56 / 7.90            | 10.05 / 10.40             | 60.0 | 172     |
| 50,000  | buffer | off    | 7.62 / 8.00            | 7.82 / 8.20               | 60.0 | 193     |
| 50,000  | legacy | legacy | 7.69 / 8.10            | 10.36 / 10.80             | 60.0 | 373     |
| 50,000  | buffer | legacy | 7.74 / 8.10            | 7.94 / 8.40               | 60.0 | 404     |
| 50,000  | legacy | buffer | 7.74 / 8.10            | 10.28 / 10.80             | 60.0 | 892     |
| 50,000  | buffer | buffer | 7.85 / 8.30            | 8.05 / 8.60               | 60.0 | 915     |
| 100,000 | legacy | off    | 15.05 / 15.30          | 19.97 / 20.20             | 49.7 | 1009    |
| 100,000 | buffer | off    | 15.01 / 15.50          | 15.23 / 15.70             | 60.0 | 1029    |
| 100,000 | legacy | legacy | 15.11 / 15.50          | 19.99 / 20.40             | 48.3 | 696     |
| 100,000 | buffer | legacy | 15.05 / 15.50          | 15.27 / 15.70             | 60.0 | 970     |
| 100,000 | legacy | buffer | 15.11 / 15.50          | 20.18 / 20.80             | 46.1 | 1683    |
| 100,000 | buffer | buffer | 15.12 / 15.80          | 15.34 / 16.00             | 43.8 | 1765    |
| 250,000 | legacy | off    | 38.53 / 38.80          | 51.77 / 52.10             | 19.2 | 1979    |
| 250,000 | buffer | off    | 37.34 / 37.50          | 37.66 / 37.90             | 26.5 | 585     |
| 250,000 | legacy | legacy | 38.99 / 39.30          | 52.85 / 53.20             | 18.8 | 1482    |
| 250,000 | buffer | legacy | 37.58 / 37.90          | 37.91 / 38.20             | 26.3 | 2219    |
| 250,000 | legacy | buffer | 38.05 / 38.40          | 51.45 / 51.90             | 19.3 | 4057    |
| 250,000 | buffer | buffer | 37.68 / 38.40          | 38.01 / 38.70             | 17.8 | 4243    |

Heap sizes are noisy: runs follow each other with no forced garbage collection.

## Conclusions

- **Points.** The update loop costs the same on both sides: the position source dominates it. The gain is in Cesium's own work after the update: 0.9 to 13 ms for `PointPrimitiveCollection` (one object per point), a flat 0.2 to 0.3 ms for `BufferPointCollection`. Frame CPU drops by 22 % at 50,000, 24 % at 100,000 and 27 % at 250,000 points (19 to 26 fps). At the size of today's catalog (16,000) there is no measurable gain.
- **Orbits.** Same CPU, since rings are static on both sides. The polyline collections cost more GPU time (from 100,000 rings: 43.8 against 60 fps, then 17.8 against 26.3 fps, with a growing p95 interval) and far more memory (about 175 MB more at 16,000 rings, 2.5 GB more at 250,000).
- **Decision.** The library keeps `PointPrimitiveCollection` and `OrbitPrimitive` for now: no gain at today's size, no 2D, Columbus view or morph support, no distance scaling on buffer points. The switch waits for those in CesiumJS.
