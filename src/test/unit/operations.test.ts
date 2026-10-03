import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
    applyOperations,
    ApplyResult,
    ApplySuccess,
    OPERATION_TYPES,
    OPERATIONS_JSON_SCHEMA,
    OPERATIONS_SCHEMA_VERSION,
    parseOperations,
    validateOperations,
} from '../../ai/operations';
import { Diagram, parseDiagram, serializeDiagram } from '../../model/diagram';

function sample(): Diagram {
    return {
        version: 1,
        nodes: [
            { id: 'client', type: 'rectangle', x: 40, y: 40, width: 140, height: 70, label: 'Client' },
            { id: 'api', type: 'ellipse', x: 300, y: 40, width: 140, height: 80, label: 'API' },
            { id: 'db', type: 'rectangle', x: 300, y: 240, width: 140, height: 70, label: 'Database' },
        ],
        edges: [
            { id: 'e1', from: 'client', to: 'api', label: 'HTTP' },
            { id: 'e2', from: 'api', to: 'db' },
        ],
    };
}

function deepFreeze<T>(value: T): T {
    if (typeof value === 'object' && value !== null) {
        Object.values(value).forEach(deepFreeze);
        Object.freeze(value);
    }
    return value;
}

function ok(result: ApplyResult): ApplySuccess {
    assert.ok(result.ok, `expected success, got: ${result.ok ? '' : result.errors.join(' | ')}`);
    return result;
}

function errorsOf(result: ApplyResult): string[] {
    assert.ok(!result.ok, 'expected the batch to be rejected');
    return result.errors;
}

