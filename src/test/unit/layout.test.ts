import * as assert from 'assert';
import { Diagram, DiagramNode, parseDiagramWithPlacement, serializeDiagram } from '../../model/diagram';
import {
    autoLayout,
    boundingBox,
    computeLayout,
    DEFAULT_LAYOUT_ORIGIN,
    LAYOUT_MODES,
    LayoutMode,
    placeUnpositioned,
} from '../../layout';

function node(id: string, x = 0, y = 0, overrides: Partial<DiagramNode> = {}): DiagramNode {
    return { id, type: 'rectangle', x, y, width: 120, height: 60, label: `Label ${id}`, ...overrides };
}

function diagramOf(nodes: DiagramNode[], pairs: [string, string][]): Diagram {
    return {
        version: 1,
        nodes,
        edges: pairs.map(([from, to], i) => ({ id: `e${i}`, from, to, label: `edge ${i}` })),
    };
}

/** A 12-node acyclic graph with mixed shapes and sizes. */
function bigDag(): Diagram {
    const types: DiagramNode['type'][] = ['rectangle', 'ellipse', 'diamond', 'sticky', 'text', 'roundedRectangle'];
    const nodes = Array.from({ length: 12 }, (_, i) =>
        node(`n${i}`, 0, 0, { type: types[i % types.length], width: 80 + (i % 4) * 30, height: 30 + (i % 3) * 40 }),
    );
    const pairs: [string, string][] = [
        ['n0', 'n1'], ['n0', 'n2'], ['n0', 'n3'], ['n1', 'n4'], ['n1', 'n5'], ['n2', 'n5'],
        ['n3', 'n6'], ['n4', 'n7'], ['n5', 'n7'], ['n5', 'n8'], ['n6', 'n9'], ['n7', 'n10'],
        ['n8', 'n10'], ['n9', 'n11'], ['n0', 'n11'],
    ];
    return diagramOf(nodes, pairs);
}

