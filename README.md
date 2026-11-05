# StreamLine

A Plasticity-style 3D modeller in the browser, built for iPhone and iPad first, with CAD precision.

**Sketches and parts, the Fusion 360 way:**
- **Create Sketch** (Solid → Sketch, or `K`) asks for a plane: tap one of the origin planes (XY, XZ, YZ — their names are tappable too), a construction plane, or a flat face of a body. The sketch opens in **sketch mode**.
- **Sketch mode** has its own tool sets — Create (Line, Rect, Circle, Arc, Spline, Polygon, Text, Ellipse, Dimension), Modify, Constrain and Inspect — and a sketch bar along the top with **Finish Sketch**.
- **Finish Sketch** goes back to the part. Line, Arc and the other drawing tools only exist inside a sketch; outside one a sketch's curves can be picked but not changed (**Edit sketch** reopens it).
- **Back in the part**, tap a closed profile and drag its arrow, or tap **Extrude** / **Revolve** / **Sweep**. Extrude picked inside an open sketch finishes the sketch first, as in Fusion.
- **The command bar follows the selection.**
  - Profiles: Extrude, Revolve, Loft, Sweep.
  - Faces: Push/Pull, Shell, Draft, Mirror, Slice.
  - Edges: Fillet, Chamfer.
  - Curves: Move, Offset, Constrain, and so on.
  - Solids: Boolean, Mirror, Shell, Pattern, Thicken.
- **Command palette.** Press `Space` or tap 🔍 to search every command, for example "fil" for Fillet.
- **Keys:** `K` create sketch, `G`/`R`/`S` move, rotate and scale (on faces and edges too), `E` extrude, `F` fillet, `⇧C` chamfer, `O` push/pull, `H` shell, `M` mirror, `L` line, `C` circle, `⇧R` rectangle (outside a sketch these ask for its plane first), `X` delete.
- Every operation opens a compact dialog with exact values and a live drag handle. The AutoCAD command line (typed coordinates, DIST, etc.) is optional; switch it on from the palette.

**No build step, no dependencies to install.** Serve the folder with any static server:

```sh
python3 -m http.server 8000   # then open http://<your-ip>:8000 on your phone
```

On iPhone, open the page in Safari, then Share → **Add to Home Screen**. It then runs full-screen and works offline through a service worker. Hosting it on GitHub Pages works as-is.

## Precision model
- Geometry is stored in **millimetres as float64**. Only the GPU copy is float32.
- Every operation has typed parameters. After you drag, the **Adjust Last Operation** card lets you replace the value with an exact one, and the operation is re-run from its original state.
- Values are entered on a built-in **calculator keypad** (the iOS decimal pad has no minus key). It accepts expressions and units: `3/8 in`, `25.4*2`, `10mm + 1in`, `2*pi*5`, `45deg`, `0.5 rad`. On a fresh value **−** starts a negative number; **+ × ÷** go on from the value shown (`12 + 5`).
- Snapping: increment or absolute grid, angle steps, and vertex snapping. Constrained axis moves project the snap target onto the axis.
- Exact numeric panels: object location, rotation, scale and dimensions; the median of the selection in global coordinates; and the length between two vertices (the last-selected vertex moves).
- Rotations by multiples of 90° use exact matrices (no 6e-17 drift).
- The Measure tool snaps to vertices, surfaces and the grid, and shows ΔX, ΔY and ΔZ. Edit mode shows the lengths of selected edges.
- Statistics: surface area, volume and a watertight check.

## Exact geometry (B-rep kernel)
Solids are exact boundary representations computed by **OpenCascade** (the kernel behind FreeCAD), compiled to WebAssembly and used through **replicad**.
- **True surfaces:** planes, cylinders, cones, spheres and tori, with rolling-ball fillets and true chamfers. Volumes and measurements are exact (a Ø10 hole is exactly 25π mm² in plan), and edges and corners are perfect at any zoom.
- **Sketch regions:** the sketch curves split the sketch plane exactly, so arcs and circles stay arcs and circles in the solid.
- **Selection:** a tap picks whole faces, including curved ones, or true edges. Cylinder seams are hidden.
- **Files:** STEP export (menu → Export STEP) and STEP import (Open… a .step/.stp) carry the exact geometry to other CAD apps. An imported assembly comes in as one body per part, with the file's part names and colours. STL/OBJ export uses a fine tessellation.
- **Autosave** stores only the history and sketches; solids are rebuilt from it on load. Saved projects (.streamline.json) include the exact solids.
- **Mesh editing:** imported STL/OBJ files stay triangle meshes and keep vertex editing ("Edit mesh"). Solids are changed with features instead.
- The kernel (about 7 MB compressed) loads once and is then cached for offline use. Licences: OpenCascade LGPL-2.1 and replicad MIT, both in `vendor/occ/`.

