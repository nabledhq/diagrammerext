/**
 * Pure, dependency-free diagram model shared by the extension host and the webview.
 *
 * All mutating operations return a new `Diagram` and never modify their input, which keeps
 * undo/redo snapshots trivially safe.
 */

export const DIAGRAM_VERSION = 1;

export const NODE_TYPES = ['rectangle', 'roundedRectangle', 'ellipse', 'diamond', 'text', 'sticky'] as const;

export type NodeType = (typeof NODE_TYPES)[number];

export interface DiagramNode {
    id: string;
    type: NodeType;
    x: number;
    y: number;
    width: number;
    height: number;
    label: string;
}

export interface DiagramEdge {
    id: string;
    from: string;
    to: string;
    label?: string;
}

export interface Diagram {
    version: number;
    nodes: DiagramNode[];
    edges: DiagramEdge[];
}

export interface Point {
    x: number;
    y: number;
}

export interface EdgeEndpoints {
    start: Point;
    end: Point;
}

export const DEFAULT_NODE_SIZES: Record<NodeType, { width: number; height: number; label: string }> = {
    rectangle: { width: 140, height: 70, label: 'Rectangle' },
    roundedRectangle: { width: 140, height: 70, label: 'Rounded' },
    ellipse: { width: 140, height: 80, label: 'Ellipse' },
    diamond: { width: 140, height: 100, label: 'Decision' },
    text: { width: 120, height: 30, label: 'Text' },
    sticky: { width: 150, height: 120, label: 'Note' },
};

export const MIN_NODE_SIZE = 10;

export class DiagramParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DiagramParseError';
    }
}

export function createEmptyDiagram(): Diagram {
    return { version: DIAGRAM_VERSION, nodes: [], edges: [] };
}

