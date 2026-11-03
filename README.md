# StreamLine

A Plasticity-style 3D modeller in the browser, built for iPhone and iPad first, with CAD precision.

**One 3D studio, no modes to manage:**
- **Draw anywhere.** Pick Line, Rect, Circle, Arc, Spline or Polygon from the tool rail on the left, then draw on the grid, or press on any face of a body to draw on that face. Curves on the same plane share a sketch automatically, so their closed shapes become **regions**.
- **Select like Plasticity.** The top bar switches between **Edge** (curves and edges, key `2`), **Face** (regions and faces, `3`) and **Solid** (bodies, `4`).
- **The command bar follows the selection.**
  - Regions: Extrude, Revolve, Loft, Sweep.
  - Faces: Push/Pull, Shell, Draft, Mirror, Slice.
  - Edges: Fillet, Chamfer.
  - Curves: Move, Offset, Constrain, and so on.
  - Solids: Boolean, Mirror, Shell, Pattern, Thicken.
- **Command palette.** Press `Space` or tap 🔍 to search every command, for example "fil" for Fillet.
- **Keys:** `G`/`R`/`S` move, rotate and scale (on faces and edges too), `E` extrude, `F` fillet, `⇧C` chamfer, `O` push/pull, `H` shell, `M` mirror, `L` line, `C` circle, `⇧R` rectangle, `X` delete.
- Every operation opens a compact dialog with exact values and a live drag handle. The AutoCAD command line (typed coordinates, DIST, etc.) is optional; switch it on from the palette.

**No build step, no dependencies to install.** Serve the folder with any static server:

```sh
python3 -m http.server 8000   # then open http://<your-ip>:8000 on your phone
```

On iPhone, open the page in Safari, then Share → **Add to Home Screen**. It then runs full-screen and works offline through a service worker. Hosting it on GitHub Pages works as-is.

## Precision model
- Geometry is stored in **millimetres as float64**. Only the GPU copy is float32.
- Every operation has typed parameters. After you drag, the **Adjust Last Operation** card lets you replace the value with an exact one, and the operation is re-run from its original state.
- Values are entered on a built-in **calculator keypad** (the iOS decimal pad has no minus key). It accepts expressions and units: `3/8 in`, `25.4*2`, `10mm + 1in`, `2*pi*5`, `45deg`, `0.5 rad`.
- Snapping: increment or absolute grid, angle steps, and vertex snapping. Constrained axis moves project the snap target onto the axis.
- Exact numeric panels: object location, rotation, scale and dimensions; the median of the selection in global coordinates; and the length between two vertices (the last-selected vertex moves).
- Rotations by multiples of 90° use exact matrices (no 6e-17 drift).
- The Measure tool snaps to vertices, surfaces and the grid, and shows ΔX, ΔY and ΔZ. Edit mode shows the lengths of selected edges.
- Statistics: surface area, volume and a watertight check.

## Layout
- The Draw / CAD / Model switcher, undo/redo and properties sit in the top bar. Under it is the **station bar** with the actions for the current workspace: Constrain, Modify commands, Extrude, Fillet and so on.
- **Tools** are in a vertical rail on the left of the viewport. View controls (the axis navigator and the persp/frame/snap/x-ray buttons) are bottom-right. The AutoCAD command line runs along the bottom in Draw and CAD.

## Parametric timeline, layers and visibility

Every shape starts from a sketch: drawing tools create sketches, and **Add solid** builds a profile sketch plus an Extrude or Revolve rather than a loose mesh.
Each sketch and feature is a step on the **timeline** strip along the bottom, stamped with the time it was made:

- **Edit a sketch** (tap its chip → Edit sketch, or tap it in the Browser). Every feature after it rebuilds: widen a rectangle and its extrude, the fillets on it and so on follow.
- **Edit parameters** of any earlier feature (distance, angle, radius…) in the floating dialog. Later steps replay on top.
- **Roll back** to just before or just after a step. The orange marker shows where you are, and steps after it are greyed out and ignored. New work is inserted at the marker; **To end** rolls forward again.
- **Suppress** or **delete** a step. A step that can no longer be rebuilt turns red and explains why.

Sketches are hidden automatically once features have used all their closed shapes. The **Browser** (sliders button → Browser) lists layers, sketches and bodies, each with an eye toggle.
Tap a layer to make it active (new sketches and bodies go there), rename it or delete it. Use a row's layer tag to move a sketch or body to another layer.
The pill in the top-right corner of the view shows the active layer (and how many are hidden); tap it to open the Layers panel.
**Extrude** and **Push/Pull** start at 0: drag the arrow (snapping gets finer as you zoom in) or type the distance.
Visibility, names, colours and layers are not history steps, so they survive rebuilds and never break them.

