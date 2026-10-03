# Diagrammer

Diagrammer is a VS Code extension that allows users and AI to create quick diagrams for coding.
Diagrams are stored as plain JSON (`*.diagram.json`) files right next to your code, so they can be
reviewed, diffed and versioned like any other file.

## Features

- **Custom diagram editor** – any file ending in `.diagram.json` opens in a visual canvas
  (use *Reopen Editor With… → Text Editor* to see the raw JSON).
- **`Diagrammer: New Diagram` command** – creates `untitled.diagram.json` in the first workspace
  folder (`untitled-1.diagram.json`, `untitled-2.diagram.json`, … if the name is taken) and opens
  it. Without an open folder you are asked where to save the file.
- **Shape palette** – rectangle, rounded rectangle, ellipse, diamond, text label and sticky note.
  Drag a shape onto the canvas, or click it to drop it in the middle of the visible area.
- **Move** – drag a node to move it. Connectors stay attached and re-route to the shape outline.
- **Labels** – double-click a node or connector (or select it and press `Enter`/`F2`) to edit its
  label. `Enter` saves, `Shift+Enter` inserts a line break, `Escape` cancels.
- **Connectors** – hover a node to reveal its four handles, then drag from a handle onto another
  node to connect them. Connectors are directed (`from` → `to`) and drawn with an arrow head.
- **Delete** – click a node or connector to select it and press `Delete` (or `Backspace`).
  Deleting a node also deletes every connector attached to it.
- **VS Code integration** – edits mark the file dirty, `Ctrl+S`/`Cmd+S` saves, and
  `Ctrl+Z`/`Ctrl+Y` (or `Cmd+Z`/`Cmd+Shift+Z`) undo and redo through VS Code's edit history. Hot
  exit/backups, *Save As* and *Revert File* are supported. Colours follow the active VS Code theme.
- **Safe with bad files** – a file that is not valid JSON or does not match the format below is
  shown with an error message instead of the canvas and is never overwritten.

## File format

```json
{
  "version": 1,
  "nodes": [
    { "id": "node-1", "type": "rectangle", "x": 40, "y": 40, "width": 140, "height": 70, "label": "Client" },
    { "id": "node-2", "type": "ellipse", "x": 300, "y": 40, "width": 140, "height": 80, "label": "API" }
  ],
  "edges": [
    { "id": "edge-1", "from": "node-1", "to": "node-2", "label": "HTTP" }
  ]
}
```

| Field | Description |
| --- | --- |
| `version` | Format version. Currently always `1`; files with a newer version are rejected. |
| `nodes[].id` | Unique, non-empty string. |
| `nodes[].type` | One of `rectangle`, `roundedRectangle`, `ellipse`, `diamond`, `text`, `sticky`. |
| `nodes[].x`, `nodes[].y` | Top-left corner in canvas pixels. |
| `nodes[].width`, `nodes[].height` | Size in canvas pixels. |
| `nodes[].label` | Text shown in the shape; may contain `\n` line breaks. |
| `edges[].id` | Unique, non-empty string. |
| `edges[].from`, `edges[].to` | Ids of the source and target nodes. |
| `edges[].label` | Optional connector label (omitted when empty). |

When loading, an empty file is treated as an empty diagram, unknown extra properties are ignored
and edges whose `from`/`to` point to missing nodes are dropped. Anything else that does not match
the format (invalid JSON, wrong types, unknown node types, duplicate ids) is reported as an error.

## Running the extension

Requirements: Node.js 20.19+ (or 22.13+) and VS Code 1.85+.

```bash
npm install
npm run compile      # type-check and bundle into dist/ with esbuild
```

Then open this folder in VS Code and press `F5` (*Run Extension*) to start an Extension
Development Host. In it, run **Diagrammer: New Diagram** from the Command Palette or open any
`*.diagram.json` file. `npm run watch` rebuilds automatically while you edit.

## Development

| Script | Purpose |
| --- | --- |
| `npm run compile` | Type-check (`tsc --noEmit`) and bundle the extension and webview with esbuild. |
| `npm run watch` | Rebuild on change. |
| `npm run lint` | Run ESLint (typescript-eslint) over `src/`. |
| `npm test` | Compile and run the unit tests with Mocha (model + webview canvas in jsdom). |
| `npm run test:integration` | Launch VS Code via `@vscode/test-electron` and run the end-to-end tests. Downloads VS Code on first run; on Linux CI wrap it in `xvfb-run -a`. |
| `npm run package` | Production (minified) bundle. |

Project layout:

- `src/extension.ts` – activation; registers the editor and the command.
- `src/diagramEditor.ts` – `CustomEditorProvider`, document model, save/revert/backup, undo/redo.
- `src/newDiagram.ts` – the `Diagrammer: New Diagram` command.
- `src/model/diagram.ts` – pure diagram model: parsing/validation, serialization, edits, geometry.
  Shared by the extension host and the webview.
- `src/webview/main.ts`, `media/diagram.css` – the SVG canvas (no third-party diagram library).
- `src/protocol.ts` – messages exchanged between the extension host and the webview.
- `src/test/unit` – Mocha unit tests; `src/test/integration` – VS Code integration tests.