describe('AI operations', () => {
    describe('applyOperations', () => {
        it('addNode creates a node with defaults and places it automatically without overlap', () => {
            const before = deepFreeze(sample());
            const result = ok(applyOperations(before, [{ op: 'addNode', tempId: 'cache', label: 'Cache', type: 'diamond' }]));
            const added = result.diagram.nodes.find((n) => n.id === result.idMap.cache);
            assert.ok(added);
            assert.strictEqual(added.id, 'node-1');
            assert.deepStrictEqual(
                { type: added.type, label: added.label, width: added.width, height: added.height },
                { type: 'diamond', label: 'Cache', width: 140, height: 100 },
            );
            // Placed below the existing nodes.
            assert.ok(added.y > 310, `y=${added.y}`);
            assert.deepStrictEqual(result.summary, ['Add 1 node: "Cache"']);
            // The result is a valid diagram that round-trips through the file format.
            assert.deepStrictEqual(parseDiagram(serializeDiagram(result.diagram)), result.diagram);
        });

        it('addNode keeps explicit positions and sizes', () => {
            const result = ok(
                applyOperations(sample(), [{ op: 'addNode', tempId: 'n', label: 'N', x: 10, y: 20, width: 50, height: 30 }]),
            );
            const added = result.diagram.nodes[3];
            assert.deepStrictEqual(
                { x: added.x, y: added.y, width: added.width, height: added.height, type: added.type },
                { x: 10, y: 20, width: 50, height: 30, type: 'rectangle' },
            );
            assert.deepStrictEqual(result.diagram.nodes.slice(0, 3), sample().nodes, 'existing nodes do not move');
        });

        it('lets later operations reference tempIds of new nodes and connectors', () => {
            const result = ok(
                applyOperations(sample(), [
                    { op: 'addNode', tempId: 'worker', label: 'Worker' },
                    { op: 'addNode', tempId: 'queue', label: 'Queue', type: 'roundedRectangle' },
                    { op: 'addConnector', from: 'worker', to: 'queue', tempId: 'wq' },
                    { op: 'addConnector', from: 'api', to: 'queue', label: 'enqueue' },
                    { op: 'updateConnectorMetadata', id: 'wq', label: 'consume' },
                    { op: 'renameNode', id: 'worker', label: 'Job worker' },
                ]),
            );
            const { worker, queue, wq } = result.idMap;
            assert.deepStrictEqual(result.idMap, { worker: 'node-1', queue: 'node-2', wq: 'edge-1' });
            assert.deepStrictEqual(result.diagram.edges.slice(2), [
                { id: wq, from: worker, to: queue, label: 'consume' },
                { id: 'edge-2', from: 'api', to: queue, label: 'enqueue' },
            ]);
            assert.strictEqual(result.diagram.nodes.find((n) => n.id === worker)?.label, 'Job worker');
            assert.deepStrictEqual(result.summary, [
                'Add 2 nodes: "Worker", "Queue"',
                'Connect "Worker" → "Queue"',
                'Connect "API" → "Queue" ("enqueue")',
                'Label connector "Worker" → "Queue" "consume"',
                'Rename "Worker" → "Job worker"',
            ]);
        });

        it('generated ids never collide with existing ids or tempIds', () => {
            const d = sample();
            d.nodes[0].id = 'node-1';
            d.edges[0].from = 'node-1';
            const result = ok(
                applyOperations(d, [
                    { op: 'addNode', tempId: 'a', label: 'A' },
                    { op: 'addNode', tempId: 'node-2', label: 'B' },
                ]),
            );
            assert.deepStrictEqual(result.idMap, { a: 'node-3', 'node-2': 'node-4' });
        });

        it('removeNode also removes attached connectors', () => {
            const before = deepFreeze(sample());
            const result = ok(applyOperations(before, [{ op: 'removeNode', id: 'api' }]));
            assert.deepStrictEqual(result.diagram.nodes.map((n) => n.id), ['client', 'db']);
            assert.deepStrictEqual(result.diagram.edges, []);
            assert.deepStrictEqual(result.summary, ['Remove 1 node: "API" (and 2 attached connectors)']);
        });

        it('renameNode changes only the label', () => {
            const result = ok(applyOperations(sample(), [{ op: 'renameNode', id: 'api', label: 'Public API' }]));
            assert.deepStrictEqual(result.diagram.nodes[1], { ...sample().nodes[1], label: 'Public API' });
            assert.deepStrictEqual(result.summary, ['Rename "API" → "Public API"']);
        });

        it('moveNode sets the position', () => {
            const result = ok(applyOperations(sample(), [{ op: 'moveNode', id: 'db', x: 600, y: 10 }]));
            assert.deepStrictEqual(result.diagram.nodes[2], { ...sample().nodes[2], x: 600, y: 10 });
            assert.deepStrictEqual(result.summary, ['Move 1 node: "Database"']);
        });

        it('addConnector connects existing nodes', () => {
            const result = ok(applyOperations(sample(), [{ op: 'addConnector', from: 'client', to: 'db' }]));
            assert.deepStrictEqual(result.diagram.edges[2], { id: 'edge-1', from: 'client', to: 'db' });
            assert.deepStrictEqual(result.summary, ['Connect "Client" → "Database"']);
        });

        it('removeConnector removes only that connector', () => {
            const result = ok(applyOperations(sample(), [{ op: 'removeConnector', id: 'e1' }]));
            assert.deepStrictEqual(result.diagram.edges, [sample().edges[1]]);
            assert.deepStrictEqual(result.diagram.nodes, sample().nodes);
            assert.deepStrictEqual(result.summary, ['Remove 1 connector: "Client" → "API"']);
        });

        it('updateNodeMetadata changes type and size', () => {
            const result = ok(
                applyOperations(sample(), [{ op: 'updateNodeMetadata', id: 'db', type: 'ellipse', width: 200 }]),
            );
            assert.deepStrictEqual(result.diagram.nodes[2], { ...sample().nodes[2], type: 'ellipse', width: 200 });
            assert.deepStrictEqual(result.summary, ['Update "Database": shape ellipse, width 200']);
        });

        it('updateConnectorMetadata sets and clears connector labels', () => {
            const result = ok(
                applyOperations(sample(), [
                    { op: 'updateConnectorMetadata', id: 'e1', label: '' },
                    { op: 'updateConnectorMetadata', id: 'e2', label: 'SQL' },
                ]),
            );
            assert.deepStrictEqual(result.diagram.edges, [
                { id: 'e1', from: 'client', to: 'api' },
                { id: 'e2', from: 'api', to: 'db', label: 'SQL' },
            ]);
        });

        it('applyLayout delegates to auto layout', () => {
            const result = ok(applyOperations(sample(), [{ op: 'applyLayout', mode: 'left-to-right' }]));
            const [client, api, db] = result.diagram.nodes;
            assert.ok(client.x < api.x && api.x < db.x, 'connectors point right');
            assert.deepStrictEqual(result.summary, ['Re-layout the diagram (left-to-right)']);
        });

        it('accepts a JSON string and an empty batch', () => {
            const result = ok(applyOperations(sample(), '[{"op":"renameNode","id":"db","label":"DB"}]'));
            assert.strictEqual(result.diagram.nodes[2].label, 'DB');
            const empty = ok(applyOperations(sample(), []));
            assert.deepStrictEqual(empty.summary, []);
            assert.deepStrictEqual(empty.diagram, sample());
        });

        it('is atomic: one invalid operation leaves the diagram byte-identical and unmutated', () => {
            const before = sample();
            const serialized = serializeDiagram(before);
            const snapshot = JSON.parse(JSON.stringify(before));
            const result = applyOperations(before, [
                { op: 'addNode', tempId: 'x', label: 'X' },
                { op: 'removeNode', id: 'api' },
                { op: 'renameNode', id: 'client', label: 'Browser' },
                { op: 'moveNode', id: 'db', x: 1, y: 1 },
                { op: 'addConnector', from: 'x', to: 'nope' },
            ]);
            assert.ok(!result.ok);
            assert.strictEqual(result.diagram, before);
            assert.strictEqual(serializeDiagram(result.diagram), serialized);
            assert.strictEqual(serializeDiagram(before), serialized);
            assert.deepStrictEqual(before, snapshot);
            assert.deepStrictEqual(result.errors, ['operations[4] (addConnector): "to" refers to missing node "nope".']);
        });

        it('never mutates a frozen input diagram', () => {
            const before = deepFreeze(sample());
            assert.doesNotThrow(() =>
                applyOperations(before, [
                    { op: 'addNode', tempId: 'x', label: 'X' },
                    { op: 'updateNodeMetadata', id: 'api', height: 99 },
                    { op: 'updateConnectorMetadata', id: 'e1', label: '' },
                    { op: 'removeConnector', id: 'e2' },
                    { op: 'applyLayout' },
                ]),
            );
        });
    });

    describe('validation', () => {
        it('rejects non-array and unparseable input', () => {
            assert.deepStrictEqual(errorsOf(applyOperations(sample(), { op: 'removeNode', id: 'api' })), [
                'Operations must be a JSON array.',
            ]);
            assert.match(errorsOf(applyOperations(sample(), '[{"op": "removeNode",'))[0], /^Invalid JSON/);
            assert.match(errorsOf(applyOperations(sample(), 'not json'))[0], /^Invalid JSON/);
            assert.deepStrictEqual(errorsOf(applyOperations(sample(), undefined)), ['Operations must be a JSON array.']);
        });

        it('rejects unknown operation types and non-object items', () => {
            const errors = errorsOf(applyOperations(sample(), [{ op: 'groupNodes', ids: ['api'] }, 'removeNode', { id: 'x' }]));
            assert.strictEqual(errors.length, 3);
            assert.match(errors[0], /operations\[0\]: unknown operation "groupNodes"/);
            assert.match(errors[1], /operations\[1\] must be an object/);
            assert.match(errors[2], /operations\[2\]: unknown operation undefined/);
        });

        it('rejects malformed fields', () => {
            const errors = errorsOf(
                applyOperations(sample(), [
                    { op: 'addNode', label: 'No temp id' },
                    { op: 'addNode', tempId: 't', label: 'X', type: 'hexagon' },
                    { op: 'addNode', tempId: 'u', label: 'X', x: 10 },
                    { op: 'moveNode', id: 'api', x: '10', y: Infinity },
                    { op: 'renameNode', id: 'api', label: 'A', colour: 'red' },
                    { op: 'updateNodeMetadata', id: 'api' },
                    { op: 'updateNodeMetadata', id: 'api', width: 2 },
                    { op: 'applyLayout', mode: 'radial' },
                    { op: 'removeNode', id: '' },
                ]),
            );
            const expected = [
                /operations\[0\] \(addNode\): missing required field "tempId"/,
                /operations\[1\] \(addNode\): "type" must be one of/,
                /operations\[2\] \(addNode\): "x" and "y" must be given together/,
                /operations\[3\] \(moveNode\): "x" must be a finite number/,
                /operations\[3\] \(moveNode\): "y" must be a finite number/,
                /operations\[4\] \(renameNode\): unknown field "colour"/,
                /operations\[5\] \(updateNodeMetadata\): give at least one of/,
                /operations\[6\] \(updateNodeMetadata\): "width" must be a finite number >= 10/,
                /operations\[7\] \(applyLayout\): "mode" must be one of/,
                /operations\[8\] \(removeNode\): "id" must be a non-empty string/,
            ];
            assert.strictEqual(errors.length, expected.length, errors.join('\n'));
            expected.forEach((pattern, i) => assert.match(errors[i], pattern));
        });

        it('rejects references to missing ids, including elements removed earlier in the batch', () => {
            const errors = errorsOf(
                applyOperations(sample(), [
                    { op: 'renameNode', id: 'ghost', label: 'X' },
                    { op: 'removeConnector', id: 'api' },
                    { op: 'removeNode', id: 'db' },
                    { op: 'moveNode', id: 'db', x: 0, y: 0 },
                    { op: 'updateConnectorMetadata', id: 'e2', label: 'gone with db' },
                    { op: 'addConnector', from: 'later', to: 'api' },
                    { op: 'addNode', tempId: 'later', label: 'Later' },
                ]),
            );
            assert.deepStrictEqual(errors, [
                'operations[0] (renameNode): "id" refers to missing node "ghost".',
                'operations[1] (removeConnector): "id" refers to missing connector "api".',
                'operations[3] (moveNode): "id" refers to missing node "db".',
                'operations[4] (updateConnectorMetadata): "id" refers to missing connector "e2".',
                'operations[5] (addConnector): "from" refers to missing node "later".',
            ]);
        });

        it('rejects duplicate tempIds and tempIds that reuse existing ids', () => {
            const errors = errorsOf(
                applyOperations(sample(), [
                    { op: 'addNode', tempId: 'n', label: 'A' },
                    { op: 'addNode', tempId: 'n', label: 'B' },
                    { op: 'addNode', tempId: 'api', label: 'C' },
                    { op: 'addConnector', from: 'client', to: 'db', tempId: 'e1' },
                ]),
            );
            assert.deepStrictEqual(errors, [
                'operations[1] (addNode): duplicate tempId "n".',
                'operations[2] (addNode): tempId "api" duplicates an existing id.',
                'operations[3] (addConnector): tempId "e1" duplicates an existing id.',
            ]);
        });

        it('rejects self-loops and duplicate connectors', () => {
            const errors = errorsOf(
                applyOperations(sample(), [
                    { op: 'addConnector', from: 'api', to: 'api' },
                    { op: 'addConnector', from: 'client', to: 'api' },
                ]),
            );
            assert.match(errors[0], /cannot connect a node to itself/);
            assert.match(errors[1], /"Client" is already connected to "API"/);
        });

        it('validateOperations reports problems without applying', () => {
            assert.deepStrictEqual(validateOperations(sample(), [{ op: 'removeNode', id: 'api' }]), []);
            assert.strictEqual(validateOperations(sample(), [{ op: 'removeNode', id: 'nope' }]).length, 1);
            const ops = parseOperations([{ op: 'removeNode', id: 'api' }]);
            assert.ok(ops.ok);
        });
    });

    describe('JSON Schema', () => {
        it('declares its schema version', () => {
            assert.strictEqual(OPERATIONS_JSON_SCHEMA.schemaVersion, OPERATIONS_SCHEMA_VERSION);
            assert.strictEqual(OPERATIONS_JSON_SCHEMA.type, 'array');
        });

        it('has one closed object schema per operation type, matching the validator', () => {
            const variants = OPERATIONS_JSON_SCHEMA.items.oneOf as Record<string, unknown>[];
            assert.deepStrictEqual(
                variants.map((v) => (v.properties as Record<string, { const: string }>).op.const),
                [...OPERATION_TYPES],
            );
            for (const variant of variants) {
                assert.strictEqual(variant.additionalProperties, false);
                const op = (variant.properties as Record<string, { const: string }>).op.const;
                const required = (variant.required as string[]).filter((f) => f !== 'op');
                // Leaving out any required field is rejected by the validator too.
                for (const field of required) {
                    const item: Record<string, unknown> = { op };
                    for (const f of required) {
                        if (f !== field) {
                            item[f] = f === 'x' || f === 'y' ? 1 : 'v';
                        }
                    }
                    const parsed = parseOperations([item]);
                    assert.ok(!parsed.ok && parsed.errors.some((e) => e.includes(`"${field}"`)), `${op}.${field}`);
                }
            }
        });
    });

    describe('docs/operations.md', () => {
        const docs = fs.readFileSync(path.resolve(__dirname, '../../../docs/operations.md'), 'utf8');

        it('documents every operation type and the schema version', () => {
            for (const op of OPERATION_TYPES) {
                assert.ok(docs.includes(`| \`${op}\` |`), op);
            }
            assert.ok(docs.includes(`"schemaVersion": ${OPERATIONS_SCHEMA_VERSION}`));
        });

        it('has an example batch that applies and produces the documented summary', () => {
            const blocks = [...docs.matchAll(/```(\w*)\n([\s\S]*?)```/g)];
            const example = blocks.find((b) => b[1] === 'json')?.[2];
            const summary = blocks.find((b) => b[1] === '')?.[2];
            assert.ok(example && summary);
            const d: Diagram = {
                version: 1,
                nodes: [
                    { id: 'api', type: 'rectangle', x: 0, y: 0, width: 140, height: 70, label: 'API' },
                    { id: 'db', type: 'rectangle', x: 0, y: 200, width: 140, height: 70, label: 'Database' },
                ],
                edges: [],
            };
            assert.deepStrictEqual(ok(applyOperations(d, example)).summary, summary.trim().split('\n'));
        });
    });
});