## Sketching on faces
Use **On face** (Draw or CAD) or **Sketch on face** (Model), then tap a flat face. The new sketch:
- **projects the face's boundary**, outer edge and holes included, as purple reference geometry, the way Fusion does. Round holes come in as exact circles, and straight runs as single lines.
- lets you snap to that geometry, dimension against it, and use it in profiles.
- frames the camera straight onto the face and starts the Line tool.

An extrude from a face sketch targets that body automatically (Join, or Cut into the face).

## AutoCAD-style drafting (Draw and CAD)
- **Command line** (bottom of the viewport): type anywhere on a keyboard, or tap the field on a phone. **Enter** or **Space** runs the command, an empty Enter repeats the last one, and **Esc** cancels. The prompts use AutoCAD's wording and offer clickable options such as `[Close] [Undo]`.
- **Commands and aliases:** `L` LINE, `REC` RECTANG, `C` CIRCLE, `A` ARC, `POL` POLYGON, `TR` TRIM, `EX` EXTEND, `O` OFFSET, `F` FILLET, `CHA` CHAMFER, `M` MOVE, `CO` COPY, `RO` ROTATE, `SC` SCALE, `MI` MIRROR, `E` ERASE, `X` EXPLODE, `DIM`, `GCHORIZONTAL`/`GCVERTICAL`/`GCPARALLEL`/`GCPERPENDICULAR`/`GCEQUAL`/`GCTANGENT`/`GCCONCENTRIC`/`GCFIX`, `U`/`REDO`, `Z` (zoom extents) and `DXFOUT`. The 3D commands are `EXT` EXTRUDE, `REV` REVOLVE, `UNI` UNION, `SU` SUBTRACT, `IN` INTERSECT, `FILLETEDGE`, `CHAMFEREDGE` and `PRESSPULL`.
- **Coordinate entry:** absolute `x,y`, relative `@dx,dy`, polar `@length<angle`, or a bare number as a direct distance along the rubber band. Every value accepts units and arithmetic (`@3/8in<45`).
- **Inquiry:** `DI`/DIST (distance, ΔX, ΔY and angle), `ID` (point coordinates), `LI`/LIST (entity properties), `AA`/AREA (by points, or Object for an exact circle or rectangle or a region with its holes removed), and `MEA`/MEASUREGEOM for distance, radius (`MR`), angle (`MA`) and area (`MAR`). Results are printed AutoCAD-style in a command history you can tap to expand, and the last measurement stays drawn.
- **Dimensions:** `DLI` DIMLINEAR (horizontal or vertical), `DAL` DIMALIGNED, plus angular, radius and diameter dimensions. All of them drive the geometry.
- **More drafting:** `T`/`DT` TEXT (height and free text, spaces allowed), `H` HATCH (associative: ANSI31, ANSI37, NET or SOLID, with editable scale and angle, following its boundary), `EL` ELLIPSE, `SPL` SPLINE (fit points, Close), PLINE arc segments (`A` / `L` options, tangent to the previous segment), `XL` construction lines, and the `CONS` toggle. Construction geometry is drawn dashed and never forms a profile. `AR` ARRAYRECT and ARRAYPOLAR have editable rows, columns, spacing, count and angle.
- **Status bar:** GRID, SNAP, ORTHO, POLAR and OSNAP, also on F7, F9, F8, F10 and F3.
- **Visuals:** OSNAP markers with names (□ Endpoint, △ Midpoint, ○ Center, ✕ Intersection, ◇ Quadrant), polar tracking rays, a crosshair with pickbox, blue grips and dashed selection, all on the dark model-space background.

## Plasticity-style modelling (Model)
- **Selection modes:** **Solid / Face / Edge** (keys `4` `3` `2`), plus **Mesh** for polygon editing. Face mode selects a whole planar face, not individual triangles.
- **Modifiers:** each runs from the selection, opens a compact floating dialog with exact values, and has a **live drag handle** in the viewport.
  - **Fillet** (`F`) and **Chamfer** (`C`) on straight edges and on **round edges**: tapping the rim of a hole or boss selects the whole circle, so a chamfered hole rim gives a countersink. Where three filleted edges meet at right angles, the corner is rounded into a true spherical patch.
  - **Push/Pull** (`O`): move a face along its normal, adding or removing material.
  - **Shell** (`H`): hollow the body, with the selected faces left open. The wall offsets are solved exactly from the face planes.
  - **Mirror** (`M`): across YZ, XZ, XY or a selected face, optionally fused with the original.
  - **Boolean:** union, subtract or intersect.
  - **Slice** (`SL`): cut by a plane through the body, a world plane or a selected face. Both halves are kept.
  - **Pattern** (`3A`): a polar pattern of bodies around X, Y or Z.
  - **Thicken:** turn a surface, such as an added Plane, into a solid.
  - **Draft:** tilt the selected side faces by an exact angle about a neutral plane, along +X, +Y or +Z. The geometry is re-solved from the face planes, so the edges stay exact.
