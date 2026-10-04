import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { Diagram, DiagramNode, validateDiagram } from '../../model/diagram';
import { diagramToMermaid, encodeLabel, mermaidIds, mermaidToDiagram } from '../../mermaid/convert';
import { MermaidFlowchart, MermaidParseError, parseMermaid } from '../../mermaid/parse';

const SAMPLE = `%% A sample flowchart
flowchart LR
    A[Start] --> B(Rounded step)
    B --> C{Decision?}
    C -->|yes| D((Done))
    C -- no --> E["Retry #quot;quoted#quot;"]
    E -.-> B; E ==> F
    F --- G
`;

function nodeLabels(fc: MermaidFlowchart): Record<string, string> {
    return Object.fromEntries(fc.nodes.map((n) => [n.id, n.label]));
}

function overlaps(a: DiagramNode, b: DiagramNode): boolean {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function assertNoOverlaps(d: Diagram): void {
    for (let i = 0; i < d.nodes.length; i++) {
        for (let j = i + 1; j < d.nodes.length; j++) {
            assert.ok(!overlaps(d.nodes[i], d.nodes[j]), `${d.nodes[i].label} overlaps ${d.nodes[j].label}`);
        }
    }
}

function byLabel(d: Diagram, label: string): DiagramNode {
    const node = d.nodes.find((n) => n.label === label);
    assert.ok(node, `node "${label}" exists`);
    return node;
}

/** (source label, target label, edge label) tuples of a diagram or parsed flowchart. */
function edgeTuples(d: Diagram | MermaidFlowchart): string[] {
    const label = new Map<string, string>(d.nodes.map((n) => [n.id, n.label]));
    return d.edges.map((e) => JSON.stringify([label.get(e.from), label.get(e.to), e.label ?? ''])).sort();
}

describe('Mermaid parser', () => {
    it('parses nodes, shapes, labels, edges, edge labels and direction', () => {
        const fc = parseMermaid(SAMPLE);
        assert.strictEqual(fc.direction, 'LR');
        assert.deepStrictEqual(fc.warnings, []);
        assert.deepStrictEqual(nodeLabels(fc), {
            A: 'Start',
            B: 'Rounded step',
            C: 'Decision?',
            D: 'Done',
            E: 'Retry "quoted"',
            F: 'F',
            G: 'G',
        });
        assert.deepStrictEqual(
            fc.nodes.map((n) => n.shape),
            ['rectangle', 'rounded', 'diamond', 'circle', 'rectangle', 'rectangle', 'rectangle'],
        );
        assert.deepStrictEqual(
            fc.edges.map((e) => [e.from, e.to, e.label, e.style, e.arrow]),
            [
                ['A', 'B', undefined, 'normal', true],
                ['B', 'C', undefined, 'normal', true],
                ['C', 'D', 'yes', 'normal', true],
                ['C', 'E', 'no', 'normal', true],
                ['E', 'B', undefined, 'dotted', true],
                ['E', 'F', undefined, 'thick', true],
                ['F', 'G', undefined, 'normal', false],
            ],
        );
    });

    it('parses chains, semicolons, graph keyword and default direction', () => {
        const fc = parseMermaid('graph\nA --> B --> C;C-->D');
        assert.strictEqual(fc.direction, 'TD');
        assert.deepStrictEqual(
            fc.edges.map((e) => `${e.from}>${e.to}`),
            ['A>B', 'B>C', 'C>D'],
        );
        assert.strictEqual(parseMermaid('flowchart BT; A-->B').direction, 'BT');
        assert.strictEqual(parseMermaid('graph rl').direction, 'RL');
    });

    it('supports all edge label forms and edge operators', () => {
        const fc = parseMermaid(
            [
                'flowchart TD',
                'A -->|plain| B',
                'A ---|open| C',
                'A -.->|dots| D',
                'A ==>|thick| E',
                'A -- text form --> F',
                'A -. dotted text .-> G',
                'A == thick text ==> H',
                'A -->|"quoted | pipe"| I',
                'A-->J',
            ].join('\n'),
        );
        assert.deepStrictEqual(
            fc.edges.map((e) => [e.to, e.label ?? '', e.style, e.arrow]),
            [
                ['B', 'plain', 'normal', true],
                ['C', 'open', 'normal', false],
                ['D', 'dots', 'dotted', true],
                ['E', 'thick', 'thick', true],
                ['F', 'text form', 'normal', true],
                ['G', 'dotted text', 'dotted', true],
                ['H', 'thick text', 'thick', true],
                ['I', 'quoted | pipe', 'normal', true],
                ['J', '', 'normal', true],
            ],
        );
    });

    it('keeps the explicit label when a node is referenced before or after its declaration', () => {
        const fc = parseMermaid('flowchart TD\nA --> B\nB{Choose}\nB --> A');
        assert.deepStrictEqual(nodeLabels(fc), { A: 'A', B: 'Choose' });
        assert.strictEqual(fc.nodes[1].shape, 'diamond');
        assert.strictEqual(fc.edges.length, 2);
    });

    it('warns about unsupported constructs with their line numbers and still parses the rest', () => {
        const fc = parseMermaid(
            [
                'flowchart TD', //            1
                '    classDef hot fill:#f00', // 2
                '    subgraph one', //          3
                '        A[In sub] --> B', //   4
                '    end', //                   5
                '    %% comment', //            6
                '    B --> C', //               7
                '    style A fill:#f9f', //     8
                '    class A hot', //           9
                '    linkStyle 0 stroke:red', // 10
                '    click A callback', //      11
            ].join('\n'),
        );
        assert.deepStrictEqual(
            fc.warnings.map((w) => [w.construct, w.line]),
            [
                ['classDef', 2],
                ['subgraph', 3],
                ['end', 5],
                ['style', 8],
                ['class', 9],
                ['linkStyle', 10],
                ['click', 11],
            ],
        );
        assert.ok(fc.warnings[0].message.includes('classDef') && fc.warnings[0].message.includes('Line 2'));
        assert.ok(fc.warnings[1].message.includes('subgraph') && fc.warnings[1].message.includes('Line 3'));
        assert.deepStrictEqual(nodeLabels(fc), { A: 'In sub', B: 'B', C: 'C' });
        assert.strictEqual(fc.edges.length, 2);
    });

    it('does not mistake node ids that start with a keyword for constructs', () => {
        const fc = parseMermaid('flowchart TD\nending --> classes\nstyled[Styled]');
        assert.deepStrictEqual(fc.warnings, []);
        assert.deepStrictEqual(nodeLabels(fc), { ending: 'ending', classes: 'classes', styled: 'Styled' });
    });

    it('warns about statements and shapes it cannot handle without failing', () => {
        const fc = parseMermaid('flowchart TD\nA --> B & C\nD[(Database)] --> E\nF --> G');
        assert.strictEqual(fc.warnings.length, 2);
        assert.strictEqual(fc.warnings[0].line, 2);
        assert.ok(fc.warnings[1].message.includes('imported as a rectangle'));
        assert.deepStrictEqual(nodeLabels(fc), { D: 'Database', E: 'E', F: 'F', G: 'G' });
    });

    it('rejects non-flowchart input', () => {
        assert.throws(() => parseMermaid('sequenceDiagram\n    Alice->>Bob: Hi'), MermaidParseError);
        assert.throws(() => parseMermaid('classDiagram\n    Animal <|-- Duck'), /classDiagram/);
        assert.throws(() => parseMermaid('%% comment\nA --> B'), MermaidParseError);
        assert.throws(() => parseMermaid(''), MermaidParseError);
        assert.throws(() => parseMermaid('flowchart XY\nA-->B'), /direction/);
    });

    it('skips comment lines and front matter before the header', () => {
        const fc = parseMermaid('---\ntitle: Demo\n---\n%%{init: {}}%%\nflowchart LR\nA-->B');
        assert.strictEqual(fc.direction, 'LR');
        assert.strictEqual(fc.edges.length, 1);
    });
});

describe('Mermaid import layout', () => {
    const chain = (dir: string) => mermaidToDiagram(parseMermaid(`flowchart ${dir}\nA-->B-->C`));

    it('orders ranks along the direction without overlaps', () => {
        const td = chain('TD');
        assert.ok(byLabel(td, 'A').y < byLabel(td, 'B').y && byLabel(td, 'B').y < byLabel(td, 'C').y);
        const lr = chain('LR');
        assert.ok(byLabel(lr, 'A').x < byLabel(lr, 'B').x && byLabel(lr, 'B').x < byLabel(lr, 'C').x);
        const bt = chain('BT');
        assert.ok(byLabel(bt, 'A').y > byLabel(bt, 'B').y && byLabel(bt, 'B').y > byLabel(bt, 'C').y);
        const rl = chain('RL');
        assert.ok(byLabel(rl, 'A').x > byLabel(rl, 'B').x && byLabel(rl, 'B').x > byLabel(rl, 'C').x);
        for (const d of [td, lr, bt, rl]) {
            assertNoOverlaps(d);
            assert.ok(d.nodes.every((n) => n.x >= 0 && n.y >= 0));
        }
    });

    it('produces a valid diagram with mapped shapes, labels and edge directions', () => {
        const fc = parseMermaid(SAMPLE);
        const d = mermaidToDiagram(fc);
        assert.deepStrictEqual(validateDiagram(JSON.parse(JSON.stringify(d))), d);
        assertNoOverlaps(d);
        const positions = new Set(d.nodes.map((n) => `${n.x},${n.y}`));
        assert.strictEqual(positions.size, d.nodes.length);
        assert.deepStrictEqual(
            d.nodes.map((n) => n.type),
            ['rectangle', 'roundedRectangle', 'diamond', 'ellipse', 'rectangle', 'rectangle', 'rectangle'],
        );
        const circle = byLabel(d, 'Done');
        assert.strictEqual(circle.width, circle.height);
        assert.deepStrictEqual(edgeTuples(d), edgeTuples(fc));
    });
});

describe('Mermaid export', () => {
    const diagram: Diagram = {
        version: 1,
        nodes: [
            { id: 'node-1', type: 'rectangle', x: 0, y: 0, width: 140, height: 70, label: 'Say "hi"' },
            { id: 'node 1', type: 'roundedRectangle', x: 200, y: 0, width: 140, height: 70, label: 'a[b] (c) {d} |e|' },
            { id: 'end', type: 'diamond', x: 0, y: 200, width: 140, height: 100, label: 'Ok?' },
            { id: 'n4', type: 'ellipse', x: 200, y: 200, width: 140, height: 80, label: 'Line 1\nLine 2' },
            { id: 'n5', type: 'sticky', x: 400, y: 200, width: 150, height: 120, label: 'Issue #12; see #quot;' },
            { id: 'n6', type: 'text', x: 400, y: 400, width: 120, height: 30, label: '' },
        ],
        edges: [
            { id: 'e1', from: 'node-1', to: 'node 1', label: 'uses "x" | y' },
            { id: 'e2', from: 'node 1', to: 'end' },
            { id: 'e3', from: 'end', to: 'n4', label: 'yes [1]' },
            { id: 'e4', from: 'end', to: 'n5', label: 'no' },
            { id: 'e5', from: 'n5', to: 'n6' },
        ],
    };

    it('writes a flowchart header and one statement per indented line', () => {
        const text = diagramToMermaid(diagram);
        const lines = text.trimEnd().split('\n');
        assert.strictEqual(lines[0], 'flowchart TD');
        assert.strictEqual(lines.length, 1 + diagram.nodes.length + diagram.edges.length);
        for (const line of lines.slice(1)) {
            assert.match(line, /^ {4}\S/);
        }
        assert.ok(diagramToMermaid(diagram, 'LR').startsWith('flowchart LR\n'));
        assert.deepStrictEqual(lines.slice(1), [
            '    node_1["Say #quot;hi#quot;"]',
            '    node_1_2("a[b] (c) {d} |e|")',
            '    end_{"Ok?"}',
            '    n4(("Line 1<br>Line 2"))',
            '    n5["Issue #35;12; see #35;quot;"]',
            '    n6[""]',
            '    node_1 -->|"uses #quot;x#quot; | y"| node_1_2',
            '    node_1_2 --> end_',
            '    end_ -->|"yes [1]"| n4',
            '    end_ -->|"no"| n5',
            '    n5 --> n6',
        ]);
    });

    it('sanitizes ids and makes collisions unique', () => {
        const ids = mermaidIds(['a-b', 'a_b', 'a.b', '', 'ünï', 'End']);
        assert.deepStrictEqual([...ids.values()], ['a_b', 'a_b_2', 'a_b_3', 'node', '_n_', 'End_']);
        for (const id of ids.values()) {
            assert.match(id, /^[A-Za-z0-9_]+$/);
        }
    });

    it('escapes labels so that they re-parse to the original text', () => {
        for (const label of ['"quoted"', '[brackets]', 'pipe | pipe', '{x} (y)', '#quot; literal', '#35;']) {
            const fc = parseMermaid(`flowchart TD\n    A["${encodeLabel(label)}"] -->|"${encodeLabel(label)}"| B`);
            assert.strictEqual(fc.nodes[0].label, label);
            assert.strictEqual(fc.edges[0].label, label);
        }
    });

    it('round-trips node labels, shapes and (source, target, label) tuples', () => {
        const fc = parseMermaid(diagramToMermaid(diagram));
        assert.deepStrictEqual(fc.warnings, []);
        assert.deepStrictEqual(fc.nodes.map((n) => n.label).sort(), diagram.nodes.map((n) => n.label).sort());
        assert.deepStrictEqual(edgeTuples(fc), edgeTuples(diagram));
        const reimported = mermaidToDiagram(fc);
        assert.deepStrictEqual(
            reimported.nodes.map((n) => n.type),
            ['rectangle', 'roundedRectangle', 'diamond', 'ellipse', 'rectangle', 'rectangle'],
        );
        assert.deepStrictEqual(edgeTuples(reimported), edgeTuples(diagram));
    });

    it('round-trips an imported Mermaid sample through a diagram and back', () => {
        const original = parseMermaid(SAMPLE);
        const again = parseMermaid(diagramToMermaid(mermaidToDiagram(original)));
        assert.deepStrictEqual(again.nodes.map((n) => [n.label, n.shape]), original.nodes.map((n) => [n.label, n.shape]));
        assert.deepStrictEqual(edgeTuples(again), edgeTuples(original));
    });
});

describe('Mermaid commands', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
    const ids = [
        'diagrammer.importMermaidFromText',
        'diagrammer.importMermaidFile',
        'diagrammer.copyAsMermaid',
        'diagrammer.exportMermaidFile',
    ];

    it('are contributed to the command palette', () => {
        const contributed = pkg.contributes.commands.map((c: { command: string }) => c.command);
        const hidden = (pkg.contributes.menus?.commandPalette ?? [])
            .filter((m: { when?: string }) => m.when === 'false')
            .map((m: { command: string }) => m.command);
        for (const id of ids) {
            assert.ok(contributed.includes(id), `${id} is contributed`);
            assert.ok(!hidden.includes(id), `${id} is visible in the palette`);
        }
    });

    it('do not pull in the mermaid package', () => {
        assert.ok(!pkg.dependencies?.mermaid && !pkg.devDependencies?.mermaid);
    });
});
