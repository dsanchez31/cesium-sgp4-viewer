# cesium-sgp4-viewer

[![npm](https://img.shields.io/npm/v/@dsanchez31/cesium-sgp4-viewer)](https://www.npmjs.com/package/@dsanchez31/cesium-sgp4-viewer)
[![CI](https://github.com/dsanchez31/cesium-sgp4-viewer/actions/workflows/ci.yml/badge.svg)](https://github.com/dsanchez31/cesium-sgp4-viewer/actions/workflows/ci.yml)
[![Release](https://github.com/dsanchez31/cesium-sgp4-viewer/actions/workflows/release.yml/badge.svg)](https://github.com/dsanchez31/cesium-sgp4-viewer/actions/workflows/release.yml)
[![Pages](https://github.com/dsanchez31/cesium-sgp4-viewer/actions/workflows/pages.yml/badge.svg)](https://github.com/dsanchez31/cesium-sgp4-viewer/actions/workflows/pages.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Show a whole satellite catalog on a [CesiumJS](https://cesium.com/platform/cesiumjs/) globe, from a list of TLEs: every object at its SGP4 position, its orbit, its name, following the scene's clock. SGP4 runs in web workers, and orbits are drawn by custom vertex and fragment shaders straight from GPU buffers, which keeps tens of thousands of objects smooth.

**[Live demo](https://dsanchez31.github.io/cesium-sgp4-viewer/)**: a CelesTrak catalog snapshot (about 16,000 objects), in a [vanilla TypeScript](examples/vanilla) and a [React](examples/react) version. Also runnable in **[Sandcastle][sandcastle-demo]**, CesiumJS's online playground.

```ts
const { satellites } = parseTleCatalog(await (await fetch('/tle.txt')).text());
const layer = new SatelliteLayer(viewer, { satellites, orbits: true });
```

## Why

Plotting satellites from TLEs is a common need, and the straightforward way to do it in Cesium, one `Entity` with a `SampledPositionProperty` and a path per satellite, stops scaling after a few hundred objects: every entity is re-evaluated on every frame, every path re-sampled, and every label is one billboard per glyph. A public catalog has tens of thousands of objects.

This library is built for that size:

- **SGP4 runs in web workers.** The catalog is split across a small pool of workers (cores minus one, up to four). Each worker samples its satellites over a window of a few hours around the playhead and keeps its samples: when the window moves, only the new stretch is propagated.
- **The main thread only interpolates.** A degree-5 Lagrange polynomial over 36 samples per revolution (more for eccentric orbits) stays close to SGP4: the unit tests bound the error at 50 m, a highly eccentric orbit included.
- **All points are one custom primitive.** When the clock moves, the positions are written into one typed array and uploaded at once: one draw call for the whole catalog, in 3D, 2D, Columbus view and while the scene morphs.
- **All orbits are one custom primitive.** Rings are built once per hour of simulated time, uploaded to the GPU as they come out of the workers, and turned under the Earth by one matrix per frame. In 2D, the same buffers are drawn as ground tracks, computed in the vertex shader.
- **Filters are free.** Filtering by regime, name or anything else never propagates again: points are hidden, and the orbits' index buffer is rebuilt from per-satellite ranges.

## Features

- TLE parsing (2-line and 3-line sets, CelesTrak and Space-Track formats) with checksum validation and a report of rejected sets
- Orbit regime classification (LEO, MEO, GEO, HEO) and mean orbital elements
- Points coloured by regime, with configurable palette
- Orbits: rings in 3D, ground tracks in 2D
- Names on hover, or for every visible satellite
- Click selection, with the selected orbit highlighted and a marker on the satellite
- Filters by regime and by any predicate (name, NORAD ID…)
- Works with any clock: live, paused, accelerated, reversed, scrubbed
- Optional inertial camera: the Earth turns under a camera fixed in space
- Pure propagation helpers (`propagateToFixed`, `propagateTeme`) usable without Cesium

The examples add a custom timeline, transport controls, search, a regime legend and a details panel on top of the library.

## Installation

```sh
npm install @dsanchez31/cesium-sgp4-viewer cesium
```

`cesium` is a peer dependency: the library uses your application's copy. CesiumJS itself needs its static assets served at run time; follow the [CesiumJS quickstart](https://cesium.com/learn/cesiumjs-learn/cesiumjs-quickstart/) for your bundler, or look at [`examples/shared/viteConfig.ts`](examples/shared/viteConfig.ts) for a Vite setup.

A script build is published too, for pages that load Cesium from a `<script>` tag:

```html
<script src="https://cdn.jsdelivr.net/npm/cesium@1.145.0/Build/Cesium/Cesium.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@dsanchez31/cesium-sgp4-viewer/dist/cesium-sgp4-viewer.iife.js"></script>
<script>
  const { SatelliteLayer, parseTleCatalog } = CesiumSgp4Viewer;
</script>
```

## Usage

```ts
import { Viewer } from 'cesium';
import {
  enableInertialCamera,
  parseTleCatalog,
  SatelliteLayer,
} from '@dsanchez31/cesium-sgp4-viewer';

const viewer = new Viewer('globe');
viewer.clock.shouldAnimate = true;

const text = await (
  await fetch('https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle')
).text();
const { satellites, rejected } = parseTleCatalog(text);

const layer = new SatelliteLayer(viewer, { satellites, labels: 'hover' });
enableInertialCamera(viewer.scene);

// Filters
layer.setRegimes(['LEO', 'GEO']);
layer.setFilter((s) => s.name.includes('STARLINK') || s.noradId === '25544');

// Display
layer.orbits = true;
layer.labels = 'all';

// Selection
layer.on('select', (satellite) => console.log(satellite?.name, satellite?.elements));
layer.select('25544');

// Later
layer.destroy();
```

### `parseTleCatalog(text, options?)`

Parses a text of element sets. Never throws: returns `{ satellites, rejected }`, where each rejected entry has the line number of the set and the reason. Blank lines, CRLF line endings, padded names and the `0 ` prefix of the 3LE format are accepted.

| Option           | Default |                                                 |
| ---------------- | ------- | ----------------------------------------------- |
| `verifyChecksum` | `true`  | Reject lines whose column-69 checksum is wrong. |

Each `Satellite` has `noradId`, `name`, `line1`, `line2`, `satrec` (the [satellite.js](https://github.com/shashwatak/satellite-js) record), `elements` (epoch, inclination, RAAN, eccentricity, argument of perigee, mean anomaly, mean motion, period, semi-major axis, perigee and apogee altitudes, B*) and `regime`.

`parseTle(line1, line2, name?)` parses a single set and throws a `TleParseError` when it is invalid.

### `new SatelliteLayer(viewer, options)`

`viewer` is a Cesium `Viewer` (or anything with its `scene` and `clock`).

| Option               | Default                                  |                                                                                                       |
| -------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `satellites`         | required                                 | The catalog. Fixed for the layer's lifetime: create a new layer for a new catalog.                    |
| `orbits`             | `false`                                  | Draw every orbit.                                                                                     |
| `labels`             | `'hover'`                                | `'none'`, `'hover'` or `'all'`.                                                                       |
| `colors`             | see below                                | Colour per regime, as a Cesium `Color` or a CSS string.                                               |
| `orbitOpacity`       | `0.35`                                   | Opacity of the catalog's orbits.                                                                      |
| `pointSize`          | `3`                                      | Point diameter in pixels.                                                                             |
| `selectedOrbitColor` | `'#f8fafc'`                              |                                                                                                       |
| `selectionColor`     | `'#bef264'`                              | Ring around the selected satellite.                                                                   |
| `labelFont`          | `'12px sans-serif'`                      | CSS font shorthand.                                                                                   |
| `workers`            | cores − 1, at most 4                     | Size of the worker pool.                                                                              |
| `window`             | `{ halfWidthMs: 2 h, marginMs: 30 min }` | Span propagated around the playhead, and how close the playhead may come to its edge before it moves. |

Default colours are exported as `DEFAULT_REGIME_COLORS`.

| Member                         |                                                                                          |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| `orbits`                       | Get or set whether every orbit is drawn. The selected satellite's orbit is always drawn. |
| `labels`                       | Get or set the label mode.                                                               |
| `setRegimes(regimes \| null)`  | Show only these regimes.                                                                 |
| `setFilter(predicate \| null)` | Show only the satellites the predicate accepts. Combined with the regimes.               |
| `visibleCount`                 | Satellites passing the filters.                                                          |
| `select(noradId \| null)`      | Select a satellite. A click on a point does the same.                                    |
| `selected`                     | The selected `Satellite`, or `null`.                                                     |
| `find(noradId)`                | Look a satellite up.                                                                     |
| `positionOf(noradId, result?)` | Its Earth-fixed position as currently drawn, as a new `Cartesian3` or in `result`.       |
| `ready`                        | A promise settled by the first propagation. Rejects if `destroy()` comes first.          |
| `on(event, listener)`          | Subscribe; returns the unsubscribe function.                                             |
| `destroy()`                    | Remove everything from the scene and stop the workers.                                   |

| Event    | Payload                                                                                                                                                               |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `select` | The selected `Satellite`, or `null`.                                                                                                                                  |
| `update` | `{ propagated, failed, windowStart, windowStop }` after each propagation. `failed` counts satellites SGP4 could not propagate over the window, decayed orbits mostly. |
| `error`  | An `Error` from the workers. The layer retries after a few seconds.                                                                                                   |

### `enableInertialCamera(scene)`

Keeps the camera fixed in the inertial frame (ICRF) in 3D, so the Earth rotates as the clock runs and the orbits keep their shape on screen. It loads Cesium's Earth orientation data (`Assets/IAU2006_XYS`) on demand. Returns a function that restores the normal camera.

### Propagation helpers

Cesium-free, allocation-free when given an output object:

```ts
import {
  propagateToFixed,
  propagateTeme,
  gmstAt,
  temeToFixed,
} from '@dsanchez31/cesium-sgp4-viewer';

const position = propagateToFixed(satellite.satrec, new Date()); // metres, Earth-fixed, or null
```

The Earth-fixed position uses the classic SGP4 approximation: TEME rotated by the Greenwich mean sidereal time, ignoring polar motion and the equation of the equinoxes (tens of metres).

## Content Security Policy

The propagation workers ship inside the bundle and start from `blob:` URLs, so no worker file has to be served. A page with a Content Security Policy must allow them:

```
worker-src 'self' blob:
```

## CesiumJS compatibility

Developed against CesiumJS 1.145. The peer dependency accepts `>=1.140.0 <2.0.0`.

The orbit primitive draws through CesiumJS's renderer classes (`DrawCommand`, `VertexArray`, `ShaderProgram`, `RenderState`, `Buffer`). They are exported by the `cesium` package but are not part of its documented API, and are the price of drawing every orbit in a handful of draw calls. They have been stable for many releases. If a future release changes them, the layer turns the orbits off with a console warning; points, labels and selection only use the public API and keep working.

## Examples

```sh
pnpm install
pnpm examples:dev                   # vanilla TypeScript, http://localhost:5173
pnpm --filter example-react dev     # React
```

Both examples load [`examples/data/tle.txt`](examples/data/tle.txt) and provide 3D and 2D views, orbits, labels, day/night lighting, selection with a details panel, a regime filter, search by name or NORAD ID, a timeline you can drag and zoom, speed and direction controls, a live mode, and loading your own TLE file.

[`examples/sandcastle`](examples/sandcastle) runs the library in [Sandcastle](https://sandcastle.cesium.com), CesiumJS's online playground: **[open the demo][sandcastle-demo]**.

[sandcastle-demo]: https://sandcastle.cesium.com/#c=lVZ/b9s2EP0qh6CAKMylkrUYhjTqmrhu6835gTjtUDRFTVNniw1FaiTlxE393QeKkiO7SZH+EQc6Pr57d+Q9KUmAoxVV8dTOy+dPFwKv0YBQMGYq48w6ifRSJYn/gzNmHYLLhYWZkAhCOQ0uR/ibLdiYG1E6KJlCCXoGuXOl3U8Se0cUMlGui5oTLnIEKaaGmWVkYTh8M4BpJWQGBllmoV/DYWZ0UWcp2RwjC3Opp0zCJCxPemA1CFcTVhZtDV2gWYJQ1jHFsVMLMOm5lyA1yzCjl+pSca2sg9Hw6Pzw/OOXD4Pz8fD0BFKIduke3Y1ebCPen48ghUlbH88U/WozlGJhqEKXqLJIXmWWKZ7jt2d7yY/9ffXkdivdKsmEdfdAqRAzpF/tZC3jYjQIEi4VQPSginme/FxDwYRK8IYVpUSbZMyxxJ+Ru3G+5Dab71NzsikQa3gM6UufWeE1nBldCIuEGLRaLrAHBr8idx4Dtx4FEGhsS5FpXhWoHOUGmcOBRP9EogCI4hdhV3ik1nBIwRq+GdbKy4IUmrzbq2iMNl5vLSRoIl7wwC+QSV9XMgOlQ3nw5NYavprEbfK1xhxZRllZospIIA+QVdzpUDMyad2RcCfphzpGotD2vlaOCYUm6oWuMCUK5oRW++BMhT0fc6JAKRR2QlNmccSWaM4Ev0KzDzMmbViao+Y624wJNdNH+qYbsiiR+0RDlQnOnO5sqItoLhmXml+F37HDEtK2kH4bouOP44vB8Zf+6LT/z5fj96OL4dloODjf5igq6UQpRd2RP3a3l23uW39Y14+Q1rXWvSTMLhVvTiw06ZqJ7v0jnfkLxxD6fwslMxYvJPaZY1LPezBmDqUULnSvB6jYVOJQoXGCyT4r0DBYQQrXQmX6moZix/PyeTi4WlHL7/DGX9wgh4R/M3Q8J80kxjH1GLIpyrYabJ1pSyPxO7obpFfaXKJN+SQ0sLfB2QPJpijtPkS5XqCJwp2Ee0ttGKjlqDBuiksSGCMzPIfpEhQrELSBk9Pzw9cwfE3vhNkAenhyhSqrdnADmLpl6Q83Co9Rd6mUjGOuZVZXG51sJd7AsiwbLFC5kbAOlZ+nkKvXvSatzv8qb/lpu3fBZIXUGVGQmDo90tdo+swiaYe8bji16N4I6dCQEIWWJ00hitoYwF+gKinvnveB2FqDpUoblg0zah0zzv4rXE5qjhi+f/fLrMBNAVQoLqsMbYPrBdqOtXQsaI6u6fTRcpiRyGktp8xE8dqX6nrbU+28tVmWXej5XOJR5ZxWJDo1U+Fs1GscAAjPkV9h1u1l6IqukZBCg+gq285QyzlGVZFPgeK2nph9iA6lBINzUaBPqlUwo/3m8Nb9Pw8Q4hscw6q3xTIanD5m96ca+PkeguPHEhw/QPD2sQRvHyB491iCd12Cz7/a71HtCKAVBEv4MSUJOYN1+PELwHsk+7MLsMfQMCnvIznRv8ChtMLoMbW31/nZ67URdP2NFtqU+YV+9prs0j/jRxD9/nOi3++IPFUzIYpEoSC/d+3L3VESs42F29Y8vF1pidS/Be4MZfLkdg2uPWMFZCMUXGYV96AbDvO16sEEfrsjA5iUaITONrAYfMTSsHYsVOXQUqffiBvMyF68gkKoSa/laZ1ytZ7+VUxiypl/95H6G6uuty2ojjTx+MVOb+fAuqXE+mvxlShKbRxURhJKE4dFKZlDm0wrfoWOcmt9goOk3XKQiQWILL3c2fqGutwBLpm16eXOrJJyLL7h5c7LgyQTi41t/sNBqPnpAo1kSw/J916OQpBSepDke/fsauy1w/g/

## Data

The TLE snapshot in `examples/data` comes from [CelesTrak](https://celestrak.org), maintained by Dr. T.S. Kelso. For current data, use CelesTrak's [GP API](https://celestrak.org/NORAD/documentation/gp-data-formats.php), and please follow its usage guidance: download a group at most once per update cycle.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: see [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE). Propagation uses [satellite.js](https://github.com/shashwatak/satellite-js) (MIT).
