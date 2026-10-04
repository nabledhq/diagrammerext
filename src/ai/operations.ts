/**
 * Structured edit operations for diagrams.
 *
 * AI agents (and scripts) never rewrite a whole diagram: they send a batch of small operations that
 * is validated and applied here. This module is pure (no `vscode` import) so the same logic can back
 * the VS Code commands, unit tests and a future MCP server.
 *
 * `applyOperations` is atomic: either every operation in the batch applies, or the caller gets the
 * original (never mutated) diagram back together with the list of problems.
 */
import { autoLayout, DEFAULT_LAYOUT_MODE, isLayoutMode, LAYOUT_MODES, LayoutMode, placeUnpositioned } from '../layout';
import {
    DEFAULT_NODE_SIZES,
    Diagram,
    DiagramEdge,
    DiagramNode,
    findEdge,
    findNode,
    isNodeType,
    MIN_NODE_SIZE,
    NODE_TYPES,
    NodeType,
} from '../model/diagram';

/** Version of the operation schema below. Bump it on any incompatible change. */
export const OPERATIONS_SCHEMA_VERSION = 1;

export const OPERATION_TYPES = [
    'addNode',
    'removeNode',
    'renameNode',
    'moveNode',
    'addConnector',
    'removeConnector',
    'updateNodeMetadata',
    'updateConnectorMetadata',
    'applyLayout',
] as const;

export type OperationType = (typeof OPERATION_TYPES)[number];

/** Adds a node. `tempId` names it for later operations in the same batch; the saved id is generated. */
export interface AddNodeOperation {
    op: 'addNode';
    tempId: string;
    label: string;
    type?: NodeType;
    /** `x`/`y` must be given together. Without them the node is placed by auto layout. */
    x?: number;
    y?: number;
    width?: number;
    height?: number;
}

/** Removes a node and every connector attached to it. */
export interface RemoveNodeOperation {
    op: 'removeNode';
    id: string;
}

export interface RenameNodeOperation {
    op: 'renameNode';
    id: string;
    label: string;
}

/** Moves a node's top-left corner to `x`/`y`. */
export interface MoveNodeOperation {
    op: 'moveNode';
    id: string;
    x: number;
    y: number;
}

/** Adds a directed connector `from` → `to`. The optional `tempId` names it for later operations. */
export interface AddConnectorOperation {
    op: 'addConnector';
    from: string;
    to: string;
    label?: string;
    tempId?: string;
}

export interface RemoveConnectorOperation {
    op: 'removeConnector';
    id: string;
}

/** Updates a node's non-label attributes: its shape type and/or size. At least one is required. */
export interface UpdateNodeMetadataOperation {
    op: 'updateNodeMetadata';
    id: string;
    type?: NodeType;
    width?: number;
    height?: number;
}

/** Updates a connector's attributes; the format only has a label (an empty string removes it). */
export interface UpdateConnectorMetadataOperation {
    op: 'updateConnectorMetadata';
    id: string;
    label: string;
}

/** Re-arranges the whole diagram with the built-in auto layout. */
export interface ApplyLayoutOperation {
    op: 'applyLayout';
    mode?: LayoutMode;
}

export type DiagramOperation =
    | AddNodeOperation
    | RemoveNodeOperation
    | RenameNodeOperation
    | MoveNodeOperation
    | AddConnectorOperation
    | RemoveConnectorOperation
    | UpdateNodeMetadataOperation
    | UpdateConnectorMetadataOperation
    | ApplyLayoutOperation;

// ---------------------------------------------------------------------------
// Field and operation specs (single source for the validator and the JSON Schema)
// ---------------------------------------------------------------------------

type Field = 'id' | 'tempId' | 'from' | 'to' | 'label' | 'type' | 'x' | 'y' | 'width' | 'height' | 'mode';

const REF_DESCRIPTION = 'Id of an existing element, or a tempId defined by an earlier operation in the same batch.';

