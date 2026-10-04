# Diagram operations (schema version 1)

AI agents, scripts and the **Diagrammer: Edit Diagram with AI** command change diagrams through
small, validated operations instead of rewriting the `.diagram.json` file. A *batch* is a JSON
array of operation objects. Batches are applied in order and atomically: if any operation is
invalid, nothing changes and every problem found is reported.

The implementation lives in [`src/ai/operations.ts`](../src/ai/operations.ts) and has no VS Code
dependency (`applyOperations`, `parseOperations`, `validateOperations`, `OPERATIONS_JSON_SCHEMA`),
so a script or a future MCP server can reuse it.

## Schema version

The JSON Schema (draft 2020-12) is exported as `OPERATIONS_JSON_SCHEMA` and carries
`"schemaVersion": 1` (also exported as `OPERATIONS_SCHEMA_VERSION`). It is generated from the same
field table the validator uses, so the two always agree. The version will be bumped on any
incompatible change. Batches themselves are plain arrays and carry no version field.

## Operations

Every operation is an object with an `op` field. Unknown `op` values and unknown fields are
rejected. "Ref" means an existing element id or a `tempId` defined earlier in the same batch.

| `op` | Required fields | Optional fields | Effect |
| --- | --- | --- | --- |
| `addNode` | `tempId`, `label` | `type`, `x`, `y`, `width`, `height` | Adds a node. |
| `removeNode` | `id` (node ref) | | Removes the node **and every connector attached to it**. |
| `renameNode` | `id` (node ref), `label` | | Sets the node's label. |
| `moveNode` | `id` (node ref), `x`, `y` | | Moves the node's top-left corner. |
| `addConnector` | `from`, `to` (node refs) | `label`, `tempId` | Adds a directed connector `from` → `to`. |
| `removeConnector` | `id` (connector ref) | | Removes the connector. |
| `updateNodeMetadata` | `id` (node ref), and at least one optional field | `type`, `width`, `height` | Changes the node's shape and/or size. |
| `updateConnectorMetadata` | `id` (connector ref), `label` | | Sets the connector's label; `""` removes it. |
| `applyLayout` | | `mode` | Re-arranges the whole diagram with auto layout. |

Field types:

| Field | Type |
| --- | --- |
| `id`, `from`, `to`, `tempId` | Non-empty string. |
| `label` | String (may contain `\n`). |
| `type` | One of `rectangle`, `roundedRectangle`, `ellipse`, `diamond`, `text`, `sticky`. Defaults to `rectangle` for `addNode`. |
| `x`, `y` | Finite number (canvas pixels). For `addNode` give both or neither. |
| `width`, `height` | Finite number ≥ 10. For `addNode` they default to the shape's standard size. |
| `mode` | `top-to-bottom` (default) or `left-to-right`. |

The file format has no free-form metadata, so "metadata" means the existing attributes other than
the label and position: shape type and size for nodes, the label for connectors.

Additional rules checked when the batch is applied:

- A connector cannot connect a node to itself, and two connectors cannot have the same `from`/`to`
  pair.
- Elements removed earlier in the batch count as missing for later operations.
- `addNode` without `x`/`y` places the node automatically after the whole batch (below the
  existing nodes, without overlaps), unless a later `moveNode` or `applyLayout` positions it.

## Ids and tempIds

- Existing nodes and connectors are referenced by their `id` from the file.
- New nodes **must**, and new connectors **may**, get a caller-chosen `tempId`. Later operations
  in the same batch use the `tempId` wherever a ref is expected.
- A `tempId` must be unique within the batch and must not equal any id already in the diagram.
- The saved id is generated (`node-N` / `edge-N`, never colliding with existing ids or tempIds).
  The mapping is returned as `idMap` (`{ "<tempId>": "<saved id>" }`). tempIds are not valid
  outside their batch.
- Referencing an unknown id, or a tempId before the operation that defines it, is an error.

## Example batch

Against a diagram with nodes `api` ("API") and `db` ("Database"):

```json
[
  { "op": "renameNode", "id": "api", "label": "Public API" },
  { "op": "addNode", "tempId": "worker", "label": "Worker", "type": "roundedRectangle" },
  { "op": "addNode", "tempId": "queue", "label": "Queue" },
  { "op": "addConnector", "from": "api", "to": "queue", "label": "enqueue" },
  { "op": "addConnector", "from": "worker", "to": "queue" },
  { "op": "addConnector", "from": "worker", "to": "db" },
  { "op": "updateNodeMetadata", "id": "db", "type": "ellipse" }
]
```

Summary shown/returned for this batch:

```
Add 2 nodes: "Worker", "Queue"
Rename "API" → "Public API"
Connect "Public API" → "Queue" ("enqueue")
Connect "Worker" → "Queue"
Connect "Worker" → "Database"
Update "Database": shape ellipse
```

## `diagrammer.applyOperations`

Entry point for other extensions, scripts and agents. It validates and applies a batch to an open
Diagrammer document with no language-model call and no confirmation UI:

```ts
const result = await vscode.commands.executeCommand('diagrammer.applyOperations', uri, operations);
// or, for the diagram in the active Diagrammer editor:
const result = await vscode.commands.executeCommand('diagrammer.applyOperations', operations);
```

- `uri` (optional) – the `vscode.Uri` of a diagram that is open in the Diagrammer editor. When
  omitted, the active Diagrammer editor is used.
- `operations` – the batch, as an array or as a JSON string.
- Returns `{ summary: string[], idMap: Record<string, string> }` on success, or
  `{ errors: string[] }` (and no change) when the batch is invalid or no diagram is open.

A successful batch is applied as a single edit through the document's normal edit path: the file
becomes dirty, one undo reverts the whole batch, and saving writes the usual `.diagram.json` format.

## Edit Diagram with AI

**Diagrammer: Edit Diagram with AI** (`diagrammer.editWithAI`, available while a Diagrammer
editor is active) asks for an instruction and sends the current diagram (ids, labels, types,
positions, sizes, connectors), the selected node ids and labels (labelled as the selection), the
JSON Schema above and the instruction to the first chat model offered by the VS Code Language
Model API (`vscode.lm`, for example GitHub Copilot). The model must answer with only a JSON array
of operations; surrounding Markdown code fences are tolerated. There are no API-key settings: if
no model is available an error explains how to get one.

The reply is validated like any other batch. Invalid or unparseable replies show an error and
leave the document untouched. Valid replies are previewed in a modal dialog listing the summary,
with **Apply (keep positions)**, **Apply and Re-layout** (appends an `applyLayout` operation) and
**Cancel**. Nothing changes unless you choose one of the Apply buttons.

The model access sits behind the `DiagramAIProvider` interface (`src/ai/provider.ts`); the VS Code
implementation is `src/ai/vscodeLmProvider.ts`. No AI vendor SDK is used.

## Omitted operations

- **`groupNodes`** – not provided. The native `.diagram.json` format (version 1) has no groups or
  containers, and this feature deliberately does not change the file format.
- **`applyLayout`** *is* provided: it delegates to the existing dagre-based auto layout
  (`src/layout/index.ts`); no new layout engine was added.
