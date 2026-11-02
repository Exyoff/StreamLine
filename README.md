# StreamLine

Precise polygon modelling in the browser, designed for iPhone and iPad first. It works like Blender (Object and Edit modes, Z-up, extrude and inset, a redo panel) and lets you type exact values the way a CAD program does.

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
`js/mesh.js` polygon mesh and modelling ops · `js/operators.js` operator definitions · `js/ops.js` redo panel and undo · `js/viewport.js` renderer, camera, picking, gestures · `js/gizmo.js` transform handles · `js/units.js` units and expression parser · `js/ui.js` keypad and widgets · `js/io.js` STL/OBJ · `vendor/` three.js r170 (MIT).
