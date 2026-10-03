import * as assert from 'assert';
import {
    addEdge,
    addNode,
    boundaryPoint,
    createEmptyDiagram,
    createNode,
    Diagram,
    DiagramNode,
    DiagramParseError,
    edgesForNode,
    getEdgeEndpoints,
    hitTestNode,
    moveNode,
    nextId,
    parseDiagram,
    removeEdge,
    removeElement,
    removeNode,
    serializeDiagram,
    setLabel,
} from '../../model/diagram';

function node(id: string, x: number, y: number, overrides: Partial<DiagramNode> = {}): DiagramNode {
    return { id, type: 'rectangle', x, y, width: 100, height: 50, label: id, ...overrides };
}

function sampleDiagram(): Diagram {
    let d = createEmptyDiagram();
    d = addNode(d, node('a', 0, 0));
    d = addNode(d, node('b', 300, 0, { type: 'ellipse' }));
    d = addNode(d, node('c', 0, 300, { type: 'diamond' }));
    d = addEdge(d, 'a', 'b', { id: 'e1', label: 'calls' });
    d = addEdge(d, 'b', 'c', { id: 'e2' });
    d = addEdge(d, 'c', 'a', { id: 'e3' });
    return d;
}

describe('diagram model', () => {
    describe('serialization', () => {
        it('round-trips a diagram through serialize/parse', () => {
            const original = sampleDiagram();
            const text = serializeDiagram(original);
            const parsed = parseDiagram(text);
            assert.deepStrictEqual(parsed, original);
            assert.strictEqual(serializeDiagram(parsed), text);
        });

        it('round-trips every node type', () => {
            let d = createEmptyDiagram();
            const types = ['rectangle', 'roundedRectangle', 'ellipse', 'diamond', 'text', 'sticky'] as const;
            types.forEach((type, i) => {
                d = addNode(d, createNode(d, type, { x: 100 * i + 100, y: 100 }));
            });
            assert.deepStrictEqual(parseDiagram(serializeDiagram(d)), d);
            assert.deepStrictEqual(
                parseDiagram(serializeDiagram(d)).nodes.map((n) => n.type),
                [...types],
            );
        });

        it('serializes to the documented file format', () => {
            const json = JSON.parse(serializeDiagram(sampleDiagram()));
            assert.deepStrictEqual(Object.keys(json), ['version', 'nodes', 'edges']);
            assert.strictEqual(json.version, 1);
            assert.deepStrictEqual(Object.keys(json.nodes[0]).sort(), ['height', 'id', 'label', 'type', 'width', 'x', 'y']);
            assert.deepStrictEqual(json.edges[0], { id: 'e1', from: 'a', to: 'b', label: 'calls' });
            // Optional edge label is omitted when absent.
            assert.deepStrictEqual(json.edges[1], { id: 'e2', from: 'b', to: 'c' });
        });

        it('serializes an empty diagram that parses back', () => {
            const text = serializeDiagram(createEmptyDiagram());
            assert.deepStrictEqual(JSON.parse(text), { version: 1, nodes: [], edges: [] });
            assert.deepStrictEqual(parseDiagram(text), createEmptyDiagram());
        });

        it('treats an empty file as an empty diagram', () => {
            assert.deepStrictEqual(parseDiagram(''), createEmptyDiagram());
            assert.deepStrictEqual(parseDiagram('  \n'), createEmptyDiagram());
        });

        it('fills in missing optional fields', () => {
            const d = parseDiagram('{"nodes":[{"id":"a","type":"text","x":1,"y":2,"width":30,"height":20}]}');
            assert.strictEqual(d.version, 1);
            assert.strictEqual(d.nodes[0].label, '');
            assert.deepStrictEqual(d.edges, []);
        });
    });

    describe('malformed input', () => {
        const cases: [string, string][] = [
            ['invalid JSON syntax', '{ "nodes": ['],
            ['a non-object root', '[1, 2, 3]'],
            ['a null root', 'null'],
            ['nodes that are not an array', '{"version":1,"nodes":{},"edges":[]}'],
            ['edges that are not an array', '{"version":1,"nodes":[],"edges":"x"}'],
            ['an unsupported future version', '{"version":99,"nodes":[],"edges":[]}'],
            ['a non-numeric version', '{"version":"1","nodes":[],"edges":[]}'],
            ['an unknown node type', '{"version":1,"nodes":[{"id":"a","type":"hexagon","x":0,"y":0,"width":1,"height":1,"label":""}],"edges":[]}'],
            ['a node with a missing coordinate', '{"version":1,"nodes":[{"id":"a","type":"rectangle","y":0,"width":10,"height":10,"label":""}],"edges":[]}'],
            ['a node with a string coordinate', '{"version":1,"nodes":[{"id":"a","type":"rectangle","x":"0","y":0,"width":10,"height":10,"label":""}],"edges":[]}'],
            ['a node without an id', '{"version":1,"nodes":[{"type":"rectangle","x":0,"y":0,"width":10,"height":10,"label":""}],"edges":[]}'],
            ['a non-string label', '{"version":1,"nodes":[{"id":"a","type":"rectangle","x":0,"y":0,"width":10,"height":10,"label":5}],"edges":[]}'],
            ['duplicate node ids', '{"version":1,"nodes":[{"id":"a","type":"rectangle","x":0,"y":0,"width":10,"height":10,"label":""},{"id":"a","type":"rectangle","x":0,"y":0,"width":10,"height":10,"label":""}],"edges":[]}'],
            ['an edge without endpoints', '{"version":1,"nodes":[],"edges":[{"id":"e"}]}'],
        ];
        for (const [name, text] of cases) {
            it(`rejects ${name} with a DiagramParseError`, () => {
                assert.throws(() => parseDiagram(text), DiagramParseError);
            });
        }

        it('drops edges that reference unknown nodes instead of failing', () => {
            const d = parseDiagram(
                JSON.stringify({
                    version: 1,
                    nodes: [node('a', 0, 0), node('b', 200, 0)],
                    edges: [
                        { id: 'ok', from: 'a', to: 'b' },
                        { id: 'dangling', from: 'a', to: 'missing' },
                    ],
                }),
            );
            assert.deepStrictEqual(
                d.edges.map((e) => e.id),
                ['ok'],
            );
        });

        it('ignores unknown extra properties', () => {
            const d = parseDiagram(
                JSON.stringify({ version: 1, extra: true, nodes: [{ ...node('a', 0, 0), color: 'red' }], edges: [] }),
            );
            assert.deepStrictEqual(d.nodes, [node('a', 0, 0)]);
        });
    });

    describe('adding and removing', () => {
        it('adds nodes without mutating the original diagram', () => {
            const empty = createEmptyDiagram();
            const d = addNode(empty, node('a', 0, 0));
            assert.strictEqual(empty.nodes.length, 0);
            assert.deepStrictEqual(d.nodes, [node('a', 0, 0)]);
        });

        it('rejects a node whose id is already used', () => {
            const d = addNode(createEmptyDiagram(), node('a', 0, 0));
            assert.throws(() => addNode(d, node('a', 10, 10)));
        });

        it('creates nodes with unique ids and default sizes centred on the drop point', () => {
            let d = createEmptyDiagram();
            const first = createNode(d, 'rectangle', { x: 200, y: 100 });
            d = addNode(d, first);
            const second = createNode(d, 'sticky', { x: 400, y: 100 });
            d = addNode(d, second);
            assert.notStrictEqual(first.id, second.id);
            assert.strictEqual(first.x + first.width / 2, 200);
            assert.strictEqual(first.y + first.height / 2, 100);
            assert.ok(first.label.length > 0);
        });

        it('generates ids that do not collide with existing ones', () => {
            let d = addNode(createEmptyDiagram(), node('node-1', 0, 0));
            d = addNode(d, node('node-7', 0, 0));
            assert.strictEqual(nextId(d, 'node'), 'node-8');
            assert.strictEqual(nextId(d, 'edge'), 'edge-1');
        });

        it('adds edges between existing nodes', () => {
            let d = addNode(addNode(createEmptyDiagram(), node('a', 0, 0)), node('b', 200, 0));
            d = addEdge(d, 'a', 'b');
            assert.strictEqual(d.edges.length, 1);
            assert.strictEqual(d.edges[0].from, 'a');
            assert.strictEqual(d.edges[0].to, 'b');
            assert.strictEqual(d.edges[0].label, undefined);
        });

        it('ignores edges to unknown nodes, self-loops and duplicates', () => {
            let d = addNode(addNode(createEmptyDiagram(), node('a', 0, 0)), node('b', 200, 0));
            d = addEdge(d, 'a', 'b');
            assert.strictEqual(addEdge(d, 'a', 'missing'), d);
            assert.strictEqual(addEdge(d, 'a', 'a'), d);
            assert.strictEqual(addEdge(d, 'a', 'b'), d);
            assert.strictEqual(addEdge(d, 'b', 'a').edges.length, 2);
        });

        it('removes an edge without touching nodes', () => {
            const d = removeEdge(sampleDiagram(), 'e1');
            assert.deepStrictEqual(
                d.edges.map((e) => e.id),
                ['e2', 'e3'],
            );
            assert.strictEqual(d.nodes.length, 3);
        });

        it('cascades node deletion to every connected edge', () => {
            const before = sampleDiagram();
            const d = removeNode(before, 'b');
            assert.deepStrictEqual(
                d.nodes.map((n) => n.id),
                ['a', 'c'],
            );
            // e1 (a->b) and e2 (b->c) both touch b; only e3 (c->a) survives.
            assert.deepStrictEqual(
                d.edges.map((e) => e.id),
                ['e3'],
            );
            assert.deepStrictEqual(edgesForNode(d, 'b'), []);
            // The original is untouched (needed for undo snapshots).
            assert.strictEqual(before.nodes.length, 3);
            assert.strictEqual(before.edges.length, 3);
        });

        it('removeElement deletes nodes (with edges) or edges by id', () => {
            assert.strictEqual(removeElement(sampleDiagram(), 'a').edges.length, 1);
            assert.strictEqual(removeElement(sampleDiagram(), 'e2').edges.length, 2);
            assert.strictEqual(removeElement(sampleDiagram(), 'e2').nodes.length, 3);
        });

        it('returns the same diagram when removing unknown ids', () => {
            const d = sampleDiagram();
            assert.strictEqual(removeNode(d, 'nope'), d);
            assert.strictEqual(removeEdge(d, 'nope'), d);
        });
    });

    describe('labels', () => {
        it('sets node and edge labels', () => {
            let d = setLabel(sampleDiagram(), 'a', 'Start');
            d = setLabel(d, 'e2', 'then');
            assert.strictEqual(d.nodes[0].label, 'Start');
            assert.strictEqual(d.edges[1].label, 'then');
        });

        it('clearing an edge label removes the property', () => {
            const d = setLabel(sampleDiagram(), 'e1', '');
            assert.strictEqual('label' in d.edges[0], false);
        });
    });

    describe('moving nodes', () => {
        it('updates the node position', () => {
            const d = moveNode(sampleDiagram(), 'a', 40, 60);
            assert.strictEqual(d.nodes[0].x, 40);
            assert.strictEqual(d.nodes[0].y, 60);
        });

        it('keeps connected edge endpoints attached to the moved node', () => {
            let d = createEmptyDiagram();
            d = addNode(d, node('a', 0, 0)); // centre (50, 25)
            d = addNode(d, node('b', 300, 0)); // centre (350, 25)
            d = addEdge(d, 'a', 'b', { id: 'e' });

            const before = getEdgeEndpoints(d, d.edges[0]);
            assert.deepStrictEqual(before, { start: { x: 100, y: 25 }, end: { x: 300, y: 25 } });

            // Move the target node below the source: the edge should now leave a's bottom side
            // and enter b's top side.
            d = moveNode(d, 'b', 0, 300); // centre (50, 325)
            const afterTargetMove = getEdgeEndpoints(d, d.edges[0]);
            assert.deepStrictEqual(afterTargetMove, { start: { x: 50, y: 50 }, end: { x: 50, y: 300 } });

            // Move the source node too: both ends follow.
            d = moveNode(d, 'a', 400, 300); // centre (450, 325)
            const afterSourceMove = getEdgeEndpoints(d, d.edges[0]);
            assert.deepStrictEqual(afterSourceMove, { start: { x: 400, y: 325 }, end: { x: 100, y: 325 } });
        });

        it('returns no endpoints when a node is missing', () => {
            const d = sampleDiagram();
            assert.strictEqual(getEdgeEndpoints(d, { id: 'x', from: 'a', to: 'missing' }), undefined);
        });
    });

    describe('geometry', () => {
        it('clips to the outline of ellipses and diamonds', () => {
            const ellipse = node('e', 0, 0, { type: 'ellipse', width: 100, height: 50 });
            const diamond = node('d', 0, 0, { type: 'diamond', width: 100, height: 50 });
            assert.deepStrictEqual(boundaryPoint(ellipse, { x: 500, y: 25 }), { x: 100, y: 25 });
            assert.deepStrictEqual(boundaryPoint(diamond, { x: 50, y: -500 }), { x: 50, y: 0 });
            // Diagonal towards a corner of the diamond's bounding box hits the midpoint of the edge.
            const p = boundaryPoint(diamond, { x: 150, y: 75 });
            assert.ok(Math.abs(p.x - 75) < 1e-9 && Math.abs(p.y - 37.5) < 1e-9);
        });

        it('hit-tests the top-most node and supports exclusion', () => {
            let d = addNode(createEmptyDiagram(), node('below', 0, 0));
            d = addNode(d, node('above', 50, 0));
            assert.strictEqual(hitTestNode(d, { x: 60, y: 10 })?.id, 'above');
            assert.strictEqual(hitTestNode(d, { x: 60, y: 10 }, 'above')?.id, 'below');
            assert.strictEqual(hitTestNode(d, { x: 500, y: 500 }), undefined);
        });
    });
});
