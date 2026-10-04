/**
 * Conversion between parsed Mermaid flowcharts and Diagrammer diagrams. Pure (no `vscode` imports).
 */
import { autoLayout, LayoutMode } from '../layout';
import { DEFAULT_NODE_SIZES, Diagram, DIAGRAM_VERSION, DiagramEdge, DiagramNode, NodeType } from '../model/diagram';
import { MermaidDirection, MermaidFlowchart, MermaidShape } from './parse';

/** Mermaid shape → Diagrammer node type. Diagrammer has no circle, so `(( ))` becomes a round ellipse. */
const SHAPE_TO_TYPE: Record<MermaidShape, NodeType> = {
    rectangle: 'rectangle',
    rounded: 'roundedRectangle',
    diamond: 'diamond',
    circle: 'ellipse',
};

/** Diagrammer node type → Mermaid shape delimiters (the inverse of the import mapping). */
const TYPE_TO_DELIMITERS: Record<NodeType, [string, string]> = {
    rectangle: ['[', ']'],
    roundedRectangle: ['(', ')'],
    diamond: ['{', '}'],
    ellipse: ['((', '))'],
    text: ['[', ']'],
    sticky: ['[', ']'],
};

const CIRCLE_SIZE = 100;
const CHAR_WIDTH = 8;
const LINE_HEIGHT = 18;
const MAX_NODE_WIDTH = 320;

/**
 * Builds a new diagram from a parsed flowchart and lays it out with the auto-layout engine so that
 * ranks follow the Mermaid direction (TD/TB downwards, BT upwards, LR rightwards, RL leftwards).
 * Edge styles (dotted, thick, open) are not representable and import as normal connectors.
 */
export function mermaidToDiagram(flowchart: MermaidFlowchart): Diagram {
    const ids = new Map<string, string>();
    const nodes: DiagramNode[] = flowchart.nodes.map((n, i) => {
        const id = `node-${i + 1}`;
        ids.set(n.id, id);
        const type = SHAPE_TO_TYPE[n.shape];
        return { id, type, x: 0, y: 0, ...nodeSize(type, n.label), label: n.label };
    });
    const edges: DiagramEdge[] = flowchart.edges.map((e, i) => {
        const edge: DiagramEdge = { id: `edge-${i + 1}`, from: ids.get(e.from)!, to: ids.get(e.to)! };
        if (e.label) {
            edge.label = e.label;
        }
        return edge;
    });
    const diagram: Diagram = { version: DIAGRAM_VERSION, nodes, edges };
    const horizontal = flowchart.direction === 'LR' || flowchart.direction === 'RL';
    const mode: LayoutMode = horizontal ? 'left-to-right' : 'top-to-bottom';
    const laidOut = autoLayout(diagram, { mode });
    return flowchart.direction === 'BT' || flowchart.direction === 'RL' ? mirror(laidOut, horizontal) : laidOut;
}

/** Grows the default size of a shape so that the label fits on one line per `\n`. */
function nodeSize(type: NodeType, label: string): { width: number; height: number } {
    if (type === 'ellipse') {
        const lines = label.split('\n');
        const size = Math.max(CIRCLE_SIZE, Math.max(...lines.map((l) => l.length)) * CHAR_WIDTH * 1.2);
        return { width: Math.min(size, MAX_NODE_WIDTH), height: Math.min(size, MAX_NODE_WIDTH) };
    }
    const defaults = DEFAULT_NODE_SIZES[type];
    const lines = label.split('\n');
    const longest = Math.max(...lines.map((l) => l.length));
    const scale = type === 'diamond' ? 2 : 1;
    return {
        width: Math.min(MAX_NODE_WIDTH, Math.max(defaults.width, longest * CHAR_WIDTH * scale + 30)),
        height: Math.max(defaults.height, lines.length * LINE_HEIGHT * scale + 30),
    };
}

/** Flips the layout along its rank axis, keeping the same bounding box. */
function mirror(diagram: Diagram, horizontal: boolean): Diagram {
    if (diagram.nodes.length === 0) {
        return diagram;
    }
    const min = Math.min(...diagram.nodes.map((n) => (horizontal ? n.x : n.y)));
    const max = Math.max(...diagram.nodes.map((n) => (horizontal ? n.x + n.width : n.y + n.height)));
    return {
        ...diagram,
        nodes: diagram.nodes.map((n) =>
            horizontal ? { ...n, x: min + max - n.x - n.width } : { ...n, y: min + max - n.y - n.height },
        ),
    };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Words Mermaid treats as keywords; used as a node id they would break the flowchart. */
const RESERVED_IDS = new Set(['end', 'graph', 'flowchart', 'subgraph', 'class', 'classdef', 'style', 'linkstyle', 'click', 'direction']);

/**
 * Serialises a diagram as a Mermaid flowchart: a `flowchart <direction>` header, then one indented
 * line per node declaration followed by one per edge. Node positions are not exported.
 */
export function diagramToMermaid(diagram: Diagram, direction: MermaidDirection = 'TD'): string {
    const ids = mermaidIds(diagram.nodes.map((n) => n.id));
    const lines = [`flowchart ${direction}`];
    for (const node of diagram.nodes) {
        const [open, close] = TYPE_TO_DELIMITERS[node.type];
        lines.push(`    ${ids.get(node.id)}${open}"${encodeLabel(node.label)}"${close}`);
    }
    for (const edge of diagram.edges) {
        const from = ids.get(edge.from);
        const to = ids.get(edge.to);
        if (from === undefined || to === undefined) {
            continue;
        }
        const label = edge.label ? `|"${encodeLabel(edge.label)}"|` : '';
        lines.push(`    ${from} -->${label} ${to}`);
    }
    return lines.join('\n') + '\n';
}

/**
 * Maps diagram ids to Mermaid-safe ids: characters outside `[A-Za-z0-9_]` become `_`, reserved
 * words get a `_` suffix, and ids that collide after that get a numeric suffix (`_2`, `_3`, …).
 */
export function mermaidIds(ids: readonly string[]): Map<string, string> {
    const result = new Map<string, string>();
    const used = new Set<string>();
    for (const id of ids) {
        let base = id.replace(/[^A-Za-z0-9_]/g, '_') || 'node';
        if (RESERVED_IDS.has(base.toLowerCase())) {
            base += '_';
        }
        let candidate = base;
        for (let n = 2; used.has(candidate); n++) {
            candidate = `${base}_${n}`;
        }
        used.add(candidate);
        result.set(id, candidate);
    }
    return result;
}

/**
 * Makes a label safe inside a quoted Mermaid label: `"` becomes `#quot;`, a `#` that would read as
 * an entity becomes `#35;`, and line breaks become `<br>`. Brackets and pipes need no escaping
 * inside quotes.
 */
export function encodeLabel(label: string): string {
    return label
        .replace(/#(?=\w+;)/g, '#35;')
        .replace(/"/g, '#quot;')
        .replace(/\r?\n/g, '<br>');
}
