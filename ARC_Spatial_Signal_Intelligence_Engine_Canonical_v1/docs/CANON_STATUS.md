# Canon Status

## Canonical layout (2026-11-15 cleanup)

This repo has two runtimes and one legacy package — not one canonical runtime:

- **Full app (canonical): `ARC_Spatial_Intelligence_RG_Fusion_v8_9/`** — the RG Fusion app: inference core (v6), ops backend (v7), service architecture layer (v8), XYO visual upgrade, and v8.9 local address tiling. This is the fullest build in the repo and the one to develop against.
- **Light shell (this package): `ARC_Spatial_Signal_Intelligence_Engine_Canonical_v1/app`** — the v17 GPS fallback map shell (structure-locked, OSM tiles, no v6/v7/v8 features). The old `ARC_v17_gps_fallback_map/` folder was a byte-identical duplicate and was removed; the v17 shell lives here.
- **Legacy + add-on base: `arc_serverless_v10_complete/`** — the small v10 Leaflet package, kept intact (it is the base for the offline worldmap Lucid add-on). Its triangulation is a centroid average and its room inference is an `alert()` stub — see the dissection doc.

## Removed in the cleanup
- `legacy/v10_source/` copies (three, all byte-identical to top-level v10) — deleted.
- `ARC_v17_gps_fallback_map/` — deleted (duplicate of Canonical's app).
- The plain `ARC_Spatial_Intelligence_RG_Fusion_v8_1_Fixed/` folder — deleted (strict subset of v8.9).

## Canonical standard for this package
- one launch surface per package (`app/index.html`)
- one top-level README per package
- one package identity (distinct npm name + version per package)
- docs for architecture, roadmap, and GitHub setup

## Not yet canonically solved
- modular source rebuild pipeline (the bundles are hand-maintained; the old ES modules were dead and removed)
- unit/integration tests
- formal real-world validation
- session persistence and exports
- fully offline operation (all map surfaces still fetch remote tiles)
