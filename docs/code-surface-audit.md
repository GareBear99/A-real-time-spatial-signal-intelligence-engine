# Code Surface Audit

Audit snapshot — updated 2026-11-15 after the heavy cleanup (see `spatial-signal-engine-dissection-2026-11-15.md` in the workspace, and the root CHANGELOG entry for 2026-11-15).

## High-level findings

- Two prototype packages are present, not five: the RG Fusion v8.9 full app and the Canonical v1 light shell (the v17 shell), plus the v10 legacy package.
- The duplicate / alternate exported package states are gone (plain v8, the v17 folder, the three `legacy/v10_source/` copies, the duplicate PNG sets, and the dead ES modules were deleted in the cleanup).
- The strongest public-facing package for development is `ARC_Spatial_Intelligence_RG_Fusion_v8_9/` (the fullest build). The best first stop for visitors is still `ARC_Spatial_Signal_Intelligence_Engine_Canonical_v1/` (the light shell).

## Counts (post-cleanup, verified by `find`/`grep`)

- Total files in repository: **57** (was 166 before the cleanup — 110 files were byte-identical duplicates or dead code — plus a new `.gitignore`)
- JavaScript files: **12** (was 91)
- JavaScript function definitions: **211** (was 565)
- JavaScript classes: **1** (`class Bus`, in the v10 package)

## Main surfaced package variants

- `ARC_Spatial_Intelligence_RG_Fusion_v8_9/` — full app (v6 inference + v7 ops + v8 service layer + XYO visuals + v8.9 local address tiling)
- `ARC_Spatial_Signal_Intelligence_Engine_Canonical_v1/` — light shell (the v17 GPS fallback map)
- `arc_serverless_v10_complete/` — legacy v10 Leaflet package, kept intact as the offline worldmap Lucid add-on base

## Public repo risks found (and their state after the cleanup)

1. **Trust mismatch** — root docs previously implied a documentation-first state; the repo actually includes browser-first prototype implementations. (Addressed: the root README now describes the two runtimes honestly.)
2. **Package duplication** — multiple overlapping build exports confused first-time visitors. (Fixed in the 2026-11-15 cleanup.)
3. **No single canonical root launcher** — visitors had to infer which package to run first. (Improved: the root README names the full app and the light shell with their roles; the root `package.json` has `serve:rg` and `serve:canonical`.)
4. **Root package metadata gap** — there was no root `package.json` or `.gitignore` to make the repo feel complete. (Fixed: both exist now; each package also has a distinct npm name and version.)

## Remaining cleanup (not done)

1. Split the bundled JS surfaces into auditable source modules with a real build step (the bundles are hand-maintained; the old ES modules were dead and removed).
2. Add deterministic scenario fixtures for repeatable simulations.
3. Add screenshots / GIFs for the canonical runtime.
4. Add smoke tests or lightweight validation checks for geometry / estimator logic.
5. Make a map surface genuinely offline (all current surfaces fetch remote tiles at runtime).