## Fasteners: threads, holes, recesses
- **Thread:** tap a shaft or a round hole, then tap **Thread**. It cuts a true helical ISO thread (60°), exact geometry that exports to STEP. The ISO coarse pitch is suggested from the diameter (M8 gets 1.25). Pitch, length, the end it starts from and left-hand are all editable. A hole gets an internal thread; a hole drilled at the ISO tap-drill size (Ø6.8 for M8) is threaded as that nominal size (the thread zone opens to the major diameter). Threads find their cylinder again by its axis when an earlier hole or shaft changes size.
- **Hole:** tap a flat face, then **Hole**. Choose simple, counterbore or countersink; the depth is a set value, or 0 for through — through just the wall it starts in (a port in a box side) or through everything. The centre snaps to the grid and can be typed. **Pattern** turns one hole into a row, a grid or a bolt circle in a single step, which you can still edit from the timeline. On a round face (a flange, a ring) a bolt circle goes round the face's centre, its radius taken from where you tapped.
- **Recess:** tap a screw head's flat top, then **Recess**. Choose a slot, a cross (Phillips-style), a hex socket or a square drive. Set the size, depth and rotation; sockets get a 118° drill-point cone at the bottom. Recesses can be patterned like holes. A tap near the middle of a face (a screw head, a nut) centres the hole or recess exactly; both follow their face when an earlier step moves it.
- **Polygon:** tap or type its centre, size it **across flats** (13 mm for an M8 nut and head) or to a corner, and set its rotation.
- **Array:** the default spacing comes from the selection's width.

## Drawing planes
- The **Plane** button picks Top / Front / Right, **Offset this plane…** by a typed distance (a sketch 70 mm up for a loft; units and expressions work — an offset plane is named by where it sits: "XZ · Y 40" is the plane y = 40), or **Tilt this plane…** by a typed angle about its X direction (a 15° phone slot).
- Select a face and tap **Plane here**: the drawing plane goes through the tapped point, touching the face — on a curved wall it is the tangent plane, so a spout or handle can be sketched where it attaches. Typed coordinates on it are the model's own (its origin sits where the plane passes nearest the world origin) — except that a face you look at from below or behind has one axis running against the model's; the toast says which (on a bottom face, the sketch's Y is the model's −Y). Hole patterns always run their rows toward the model's +Y (+Z on a wall), on any face.