const FIELD_SCHEMAS: Record<Field, Record<string, unknown>> = {
    id: { type: 'string', minLength: 1, description: REF_DESCRIPTION },
    tempId: {
        type: 'string',
        minLength: 1,
        description: 'Caller-chosen temporary id, unique in the batch and not used by the diagram.',
    },
    from: { type: 'string', minLength: 1, description: `Source node. ${REF_DESCRIPTION}` },
    to: { type: 'string', minLength: 1, description: `Target node. ${REF_DESCRIPTION}` },
    label: { type: 'string' },
    type: { enum: [...NODE_TYPES], description: 'Node shape.' },
    x: { type: 'number', description: 'Left edge in canvas pixels.' },
    y: { type: 'number', description: 'Top edge in canvas pixels.' },
    width: { type: 'number', minimum: MIN_NODE_SIZE },
    height: { type: 'number', minimum: MIN_NODE_SIZE },
    mode: { enum: [...LAYOUT_MODES], description: `Layout direction; defaults to "${DEFAULT_LAYOUT_MODE}".` },
};

interface OperationSpec {
    description: string;
    required: Field[];
    optional: Field[];
}

const OPERATION_SPECS: Record<OperationType, OperationSpec> = {
    addNode: {
        description:
            'Add a node. Omit x/y to have it placed automatically. Later operations reference it by tempId.',
        required: ['tempId', 'label'],
        optional: ['type', 'x', 'y', 'width', 'height'],
    },
    removeNode: { description: 'Remove a node and all connectors attached to it.', required: ['id'], optional: [] },
    renameNode: { description: "Change a node's label.", required: ['id', 'label'], optional: [] },
    moveNode: { description: "Move a node's top-left corner.", required: ['id', 'x', 'y'], optional: [] },
    addConnector: {
        description: 'Connect two nodes with a directed connector (from -> to).',
        required: ['from', 'to'],
        optional: ['label', 'tempId'],
    },
    removeConnector: { description: 'Remove a connector.', required: ['id'], optional: [] },
    updateNodeMetadata: {
        description: "Change a node's shape type and/or size (at least one of type, width, height).",
        required: ['id'],
        optional: ['type', 'width', 'height'],
    },
    updateConnectorMetadata: {
        description: "Change a connector's label (empty string removes it).",
        required: ['id', 'label'],
        optional: [],
    },
    applyLayout: { description: 'Re-arrange the whole diagram automatically.', required: [], optional: ['mode'] },
};

function operationSchema(op: OperationType): Record<string, unknown> {
    const spec = OPERATION_SPECS[op];
    const properties: Record<string, unknown> = { op: { const: op } };
    for (const field of [...spec.required, ...spec.optional]) {
        properties[field] = FIELD_SCHEMAS[field];
    }
    const schema: Record<string, unknown> = {
        type: 'object',
        description: spec.description,
        properties,
        required: ['op', ...spec.required],
        additionalProperties: false,
    };
    if (op === 'addNode') {
        schema.dependentRequired = { x: ['y'], y: ['x'] };
    } else if (op === 'updateNodeMetadata') {
        schema.minProperties = 3;
    }
    return schema;
}

/** JSON Schema (draft 2020-12) for a batch of operations: a JSON array of operation objects. */
export const OPERATIONS_JSON_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `https://github.com/nabledhq/diagrammerext/schemas/diagram-operations.v${OPERATIONS_SCHEMA_VERSION}.json`,
    title: 'Diagrammer diagram operations',
    schemaVersion: OPERATIONS_SCHEMA_VERSION,
    type: 'array',
    items: { oneOf: OPERATION_TYPES.map(operationSchema) },
} as const;

// ---------------------------------------------------------------------------
// Structural validation
// ---------------------------------------------------------------------------

export type ParseOperationsResult = { ok: true; operations: DiagramOperation[] } | { ok: false; errors: string[] };

