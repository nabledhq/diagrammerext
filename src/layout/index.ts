/**
 * Automatic layout for diagrams, built on dagre.
 *
 * This module is pure: it has no `vscode` imports, never mutates its input and can be used from
 * plain Node (unit tests, a future CLI or MCP tool). `computeLayout` works on any graph of sized
 * nodes and directed edges and returns new top-left positions only; `autoLayout` and
 * `placeUnpositioned` are conveniences that return an updated `Diagram`.
 */
import * as dagre from 'dagre';
import type { Diagram, Point } from '../model/diagram';

export const LAYOUT_MODES = ['top-to-bottom', 'left-to-right'] as const;

export type LayoutMode = (typeof LAYOUT_MODES)[number];

export const DEFAULT_LAYOUT_MODE: LayoutMode = 'top-to-bottom';

/** Where a whole-diagram layout puts its top-left corner unless told otherwise. */
export const DEFAULT_LAYOUT_ORIGIN: Point = { x: 40, y: 40 };

/** Vertical gap between already positioned nodes and newly placed ones. */
export const PLACEMENT_GAP = 80;

const NODE_SEPARATION = 40;
const RANK_SEPARATION = 70;

export interface LayoutNode {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface LayoutEdge {
    from: string;
    to: string;
}

export interface LayoutGraph {
    nodes: readonly LayoutNode[];
    edges: readonly LayoutEdge[];
}

export interface LayoutOptions {
    /** Defaults to `DEFAULT_LAYOUT_MODE`. */
    mode?: LayoutMode;
    /**
     * Lay out only these nodes (and the edges between them). Other nodes are ignored and get no
     * position in the result. Omit (or pass an empty list) to lay out every node.
     */
    nodeIds?: readonly string[];
    /**
     * Top-left corner of the laid-out block. Defaults to the original top-left of the subset's
     * bounding box when `nodeIds` is given, and to `DEFAULT_LAYOUT_ORIGIN` otherwise.
     * Negative coordinates are clamped to 0.
     */
    origin?: Point;
}

export function isLayoutMode(value: unknown): value is LayoutMode {
    return typeof value === 'string' && (LAYOUT_MODES as readonly string[]).includes(value);
}

/**
 * Computes new top-left positions for the selected nodes of `graph`. The returned map contains an
 * entry for every laid-out node and nothing else. Cycles, self-loops, duplicate edges, edges to
 * unknown nodes and disconnected components are all accepted.
 */
export function computeLayout(graph: LayoutGraph, options: LayoutOptions = {}): Map<string, Point> {
    const mode = options.mode ?? DEFAULT_LAYOUT_MODE;
    const subset = options.nodeIds && options.nodeIds.length > 0 ? new Set(options.nodeIds) : undefined;
    const nodes = graph.nodes.filter((n) => !subset || subset.has(n.id));
    const result = new Map<string, Point>();
    if (nodes.length === 0) {
        return result;
    }

    const g = new dagre.graphlib.Graph();
    g.setGraph({
        rankdir: mode === 'left-to-right' ? 'LR' : 'TB',
        nodesep: NODE_SEPARATION,
        ranksep: RANK_SEPARATION,
        edgesep: 20,
        marginx: 0,
        marginy: 0,
    });
    g.setDefaultEdgeLabel(() => ({}));
    for (const n of nodes) {
        g.setNode(n.id, { width: n.width, height: n.height });
    }
    for (const e of graph.edges) {
        if (e.from !== e.to && g.hasNode(e.from) && g.hasNode(e.to)) {
            g.setEdge(e.from, e.to);
        }
    }
    dagre.layout(g);

    const laidOut = nodes.map((n) => {
        const { x, y } = g.node(n.id);
        return { id: n.id, x: x - n.width / 2, y: y - n.height / 2 };
    });
    const minX = Math.min(...laidOut.map((p) => p.x));
    const minY = Math.min(...laidOut.map((p) => p.y));
    const target = options.origin ?? (subset ? boundingBox(nodes) : DEFAULT_LAYOUT_ORIGIN);
    const originX = Math.max(0, target.x);
    const originY = Math.max(0, target.y);
    for (const p of laidOut) {
        result.set(p.id, { x: Math.round(p.x - minX + originX), y: Math.round(p.y - minY + originY) });
    }
    return result;
}

/** Returns a copy of `diagram` with the given node positions applied. */
export function applyPositions(diagram: Diagram, positions: ReadonlyMap<string, Point>): Diagram {
    if (positions.size === 0) {
        return diagram;
    }
    return {
        ...diagram,
        nodes: diagram.nodes.map((n) => {
            const p = positions.get(n.id);
            return p ? { ...n, x: p.x, y: p.y } : n;
        }),
    };
}

/**
 * Lays out `diagram` (or only `options.nodeIds`) and returns the updated diagram. Returns the
 * input object unchanged if no node actually moves.
 */
export function autoLayout(diagram: Diagram, options: LayoutOptions = {}): Diagram {
    const positions = computeLayout(diagram, options);
    const moved = diagram.nodes.some((n) => {
        const p = positions.get(n.id);
        return p !== undefined && (p.x !== n.x || p.y !== n.y);
    });
    return moved ? applyPositions(diagram, positions) : diagram;
}

/**
 * Places nodes that have no meaningful coordinates yet (e.g. written by hand or by an AI without
 * x/y). Nodes not listed in `unpositioned` never move.
 *
 * - If every node is unpositioned, the whole diagram is laid out.
 * - Otherwise the unpositioned nodes are laid out as a block that starts at the left edge of the
 *   positioned nodes' bounding box, `PLACEMENT_GAP` pixels below it, so nothing overlaps.
 */
export function placeUnpositioned(
    diagram: Diagram,
    unpositioned: readonly string[],
    mode: LayoutMode = DEFAULT_LAYOUT_MODE,
): Diagram {
    const pending = new Set(unpositioned);
    const positioned = diagram.nodes.filter((n) => !pending.has(n.id));
    const toPlace = diagram.nodes.filter((n) => pending.has(n.id)).map((n) => n.id);
    if (toPlace.length === 0) {
        return diagram;
    }
    if (positioned.length === 0) {
        return applyPositions(diagram, computeLayout(diagram, { mode }));
    }
    const box = boundingBox(positioned);
    const origin = { x: box.x, y: box.y + box.height + PLACEMENT_GAP };
    return applyPositions(diagram, computeLayout(diagram, { mode, nodeIds: toPlace, origin }));
}

export function boundingBox(nodes: readonly LayoutNode[]): { x: number; y: number; width: number; height: number } {
    const minX = Math.min(...nodes.map((n) => n.x));
    const minY = Math.min(...nodes.map((n) => n.y));
    const maxX = Math.max(...nodes.map((n) => n.x + n.width));
    const maxY = Math.max(...nodes.map((n) => n.y + n.height));
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
