
# Changelog

## 2026-11-15 — Heavy cleanup (dissection: `spatial-signal-engine-dissection-2026-11-15.md`)

- Promoted `ARC_Spatial_Intelligence_RG_Fusion_v8_1_Fixed 5` to the canonical full app as `ARC_Spatial_Intelligence_RG_Fusion_v8_9/` (v8 + XYO visual upgrade + v8.9 local address tiling); deleted the plain v8 folder (strict subset, proven by diff).
- Deleted `ARC_v17_gps_fallback_map/` (byte-identical to Canonical v1's app); the v17 shell lives at `ARC_Spatial_Signal_Intelligence_Engine_Canonical_v1/app`.
- Deleted the three `legacy/v10_source/` copies (byte-identical to top-level `arc_serverless_v10_complete/`, which is kept intact as the offline worldmap add-on base).
- Deleted the dead `app/arc/*.js` ES modules in both surviving apps (loaded by nothing; the bundles are the runtime). Deleted the generic `yourname` template `docs/README.md` in both.
- Deleted the duplicate `repo_overview.png` / `repo_traffic.png` sets (kept one set).
- Fixed version drift: v8.9 package is now 8.9.0 (was 4.0.0); each package has a distinct npm name; v8.9 README title fixed (was "RG Fusion v6"); Canonical bundle boot log fixed (`ARC v16 ready` → `ARC v17 ready`).
- Added the `.gitignore` this file previously claimed existed. Corrected the record: no `.github/` workflows were ever added (the 2026-04-03 entry claimed they were).
- Known gaps left open (see the dissection doc §8): no v5 ever existed; the bundles are hand-maintained with no build step; v10's triangulation is a centroid average and its room inference is an `alert()` stub; nothing in the repo is fully offline (all map surfaces fetch remote tiles).

## 2026-04-03 — Repo public-facing hardening pass

- rewrote root README to reflect the actual prototype package state
- added clearer canonical entry points and quick-start routes
- added ecosystem stack documentation and SEO notes
- added root package.json
- aligned public positioning around prototype + research honesty

All notable changes to this project will be documented in this file.

## v0.1.0 - 2026-04-03

### Added
- Rewrote the README to clearly position the repository as a research / architecture foundation.
- Added MIT license.
- Added contributing, security, and code of conduct files.
- Added initial architecture, roadmap, and math-model docs.

### Changed
- Reframed the project to honestly distinguish current documentation status from future implementation goals.