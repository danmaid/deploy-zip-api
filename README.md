# deploy-zip-api (Header-only pipeline summary) v1.8.4

## Fix: responsive without global scaling
Previously the SVG used a large minimum viewBox width, causing the whole drawing (including text) to shrink when the window became narrow.

v1.8.4 switches to **pixel-1:1 rendering**:
- The SVG `viewBox` matches the rendered pixel width.
- If the pipeline needs more width than available, the SVG expands horizontally and the pipeline area becomes scrollable (no scaling).
- `preserveAspectRatio` is set to `xMinYMin meet` (no distortion).

## Arrow cleanup
- `net -> tee` spacing tuned.
- `tee -> spool` rendered as a straight vertical drop.

## Spool usage visualization
- Removed direct `spool -> CD` line.
- When `spool_read` exists: `CD` drops vertically to a marker on the spool lane and the used segment on the lifetime line is highlighted.

## Total span semantics
`total` spans `network -> storage` because the server-side `total` measures the request handling end-to-end.
If you want *processing-only* total, add a new metric (e.g. `proc_total`) and draw a separate span.