- **Direct modelling:** in Face or Edge mode, the Move/Rotate/Scale gizmo drags the selected faces or edges, and the neighbouring faces stretch to follow.
- **Revolve** can use any line in the sketch as its axis, including construction lines.
- **Loft** (`LOFT`): a solid through two or more profiles, resampled and aligned automatically. **Sweep** (`SWEEP`): a profile, holes included, along an open path (lines, arcs or a spline) in another sketch. Corners are mitred so the section stays exact. Both can create a new body or Join, Cut or Intersect with an existing one.

## Fillet, chamfer and constraints
- **Sketch fillet and chamfer** (Draw → Fillet tool, `F` / `CHA`): tap a corner where two lines meet, where a line meets an arc, or where two arcs meet. Rectangles are split into lines automatically. A fillet arc comes with tangent constraints.
- **Edge fillet and chamfer** (CAD → Edge tool, then Fillet or Chamfer): works on straight edges between flat faces. Convex edges have material removed and concave edges have it added. A chamfer can use one distance or two (with a swap option). Several edges can be done in one operation, and the result stays editable.
- **Constraint solver**: Horizontal, Vertical, Parallel, Perpendicular, Equal, Tangent, Concentric and Fix. Dimensions drive the geometry: point-to-point, line length, angle between lines, radius and diameter. Touching points stay joined, and the sketch origin is fixed.
  - The solver uses minimum-norm Gauss-Newton, so each edit moves the geometry as little as possible, to about 1e-12 mm.
  - Values you type are held exactly. When you drag to a position the constraints forbid, the point lands on the closest valid position.
  - The HUD shows the remaining degrees of freedom. Fully-constrained geometry turns white and free geometry stays blue.
  - Tap a constraint glyph to remove it.

## Tests
```sh
npm install          # three (dev) + playwright (optional, for e2e)
npm test             # geometry core: sketch, CSG, extrude/revolve, fillet/chamfer, constraint solver
npm run test:e2e     # drives the real UI in an emulated iPhone: Draw → CAD → Model with fillet/chamfer/constraints
```

## Pipeline details
- Sketch geometry is analytic: circles and arcs are exact, and intersections are solved in closed form (line–line, line–circle, circle–circle). Quarter-turn angles produce exact coordinates.
- Region detection builds a full planar arrangement, so overlapping shapes, split regions and nested holes all work.
- Dimensions drive the geometry: set a linear dimension and its point moves, together with every point coincident with it. Radius and diameter dimensions resize circles and arcs.
- Every feature (extrude distance and operation, revolve axis, angle and segments, boolean kind) stays editable in the redo card until the next operation.
- Curves are faceted only when a solid is built. The number of segments per circle is a setting.

## Features
- Primitives with parametric sizes: cube, plane, cylinder, cone, UV sphere, torus.
- Object mode: move, rotate and scale gizmo; duplicate; array; join; apply transform; set origin (bounds, bottom or world).
- Edit mode (vertex, edge and face select): region extrude, inset with an exact edge offset, subdivide with N cuts, merge, fill, flip and recalculate normals, merge by distance, delete.
- Perspective and orthographic views. Tapping an axis bubble switches to an exact Top, Front or Right orthographic view.
- Unlimited undo (up to 80 steps) and autosave to the device.
- File formats: project `.json`, STL export (binary, mm), OBJ export and import (Y-up on disk), STL import (welded). On iOS, exports open the Share sheet so you can save to Files.

## Gestures
| Gesture | Action |
|---|---|
| 1-finger drag | orbit (turntable, Z-up) |
| 2-finger drag / pinch | pan / zoom toward fingers |
| tap | select (turn on multi-select, left buttons, to add or remove) |
| 2-finger tap / 3-finger tap | undo / redo |

Keyboard (iPad or desktop): `Tab` `1 2 3` `G R S` `E I F X A` `⌘Z` `⇧⌘Z` `N` `.` and numpad views.

## Layout
`js/cmdline.js` AutoCAD command line · `js/modifiers.js` push/pull, shell, mirror · `js/sweep.js` loft and sweep · `js/sketch.js` 2D sketch geometry, snapping, regions, trim, DXF · `js/draw.js` Draw workspace · `js/features.js` extrude, revolve, booleans · `js/csg.js` double-precision BSP CSG and mesh clean-up · `js/mesh.js` polygon mesh and modelling ops · `js/operators.js` operator definitions · `js/ops.js` redo panel and undo · `js/viewport.js` renderer, camera, picking, gestures · `js/gizmo.js` transform handles · `js/units.js` units and expression parser · `js/ui.js` keypad and widgets · `js/io.js` STL/OBJ · `vendor/` three.js r170 (MIT).