function overlaps(a: DiagramNode, b: DiagramNode): boolean {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function assertNoOverlaps(d: Diagram): void {
    for (let i = 0; i < d.nodes.length; i++) {
        for (let j = i + 1; j < d.nodes.length; j++) {
            const a = d.nodes[i];
            const b = d.nodes[j];
            assert.ok(!overlaps(a, b), `${a.id} (${a.x},${a.y}) overlaps ${b.id} (${b.x},${b.y})`);
        }
    }
}

function assertNonNegative(d: Diagram): void {
    for (const n of d.nodes) {
        assert.ok(n.x >= 0 && n.y >= 0, `${n.id} has negative position (${n.x},${n.y})`);
    }
}

/** Everything except x/y. */
function stripPositions(d: Diagram): unknown {
    return { ...d, nodes: d.nodes.map(({ x: _x, y: _y, ...rest }) => rest) };
}

function byId(d: Diagram, id: string): DiagramNode {
    const n = d.nodes.find((candidate) => candidate.id === id);
    assert.ok(n, `missing node ${id}`);
    return n;
}

describe('auto layout', () => {
    for (const mode of LAYOUT_MODES) {
        describe(mode, () => {
            it('produces no overlapping nodes for a 12-node diagram', () => {
                const laidOut = autoLayout(bigDag(), { mode });
                assertNoOverlaps(laidOut);
            });

            it('orders every connector from source to target along the layout axis', () => {
                const laidOut = autoLayout(bigDag(), { mode });
                for (const e of laidOut.edges) {
                    const from = byId(laidOut, e.from);
                    const to = byId(laidOut, e.to);
                    if (mode === 'top-to-bottom') {
                        assert.ok(to.y > from.y, `${e.from} -> ${e.to}: ${to.y} <= ${from.y}`);
                    } else {
                        assert.ok(to.x > from.x, `${e.from} -> ${e.to}: ${to.x} <= ${from.x}`);
                    }
                }
            });

            it('keeps ids, labels, types, sizes, connectors and metadata unchanged', () => {
                const input = bigDag();
                const snapshot = JSON.parse(JSON.stringify(input));
                const laidOut = autoLayout(input, { mode });
                assert.deepStrictEqual(input, snapshot, 'input must not be mutated');
                assert.deepStrictEqual(stripPositions(laidOut), stripPositions(input));
            });

            it('produces non-negative integer positions starting at the default origin', () => {
                const laidOut = autoLayout(bigDag(), { mode });
                assertNonNegative(laidOut);
                for (const n of laidOut.nodes) {
                    assert.ok(Number.isInteger(n.x) && Number.isInteger(n.y));
                }
                const box = boundingBox(laidOut.nodes);
                assert.deepStrictEqual({ x: box.x, y: box.y }, DEFAULT_LAYOUT_ORIGIN);
            });

            it('handles cycles, self-loops and disconnected components without throwing', () => {
                const d = diagramOf(
                    [node('a'), node('b'), node('c'), node('d'), node('e'), node('lonely'), node('f'), node('g')],
                    [['a', 'b'], ['b', 'c'], ['c', 'a'], ['d', 'e'], ['e', 'd'], ['f', 'f'], ['f', 'g'], ['g', 'missing']],
                );
                const laidOut = autoLayout(d, { mode });
                assertNoOverlaps(laidOut);
                assertNonNegative(laidOut);
                assert.strictEqual(laidOut.nodes.length, d.nodes.length);
            });

            it('lays out only the selected subset, anchored at its original top-left', () => {
                const d = bigDag();
                // Spread nodes out so the subset has a non-trivial original bounding box.
                const spread: Diagram = {
                    ...d,
                    nodes: d.nodes.map((n, i) => ({ ...n, x: 1000 + (i % 4) * 300, y: 500 + Math.floor(i / 4) * 250 })),
                };
                const subset = ['n1', 'n4', 'n5', 'n7', 'n10'];
                const before = boundingBox(spread.nodes.filter((n) => subset.includes(n.id)));
                const laidOut = autoLayout(spread, { mode, nodeIds: subset });

                for (const n of spread.nodes) {
                    if (!subset.includes(n.id)) {
                        assert.deepStrictEqual(byId(laidOut, n.id), n, `${n.id} must not move`);
                    }
                }
                const moved = laidOut.nodes.filter((n) => subset.includes(n.id));
                assert.ok(moved.some((n) => n.x !== byId(spread, n.id).x || n.y !== byId(spread, n.id).y));
                const after = boundingBox(moved);
                assert.deepStrictEqual({ x: after.x, y: after.y }, { x: before.x, y: before.y });
                assertNoOverlaps({ ...laidOut, nodes: moved });
            });
        });
    }

    it('computeLayout only returns positions for the requested nodes', () => {
        const positions = computeLayout(bigDag(), { nodeIds: ['n0', 'n1'] });
        assert.deepStrictEqual([...positions.keys()].sort(), ['n0', 'n1']);
        assert.strictEqual(computeLayout({ nodes: [], edges: [] }).size, 0);
    });

    it('clamps an explicit negative origin to 0', () => {
        const positions = computeLayout(bigDag(), { origin: { x: -50, y: -10 } });
        for (const p of positions.values()) {
            assert.ok(p.x >= 0 && p.y >= 0);
        }
    });

    it('returns the same diagram object when nothing moves', () => {
        const once = autoLayout(bigDag());
        assert.strictEqual(autoLayout(once), once);
    });

    describe('placing nodes without coordinates', () => {
        const modes: LayoutMode[] = [...LAYOUT_MODES];

        it('lays out the whole diagram when no node has coordinates', () => {
            const text = JSON.stringify({
                version: 1,
                nodes: Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, type: 'rectangle', label: `Step ${i}` })),
                edges: Array.from({ length: 9 }, (_, i) => ({ id: `e${i}`, from: `n${i}`, to: `n${i + 1}` })),
            });
            const { diagram, unpositioned } = parseDiagramWithPlacement(text);
            assert.strictEqual(unpositioned.length, 10);
            const placed = placeUnpositioned(diagram, unpositioned);
            assertNoOverlaps(placed);
            assertNonNegative(placed);

            // Saving and reloading keeps the positions and needs no further placement.
            const reloaded = parseDiagramWithPlacement(serializeDiagram(placed));
            assert.deepStrictEqual(reloaded.unpositioned, []);
            assert.deepStrictEqual(reloaded.diagram, placed);
            assert.strictEqual(placeUnpositioned(reloaded.diagram, reloaded.unpositioned), reloaded.diagram);
        });

        for (const mode of modes) {
            it(`places only the missing nodes below the positioned ones (${mode})`, () => {
                const text = JSON.stringify({
                    version: 1,
                    nodes: [
                        { id: 'a', type: 'rectangle', x: 300, y: 100, width: 140, height: 70, label: 'A' },
                        { id: 'b', type: 'ellipse', x: 600, y: 400, width: 140, height: 80, label: 'B' },
                        { id: 'c', type: 'diamond', label: 'C' },
                        { id: 'd', type: 'sticky', label: 'D' },
                        { id: 'e', type: 'rectangle', y: 20, label: 'E' },
                        { id: 'f', type: 'text', label: 'F' },
                    ],
                    edges: [
                        { id: 'e1', from: 'a', to: 'c' },
                        { id: 'e2', from: 'c', to: 'd' },
                        { id: 'e3', from: 'c', to: 'e' },
                        { id: 'e4', from: 'b', to: 'f' },
                    ],
                });
                const { diagram, unpositioned } = parseDiagramWithPlacement(text);
                assert.deepStrictEqual(unpositioned, ['c', 'd', 'e', 'f']);
                const placed = placeUnpositioned(diagram, unpositioned, mode);

                assert.deepStrictEqual(byId(placed, 'a'), byId(diagram, 'a'));
                assert.deepStrictEqual(byId(placed, 'b'), byId(diagram, 'b'));
                assertNoOverlaps(placed);
                assertNonNegative(placed);
                const fixedBox = boundingBox([byId(diagram, 'a'), byId(diagram, 'b')]);
                for (const id of unpositioned) {
                    assert.ok(byId(placed, id).y >= fixedBox.y + fixedBox.height, `${id} should be below the existing nodes`);
                    assert.ok(byId(placed, id).x >= fixedBox.x);
                }
            });
        }

        it('never moves anything when every node has coordinates', () => {
            const d = bigDag();
            assert.strictEqual(placeUnpositioned(d, []), d);
        });
    });
});