## Projects and assemblies
- Every project saves on this device automatically (IndexedDB) and stays there offline. Open **Menu → Projects & assemblies** to open, rename, duplicate or delete projects, or to start a new one.
- **Insert into this project** places another project's solids as a linked component (🔗). Move or rotate it, and measure, sketch on or snap to its faces like any body. Its shape is read-only here. Each of its parts shows in its own colour, as in its project.
- When the source project changes, the component shows **Sync ●**. Select it and tap **Sync** to bring in the latest version; its placement is kept and later steps rebuild. **Open source** jumps to the project it came from. A part is only marked out of date when its solids really changed.
- **Mate:** tap a face on the part to move, tap **Mate**, then tap a face on the part it goes against. If the faces or axes are not parallel, the part is first turned to line them up. Flat faces become coplanar (face to face); round faces (cylinders, cones, or threads via their nearest round edge) become coaxial (a pin drops onto its hole's axis). It is a History step (“Mate Pin → Block”) and a live constraint: it is solved again after every edit and rebuild, so mated parts follow when the part they sit on moves, when an earlier step changes it, or after a Sync. A round mate still lets the part slide along its axis. Rotating a part on a round mate turns it about that axis (a hinge); the Rotate card's Axis also offers **Mate axis**, an exact turn about a tilted shaft or hinge. Tapping the flat face right beside a hole's rim counts as the hole's axis, so small bores are easy to mate. A mate that would make a loop (a part mated onto one that is already mated onto it) is refused — mate them the other way round. Mates that can't all hold at once: the earlier ones win, and the newer one is flagged in red on its step and does not move the part. Mate steps say their kind: “(axis)”, “(flat, gap 0.5 mm)”, “(flush)”. A flat mate is **Face to face** (the part is turned round if both faces point the same way) or **Flush** (tops level; the default when both faces point the same way on a part that is already mated). When both taps are on flat faces right beside hole rims, the card's **Mate by** switches between the flat faces and the hole axes. **Hole axes** is a pin through both holes: the axes line up and the tapped faces stay seated face to face, with the Gap between them. A flat mate also has a **Gap** (0.5 mm of drawer clearance, or − to overlap). Dragging a part along a direction a mate holds tells you so instead of silently snapping back.
- **Text → Outline:** select a text and tap **Outline**: the letters become closed curves (Liberation Sans Bold, SIL OFL) with their filled areas selected — Extrude them to emboss, or into the body to engrave (In the open sketch the letters' many short lines show no end points, so the text stays readable.)
- A sketch on a part's face (tapped, or on **Plane here**) belongs to that part: Extrude joins by default, a hand-picked **Cut** goes into the body whichever sign you type, and the sketch moves and turns with the part when an earlier Move / Rotate / Mate changes. On a linked (read-only) part, Extrude makes a new body.
- **Check interference** (Menu, or the **Interference** button with two or more bodies selected) reports the exact overlap volume of every pair of parts that collide, and selects them. Only solids whose boxes overlap are intersected, and a big assembly shows its progress instead of freezing the app. **Isolate** shows only the selected bodies until **Show all**.
- **Measuring parts:** Inquiry DIST and ID use the 3D point on a body (snapped to its exact corners, edge midpoints and circle centres); Radius works on round body edges such as hole rims.
- STEP export writes an assembly: one named, coloured part per body.

## Layout
A mix of Fusion 360 and Plasticity. The 3D view fills the whole screen and every control floats over it.
- **Top bar:** the menu and undo/redo on the left; **Look**, **History list** and **Settings** on the right.
- **History timeline:** always shown along the top. It works like Fusion's timeline.
  - The buttons at its left roll back to the start, step back, step forward and roll to the end.
  - Tap a step to edit it, roll back to it, suppress it or delete it.
  - The History list button opens the same steps as cards in a panel. That panel also has tabs for **Info** (properties of the selection) and **Settings**.
  - The History button shows an orange dot while you are rolled back and a red dot if a step failed.
- **Bottom bar:** the **Browser** button, then the **tool sets**, then command search. Tapping a tool set fills the **left rail** with its tools.
  - In the part: **Solid** (Sketch, Extrude, Revolve, Loft, Sweep, the primitives, Hole, Thread, Pattern, Mirror, Thicken), **Modify**, **Assemble**, **Construct** and **Inspect**.
  - In a sketch: **Create**, **Modify** (Fillet, Trim, Extend, Offset, Mirror, Move, Copy, Rotate, Scale, Pattern, Construction, Delete), **Constrain** (Horizontal, Vertical, Parallel, Perpendicular, Equal, Tangent, Concentric, Fix, Dimension) and **Inspect**.
- **Sketch bar:** while a sketch is open it takes the timeline's place: the sketch's name and plane, and **Finish Sketch** at its right end.
- **Above the bottom bar:** the commands for what is selected (Plasticity-style). Fillet and Chamfer appear for edges; Push/Pull, Shell, Hole and Mate for faces. The row is hidden when nothing is selected.
- **Browser:** opens from the bottom bar as a tree, like Fusion's browser. On a phone it sits beside the tool rail and covers only the lower part of the view, so it can stay open while you work; tap its title bar for full height. Its folders are:
  - **Origin:** the XY, XZ and YZ planes. Tap one to start a sketch on it; the eye shows them in the view.
  - **Bodies:** each with an eye, its colour and a ⋯ menu for rename, colour, isolate, layer and delete.
  - **Components:** inserted parts, with Sync and Open.
  - **Sketches:** tap one to edit it.
  - **Joints:** the mates. Tap one to edit its gap or flush setting.
  - **Layers.**
- **Right edge:** the zoom bar, with **Snap** and **X-ray** under it.
- **Bottom right:** the orientation cube, with **Home**, **Frame** and **Perspective / Orthographic** in a slim column beside it. Nothing floats over the middle of the model.
- **Look** (top bar) opens compact, and the model moves down under it so a theme or a light can be judged on the part.
- **Inspect** results (Distance, Angle, Area, Radius, Point) stay in the HUD until the next tap or tool.

### Touch controls
- **Tap** picks what is under your finger: a face, an edge, a sketch curve or region, a dimension, or a constraint glyph. A picked constraint shows the curves it ties, and **Delete** removes it.
- **Precision cursor:** hold a finger on the view, or drag it, to bring up a cursor 72 px above the finger with a **magnifier** over it.
  - The magnifier says what is under the cursor, for example "Edge · rim · 18.85 mm", and lights it up.
  - Letting go picks it. This makes 1 mm edges and small hole rims easy to hit.
- **Rotating the view:** one finger never moves the view. Turn it with the **orientation cube** at the bottom right (Fusion's ViewCube):
  - Drag the cube to turn the view.
  - Tap a face for its flat view, or an edge or corner for a 3D view.
  - **Home** (beside the cube) goes back to the 3D view of everything; **Frame** fits the selection, or everything.
- **Zooming:** use the **zoom bar** on the right side.
  - Push its handle up to zoom in, or down to zoom out. The further you push, the faster it zooms, and the handle springs back to the middle.
  - **+** and **−** zoom by steps.
- **Two fingers** still pan and pinch.
- **Gizmos on what you pick** (Plasticity):
  - **A body** gets move arrows, plane squares, rotation arcs and a free-move centre. Drag one to move or turn the body; Snap applies.
  - **A flat face** gets a push / pull arrow.
  - **A sketch profile** gets an extrude arrow.
  - **Edges** get a fillet ball; drag it to round them.
  - A tap on a gizmo that doesn't drag it is an ordinary tap, so nothing is added to the history.
- **Number typing** (Plasticity):
  - An operation's handle shows its value in a bubble beside the arrow; tap it to type an exact value.
  - With a keyboard, just type: digits go to the handle's value, or after a gizmo move or turn, to the distance or angle just dragged.

### Sketch mode (Fusion-style)
- **Create Sketch** shows the three origin planes, named, around the origin; tap a plane, its name, a flat face of a body, or one of the plane buttons above the bottom bar (XY · Top, XZ · Front, YZ · Right, and the construction plane if you made one). **Cancel** or `Esc` stops.
- The view turns to look straight at the new sketch, and the Create tools fill the rail. The HUD counts curves and profiles and says how many degrees of freedom are left.
- Dimensions, constraint glyphs and the little square points on curve ends show only while the sketch is open.
- After a line's first segment, its card switches the next one between **Line** and **Tangent arc** (a slot, a hook, a rounded profile in one chain).
- **Finish Sketch** returns to the part and the view you had. Undoing the sketch's creation, or deleting it, finishes it too.
- Reopen a sketch from the timeline, the Browser's Sketches folder, or **Edit sketch** on one of its picked curves.
- On the AutoCAD command line a drawing command (`L`, `C`, `REC` …) typed outside a sketch opens one on the current construction plane, so typed coordinates keep working.

### Sketches on faces (Fusion-style)
- **Curve colours:**
  - Blue while a curve is free to move; white (black on the Daylight theme) once it is fully constrained.
  - Construction lines are dashed orange; projected geometry is purple.
  - A picked curve turns brighter and thicker.
  - A thin dark outline keeps curves readable on light faces.
- **Profiles:** closed profiles are shaded light orange, and the picked profile is blue.
- **While you edit a sketch on a face:**
  - The part stays solid with the sketch drawn on it.
  - The grid lies on the sketch's plane, in dark ink on the face.
  - Every curve end shows a small square point.
- A sketch on a free plane (XY, XZ, YZ or an offset plane) still ghosts the bodies, so it shows through them.
- Curves sit a couple of pixels above their face, so a tilted face never cuts into them.

### Picking
There is no Edge / Face / Solid switch: a tap picks what is under your finger.
- Sketch curves and sketch regions not used yet come first.
- Next is a body edge within a few pixels of the tap. Hidden edges behind the part are never picked.
- Otherwise the tap picks the face.
- **Tap the same spot again** to move up: edge → face → whole body → edge.
- A command that needs a kind of pick holds picking to it until you have one:
  - Fillet and Chamfer wait for edges.
  - Hole, Thread, Mate and Plane on a face wait for a face, then carry on once you tap one.
  - **Cancel** in the action row stops waiting.
- **Constraints work like Fusion's:** tap the constraint in the Constrain set, then tap the curves it applies to. Horizontal, Vertical and Fix need one curve; the others need two. The constraint stays active for the next curves until **Done** or Select.
- **Multi-select** (on the left rail) keeps adding the same kind of pick.

## Look: theme, lighting, surface and edges
The **Look** button (the half-filled circle, top right) opens a panel that is also at the top of Settings. Every option is also in the command search: type "Lighting", "Theme", "Surface" or "Edges".
- **Theme:**
  - **Midnight** (the default): indigo glass with a violet-to-cyan accent.
  - **Graphite:** neutral grey with mint.
  - **Ember:** the original warm grey with orange.
  - **Daylight:** a light studio with white glass.
  - Each theme also sets the backdrop, the grid, edge and sketch colours, and the selection colour.
- **Lighting:**
  - **Studio:** key, fill and rim light with sky light.
  - **Soft:** even, low contrast.
  - **Daylight:** a sun from above with a blue sky.
  - **Dramatic:** a hard side light and a cool rim.
  - **Flat:** shows true colours and is easiest for reading edges.
  - **Showroom:** soft boxes and reflections.
  - Studio, Soft, Dramatic and Flat move with the camera, so a part is lit the same way from every side. Daylight's sun stays fixed in the scene.
- **Surface:**
  - **Matte**, **Satin** (the default) and **Gloss**.
  - **Metal:** reflects a soft-box studio.
- **Edges:**
  - **Width:** Thin, Normal or Bold.
  - **When you zoom:** **Stay the same** keeps the same number of pixels at any zoom. **Scale with zoom** makes edges thicken as you zoom in and thin out as you zoom out, like ink on the part. At the zoom Frame uses, they are the normal width.

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
Use **Create Sketch**, then tap a flat face. The new sketch:
- **projects the face's boundary**, outer edge and holes included, as purple reference geometry, the way Fusion does. Round holes come in as exact circles, and straight runs as single lines.
- lets you snap to that geometry, dimension against it, and use it in profiles.
- frames the camera straight onto the face, with the Create tools ready.

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
- **Picking:** a tap picks the face, edge or curve under the finger, and tapping the same spot again picks the whole body (see Picking above). The keys `2`, `3` and `4` hold picking to edges, faces or bodies. **Edit mesh** is for imported meshes. A face pick selects the whole face, not individual triangles.
- **Modifiers:** each runs from the selection, opens a compact floating dialog with exact values, and has a **live drag handle** in the viewport.
  - **Fillet** (`F`) and **Chamfer** (`C`) on straight edges and on **round edges**: tapping the rim of a hole or boss selects the whole circle, so a chamfered hole rim gives a countersink. Where three filleted edges meet at right angles, the corner is rounded into a true spherical patch.
  - **Push/Pull** (`O`): move a face along its normal, adding or removing material.
  - **Shell** (`H`): hollow the body, with the selected faces left open. The wall offsets are solved exactly from the face planes.
  - **Mirror** (`M`): across YZ, XZ, XY or a selected face, optionally fused with the original.
  - **Boolean:** union, subtract or intersect. The volumes are checked, so a result the kernel got wrong is reported instead of silently replacing the part, and no boolean ever changes the bodies it started from.
  - **Rotate / Scale:** besides the axis and angle (or factors), the card takes the **pivot** — turn a clip about the fan's axis rather than about its own middle.
  - **Slice** (`SL`): cut by a plane through the body, a world plane or a selected face. Both halves are kept.
  - **Pattern** (`3A`): a polar pattern of bodies around X, Y or Z.
  - **Thicken:** turn a surface, such as an added Plane, into a solid.
  - **Draft:** tilt the selected side faces by an exact angle about a neutral plane, along +X, +Y or +Z. The geometry is re-solved from the face planes, so the edges stay exact. A round wall whose axis runs along the pull becomes an exact cone (a cup, a boss), and a fillet beside a drafted wall goes with it.
- **Direct modelling:** with faces or edges picked, the Move/Rotate/Scale gizmo drags them, and the neighbouring faces stretch to follow.
- **Revolve** can use any line in the sketch as its axis, including construction lines. With no construction line and a profile off the sketch's Y axis, it turns about the profile's own straight edge.
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