function isOperationType(value: unknown): value is OperationType {
    return typeof value === 'string' && (OPERATION_TYPES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fieldProblem(field: Field, value: unknown): string | undefined {
    switch (field) {
        case 'id':
        case 'tempId':
        case 'from':
        case 'to':
            return typeof value === 'string' && value !== '' ? undefined : 'must be a non-empty string';
        case 'label':
            return typeof value === 'string' ? undefined : 'must be a string';
        case 'type':
            return isNodeType(value) ? undefined : `must be one of: ${NODE_TYPES.join(', ')}`;
        case 'x':
        case 'y':
            return typeof value === 'number' && Number.isFinite(value) ? undefined : 'must be a finite number';
        case 'width':
        case 'height':
            return typeof value === 'number' && Number.isFinite(value) && value >= MIN_NODE_SIZE
                ? undefined
                : `must be a finite number >= ${MIN_NODE_SIZE}`;
        case 'mode':
            return isLayoutMode(value) ? undefined : `must be one of: ${LAYOUT_MODES.join(', ')}`;
    }
}

/**
 * Checks that `input` is a well-formed batch: an array (or a JSON string encoding one) of objects
 * with a known `op`, all required fields, no unknown fields and correctly typed values. References
 * to diagram elements are checked by `applyOperations`.
 */
export function parseOperations(input: unknown): ParseOperationsResult {
    let raw = input;
    if (typeof input === 'string') {
        try {
            raw = JSON.parse(input);
        } catch (err) {
            return { ok: false, errors: [`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`] };
        }
    }
    if (!Array.isArray(raw)) {
        return { ok: false, errors: ['Operations must be a JSON array.'] };
    }
    const errors: string[] = [];
    raw.forEach((item, index) => {
        const where = `operations[${index}]`;
        if (!isRecord(item)) {
            errors.push(`${where} must be an object.`);
            return;
        }
        if (!isOperationType(item.op)) {
            errors.push(`${where}: unknown operation ${JSON.stringify(item.op)}; expected one of: ${OPERATION_TYPES.join(', ')}.`);
            return;
        }
        const spec = OPERATION_SPECS[item.op];
        const allowed = new Set<string>(['op', ...spec.required, ...spec.optional]);
        for (const key of Object.keys(item)) {
            if (!allowed.has(key)) {
                errors.push(`${where} (${item.op}): unknown field "${key}".`);
            }
        }
        for (const field of spec.required) {
            if (item[field] === undefined) {
                errors.push(`${where} (${item.op}): missing required field "${field}".`);
            }
        }
        for (const field of [...spec.required, ...spec.optional]) {
            const problem = item[field] === undefined ? undefined : fieldProblem(field, item[field]);
            if (problem) {
                errors.push(`${where} (${item.op}): "${field}" ${problem}.`);
            }
        }
        if (item.op === 'addNode' && (item.x === undefined) !== (item.y === undefined)) {
            errors.push(`${where} (addNode): "x" and "y" must be given together.`);
        }
        if (item.op === 'updateNodeMetadata' && item.type === undefined && item.width === undefined && item.height === undefined) {
            errors.push(`${where} (updateNodeMetadata): give at least one of "type", "width", "height".`);
        }
    });
    return errors.length > 0 ? { ok: false, errors } : { ok: true, operations: raw as DiagramOperation[] };
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

export interface ApplySuccess {
    ok: true;
    diagram: Diagram;
    /** Human-readable description of the batch, one line per change group. */
    summary: string[];
    /** Maps every tempId in the batch to the id it was saved under. */
    idMap: Record<string, string>;
}

export interface ApplyFailure {
    ok: false;
    /** The input diagram, unchanged. */
    diagram: Diagram;
    errors: string[];
}

export type ApplyResult = ApplySuccess | ApplyFailure;

class OperationError extends Error {}

/** Validates a batch without applying it. Returns the list of problems (empty if it would apply). */
export function validateOperations(diagram: Diagram, input: unknown): string[] {
    const result = applyOperations(diagram, input);
    return result.ok ? [] : result.errors;
}

/**
 * Validates and applies a batch of operations in order. Pure and atomic: `diagram` is never
 * mutated, and if any operation is invalid the result carries every problem found and the original
 * diagram. Nodes added without a position are placed with auto layout after the batch.
 */
export function applyOperations(diagram: Diagram, input: unknown): ApplyResult {
    const parsed = parseOperations(input);
    if (!parsed.ok) {
        return { ok: false, diagram, errors: parsed.errors };
    }
    const operations = parsed.operations;

    const reserved = new Set<string>([...diagram.nodes.map((n) => n.id), ...diagram.edges.map((e) => e.id)]);
    for (const op of operations) {
        if ((op.op === 'addNode' || op.op === 'addConnector') && op.tempId !== undefined) {
            reserved.add(op.tempId);
        }
    }
    const freshId = (prefix: string): string => {
        let n = 1;
        while (reserved.has(`${prefix}-${n}`)) {
            n++;
        }
        reserved.add(`${prefix}-${n}`);
        return `${prefix}-${n}`;
    };

    let current = diagram;
    const tempIds = new Map<string, string>();
    const unplaced = new Set<string>();
    const summary = new SummaryBuilder();
    const errors: string[] = [];

    const resolve = (ref: string): string => tempIds.get(ref) ?? ref;
    const nodeRef = (ref: string, field: string): DiagramNode => {
        const node = findNode(current, resolve(ref));
        if (!node) {
            throw new OperationError(`"${field}" refers to missing node "${ref}".`);
        }
        return node;
    };
    const edgeRef = (ref: string): DiagramEdge => {
        const edge = findEdge(current, resolve(ref));
        if (!edge) {
            throw new OperationError(`"id" refers to missing connector "${ref}".`);
        }
        return edge;
    };
    const claimTempId = (tempId: string): void => {
        if (tempIds.has(tempId)) {
            throw new OperationError(`duplicate tempId "${tempId}".`);
        }
        if (diagram.nodes.some((n) => n.id === tempId) || diagram.edges.some((e) => e.id === tempId)) {
            throw new OperationError(`tempId "${tempId}" duplicates an existing id.`);
        }
    };
    const replaceNode = (id: string, update: Partial<DiagramNode>): void => {
        current = { ...current, nodes: current.nodes.map((n) => (n.id === id ? { ...n, ...update } : n)) };
    };
    const labelOf = (id: string): string => findNode(current, id)?.label ?? id;

    operations.forEach((op, index) => {
        try {
            switch (op.op) {
                case 'addNode': {
                    claimTempId(op.tempId);
                    const type = op.type ?? 'rectangle';
                    const defaults = DEFAULT_NODE_SIZES[type];
                    const node: DiagramNode = {
                        id: freshId('node'),
                        type,
                        x: op.x ?? 0,
                        y: op.y ?? 0,
                        width: op.width ?? defaults.width,
                        height: op.height ?? defaults.height,
                        label: op.label,
                    };
                    tempIds.set(op.tempId, node.id);
                    if (op.x === undefined) {
                        unplaced.add(node.id);
                    }
                    current = { ...current, nodes: [...current.nodes, node] };
                    summary.addedNode(node.label);
                    break;
                }
                case 'removeNode': {
                    const node = nodeRef(op.id, 'id');
                    const attached = current.edges.filter((e) => e.from === node.id || e.to === node.id);
                    current = {
                        ...current,
                        nodes: current.nodes.filter((n) => n.id !== node.id),
                        edges: current.edges.filter((e) => e.from !== node.id && e.to !== node.id),
                    };
                    unplaced.delete(node.id);
                    summary.removedNode(node.label, attached.length);
                    break;
                }
                case 'renameNode': {
                    const node = nodeRef(op.id, 'id');
                    replaceNode(node.id, { label: op.label });
                    summary.line(`Rename ${quote(node.label)} → ${quote(op.label)}`);
                    break;
                }
                case 'moveNode': {
                    const node = nodeRef(op.id, 'id');
                    replaceNode(node.id, { x: op.x, y: op.y });
                    unplaced.delete(node.id);
                    summary.movedNode(node.label);
                    break;
                }
                case 'addConnector': {
                    if (op.tempId !== undefined) {
                        claimTempId(op.tempId);
                    }
                    const from = nodeRef(op.from, 'from');
                    const to = nodeRef(op.to, 'to');
                    if (from.id === to.id) {
                        throw new OperationError('a connector cannot connect a node to itself.');
                    }
                    if (current.edges.some((e) => e.from === from.id && e.to === to.id)) {
                        throw new OperationError(`${quote(from.label)} is already connected to ${quote(to.label)}.`);
                    }
                    const edge: DiagramEdge = { id: freshId('edge'), from: from.id, to: to.id };
                    if (op.label) {
                        edge.label = op.label;
                    }
                    if (op.tempId !== undefined) {
                        tempIds.set(op.tempId, edge.id);
                    }
                    current = { ...current, edges: [...current.edges, edge] };
                    summary.line(`Connect ${quote(from.label)} → ${quote(to.label)}${op.label ? ` (${quote(op.label)})` : ''}`);
                    break;
                }
                case 'removeConnector': {
                    const edge = edgeRef(op.id);
                    current = { ...current, edges: current.edges.filter((e) => e.id !== edge.id) };
                    summary.removedConnector(`${quote(labelOf(edge.from))} → ${quote(labelOf(edge.to))}`);
                    break;
                }
                case 'updateNodeMetadata': {
                    const node = nodeRef(op.id, 'id');
                    const update: Partial<DiagramNode> = {};
                    const changes: string[] = [];
                    if (op.type !== undefined) {
                        update.type = op.type;
                        changes.push(`shape ${op.type}`);
                    }
                    if (op.width !== undefined) {
                        update.width = op.width;
                        changes.push(`width ${op.width}`);
                    }
                    if (op.height !== undefined) {
                        update.height = op.height;
                        changes.push(`height ${op.height}`);
                    }
                    replaceNode(node.id, update);
                    summary.line(`Update ${quote(node.label)}: ${changes.join(', ')}`);
                    break;
                }
                case 'updateConnectorMetadata': {
                    const edge = edgeRef(op.id);
                    current = {
                        ...current,
                        edges: current.edges.map((e) => {
                            if (e.id !== edge.id) {
                                return e;
                            }
                            const { label: _old, ...rest } = e;
                            return op.label === '' ? rest : { ...rest, label: op.label };
                        }),
                    };
                    const name = `${quote(labelOf(edge.from))} → ${quote(labelOf(edge.to))}`;
                    summary.line(
                        op.label === '' ? `Remove label of connector ${name}` : `Label connector ${name} ${quote(op.label)}`,
                    );
                    break;
                }
                case 'applyLayout': {
                    const mode = op.mode ?? DEFAULT_LAYOUT_MODE;
                    current = autoLayout(current, { mode });
                    unplaced.clear();
                    summary.line(`Re-layout the diagram (${mode})`);
                    break;
                }
            }
        } catch (err) {
            if (!(err instanceof OperationError)) {
                throw err;
            }
            errors.push(`operations[${index}] (${op.op}): ${err.message}`);
        }
    });

    if (errors.length > 0) {
        return { ok: false, diagram, errors };
    }
    if (unplaced.size > 0) {
        current = placeUnpositioned(current, [...unplaced]);
    }
    return { ok: true, diagram: current, summary: summary.build(), idMap: Object.fromEntries(tempIds) };
}

function quote(label: string): string {
    return JSON.stringify(label.replace(/\s+/g, ' ').trim());
}

/** Collects the change summary: bulk operations are counted, others get one line each. */
class SummaryBuilder {
    private readonly added: string[] = [];
    private readonly removed: string[] = [];
    private attachedRemoved = 0;
    private readonly removedConnectors: string[] = [];
    private readonly moved: string[] = [];
    private readonly lines: string[] = [];

    addedNode(label: string): void {
        this.added.push(label);
    }

    removedNode(label: string, attachedConnectors: number): void {
        this.removed.push(label);
        this.attachedRemoved += attachedConnectors;
    }

    removedConnector(name: string): void {
        this.removedConnectors.push(name);
    }

    movedNode(label: string): void {
        this.moved.push(label);
    }

    line(text: string): void {
        this.lines.push(text);
    }

    build(): string[] {
        const result: string[] = [];
        const list = (labels: string[]) => labels.map(quote).join(', ');
        if (this.added.length > 0) {
            result.push(`Add ${plural(this.added.length, 'node')}: ${list(this.added)}`);
        }
        if (this.removed.length > 0) {
            const attached =
                this.attachedRemoved > 0 ? ` (and ${plural(this.attachedRemoved, 'attached connector')})` : '';
            result.push(`Remove ${plural(this.removed.length, 'node')}: ${list(this.removed)}${attached}`);
        }
        if (this.removedConnectors.length > 0) {
            result.push(`Remove ${plural(this.removedConnectors.length, 'connector')}: ${this.removedConnectors.join(', ')}`);
        }
        if (this.moved.length > 0) {
            result.push(`Move ${plural(this.moved.length, 'node')}: ${list(this.moved)}`);
        }
        return [...result, ...this.lines];
    }
}

function plural(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