export function isNodeType(value: unknown): value is NodeType {
    return typeof value === 'string' && (NODE_TYPES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export function serializeDiagram(diagram: Diagram): string {
    const normalized: Diagram = {
        version: diagram.version,
        nodes: diagram.nodes.map((n) => ({
            id: n.id,
            type: n.type,
            x: n.x,
            y: n.y,
            width: n.width,
            height: n.height,
            label: n.label,
        })),
        edges: diagram.edges.map((e) => {
            const edge: DiagramEdge = { id: e.id, from: e.from, to: e.to };
            if (e.label !== undefined && e.label !== '') {
                edge.label = e.label;
            }
            return edge;
        }),
    };
    return JSON.stringify(normalized, null, 2) + '\n';
}

/**
 * Parses and validates the textual content of a `.diagram.json` file.
 *
 * - An empty (or whitespace-only) document is treated as an empty diagram.
 * - Syntactically invalid JSON or structurally invalid content throws a `DiagramParseError`.
 * - Edges that reference unknown nodes are dropped rather than failing the whole file.
 */
export function parseDiagram(text: string): Diagram {
    if (text.trim() === '') {
        return createEmptyDiagram();
    }
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (err) {
        throw new DiagramParseError(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    return validateDiagram(raw);
}

export function validateDiagram(raw: unknown): Diagram {
    if (!isRecord(raw)) {
        throw new DiagramParseError('Diagram must be a JSON object.');
    }
    const version = raw.version === undefined ? DIAGRAM_VERSION : raw.version;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
        throw new DiagramParseError('"version" must be a positive integer.');
    }
    if (version > DIAGRAM_VERSION) {
        throw new DiagramParseError(
            `Unsupported diagram version ${version}; this extension supports version ${DIAGRAM_VERSION}.`,
        );
    }
    const rawNodes = raw.nodes === undefined ? [] : raw.nodes;
    const rawEdges = raw.edges === undefined ? [] : raw.edges;
    if (!Array.isArray(rawNodes)) {
        throw new DiagramParseError('"nodes" must be an array.');
    }
    if (!Array.isArray(rawEdges)) {
        throw new DiagramParseError('"edges" must be an array.');
    }

    const nodes: DiagramNode[] = [];
    const nodeIds = new Set<string>();
    rawNodes.forEach((rawNode, index) => {
        const node = validateNode(rawNode, index);
        if (nodeIds.has(node.id)) {
            throw new DiagramParseError(`Duplicate node id "${node.id}".`);
        }
        nodeIds.add(node.id);
        nodes.push(node);
    });

    const edges: DiagramEdge[] = [];
    const edgeIds = new Set<string>();
    rawEdges.forEach((rawEdge, index) => {
        const edge = validateEdge(rawEdge, index);
        if (edgeIds.has(edge.id)) {
            throw new DiagramParseError(`Duplicate edge id "${edge.id}".`);
        }
        edgeIds.add(edge.id);
        if (nodeIds.has(edge.from) && nodeIds.has(edge.to)) {
            edges.push(edge);
        }
    });

    return { version: DIAGRAM_VERSION, nodes, edges };
}

function validateNode(raw: unknown, index: number): DiagramNode {
    const where = `nodes[${index}]`;
    if (!isRecord(raw)) {
        throw new DiagramParseError(`${where} must be an object.`);
    }
    const id = requireString(raw.id, `${where}.id`);
    if (id === '') {
        throw new DiagramParseError(`${where}.id must not be empty.`);
    }
    if (!isNodeType(raw.type)) {
        throw new DiagramParseError(`${where}.type must be one of: ${NODE_TYPES.join(', ')}.`);
    }
    return {
        id,
        type: raw.type,
        x: requireNumber(raw.x, `${where}.x`),
        y: requireNumber(raw.y, `${where}.y`),
        width: Math.max(MIN_NODE_SIZE, requireNumber(raw.width, `${where}.width`)),
        height: Math.max(MIN_NODE_SIZE, requireNumber(raw.height, `${where}.height`)),
        label: raw.label === undefined ? '' : requireString(raw.label, `${where}.label`),
    };
}

function validateEdge(raw: unknown, index: number): DiagramEdge {
    const where = `edges[${index}]`;
    if (!isRecord(raw)) {
        throw new DiagramParseError(`${where} must be an object.`);
    }
    const edge: DiagramEdge = {
        id: requireString(raw.id, `${where}.id`),
        from: requireString(raw.from, `${where}.from`),
        to: requireString(raw.to, `${where}.to`),
    };
    if (edge.id === '') {
        throw new DiagramParseError(`${where}.id must not be empty.`);
    }
    if (raw.label !== undefined) {
        edge.label = requireString(raw.label, `${where}.label`);
    }
    return edge;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, where: string): string {
    if (typeof value !== 'string') {
        throw new DiagramParseError(`${where} must be a string.`);
    }
    return value;
}

function requireNumber(value: unknown, where: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new DiagramParseError(`${where} must be a finite number.`);
    }
    return value;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function findNode(diagram: Diagram, id: string): DiagramNode | undefined {
    return diagram.nodes.find((n) => n.id === id);
}

export function findEdge(diagram: Diagram, id: string): DiagramEdge | undefined {
    return diagram.edges.find((e) => e.id === id);
}

export function edgesForNode(diagram: Diagram, nodeId: string): DiagramEdge[] {
    return diagram.edges.filter((e) => e.from === nodeId || e.to === nodeId);
}

/** Returns an id of the form `<prefix>-<n>` that is not used by any node or edge. */
export function nextId(diagram: Diagram, prefix: string): string {
    const used = new Set<string>([...diagram.nodes.map((n) => n.id), ...diagram.edges.map((e) => e.id)]);
    let max = 0;
    const pattern = new RegExp(`^${escapeRegExp(prefix)}-(\\d+)$`);
    for (const id of used) {
        const match = pattern.exec(id);
        if (match) {
            max = Math.max(max, Number(match[1]));
        }
    }
    let candidate = max + 1;
    while (used.has(`${prefix}-${candidate}`)) {
        candidate++;
    }
    return `${prefix}-${candidate}`;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Mutations (all return a new Diagram)
// ---------------------------------------------------------------------------

export interface NewNodeOptions {
    id?: string;
    width?: number;
    height?: number;
    label?: string;
}

/** Creates a node of the given type centred on `center`, using the default size for that type. */
export function createNode(diagram: Diagram, type: NodeType, center: Point, options: NewNodeOptions = {}): DiagramNode {
    const defaults = DEFAULT_NODE_SIZES[type];
    const width = options.width ?? defaults.width;
    const height = options.height ?? defaults.height;
    return {
        id: options.id ?? nextId(diagram, 'node'),
        type,
        x: Math.round(center.x - width / 2),
        y: Math.round(center.y - height / 2),
        width,
        height,
        label: options.label ?? defaults.label,
    };
}

export function addNode(diagram: Diagram, node: DiagramNode): Diagram {
    if (findNode(diagram, node.id) || findEdge(diagram, node.id)) {
        throw new Error(`Id "${node.id}" is already in use.`);
    }
    return { ...diagram, nodes: [...diagram.nodes, { ...node }] };
}

/** Removes a node and every edge connected to it. Unknown ids are ignored. */
export function removeNode(diagram: Diagram, nodeId: string): Diagram {
    if (!findNode(diagram, nodeId)) {
        return diagram;
    }
    return {
        ...diagram,
        nodes: diagram.nodes.filter((n) => n.id !== nodeId),
        edges: diagram.edges.filter((e) => e.from !== nodeId && e.to !== nodeId),
    };
}

export function moveNode(diagram: Diagram, nodeId: string, x: number, y: number): Diagram {
    if (!findNode(diagram, nodeId)) {
        return diagram;
    }
    return {
        ...diagram,
        nodes: diagram.nodes.map((n) => (n.id === nodeId ? { ...n, x, y } : n)),
    };
}

/**
 * Adds an edge between two existing nodes. Self-loops and duplicate connections
 * (same from/to pair) are rejected by returning the diagram unchanged.
 */
export function addEdge(diagram: Diagram, from: string, to: string, options: { id?: string; label?: string } = {}): Diagram {
    if (from === to || !findNode(diagram, from) || !findNode(diagram, to)) {
        return diagram;
    }
    if (diagram.edges.some((e) => e.from === from && e.to === to)) {
        return diagram;
    }
    const id = options.id ?? nextId(diagram, 'edge');
    if (findNode(diagram, id) || findEdge(diagram, id)) {
        throw new Error(`Id "${id}" is already in use.`);
    }
    const edge: DiagramEdge = { id, from, to };
    if (options.label) {
        edge.label = options.label;
    }
    return { ...diagram, edges: [...diagram.edges, edge] };
}

export function removeEdge(diagram: Diagram, edgeId: string): Diagram {
    if (!findEdge(diagram, edgeId)) {
        return diagram;
    }
    return { ...diagram, edges: diagram.edges.filter((e) => e.id !== edgeId) };
}

/** Removes a node (with its edges) or an edge, whichever the id refers to. */
export function removeElement(diagram: Diagram, id: string): Diagram {
    return findNode(diagram, id) ? removeNode(diagram, id) : removeEdge(diagram, id);
}

/** Sets the label of the node or edge with the given id. */
export function setLabel(diagram: Diagram, id: string, label: string): Diagram {
    if (findNode(diagram, id)) {
        return { ...diagram, nodes: diagram.nodes.map((n) => (n.id === id ? { ...n, label } : n)) };
    }
    if (findEdge(diagram, id)) {
        return {
            ...diagram,
            edges: diagram.edges.map((e) => {
                if (e.id !== id) {
                    return e;
                }
                const { label: _old, ...rest } = e;
                return label === '' ? rest : { ...rest, label };
            }),
        };
    }
    return diagram;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export function nodeCenter(node: DiagramNode): Point {
    return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}

/**
 * Returns the point where a ray from the node's centre towards `toward` leaves the node's outline.
 */
export function boundaryPoint(node: DiagramNode, toward: Point): Point {
    const c = nodeCenter(node);
    const dx = toward.x - c.x;
    const dy = toward.y - c.y;
    if (dx === 0 && dy === 0) {
        return c;
    }
    const a = node.width / 2;
    const b = node.height / 2;
    let t: number;
    switch (node.type) {
        case 'ellipse':
            t = 1 / Math.sqrt((dx * dx) / (a * a) + (dy * dy) / (b * b));
            break;
        case 'diamond':
            t = 1 / (Math.abs(dx) / a + Math.abs(dy) / b);
            break;
        default:
            t = Math.min(dx === 0 ? Infinity : a / Math.abs(dx), dy === 0 ? Infinity : b / Math.abs(dy));
            break;
    }
    return { x: c.x + dx * t, y: c.y + dy * t };
}

/**
 * Computes where an edge should be drawn: from the outline of its source node to the outline of its
 * target node, along the line joining their centres. Returns `undefined` if either node is missing.
 * Because endpoints are derived from node geometry, they follow the nodes whenever they move.
 */
export function getEdgeEndpoints(diagram: Diagram, edge: DiagramEdge): EdgeEndpoints | undefined {
    const from = findNode(diagram, edge.from);
    const to = findNode(diagram, edge.to);
    if (!from || !to) {
        return undefined;
    }
    return {
        start: boundaryPoint(from, nodeCenter(to)),
        end: boundaryPoint(to, nodeCenter(from)),
    };
}

/** Returns the node whose bounding box contains `point`, preferring the top-most (last drawn). */
export function hitTestNode(diagram: Diagram, point: Point, excludeId?: string): DiagramNode | undefined {
    for (let i = diagram.nodes.length - 1; i >= 0; i--) {
        const n = diagram.nodes[i];
        if (n.id === excludeId) {
            continue;
        }
        if (point.x >= n.x && point.x <= n.x + n.width && point.y >= n.y && point.y <= n.y + n.height) {
            return n;
        }
    }
    return undefined;
}
