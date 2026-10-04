import * as assert from 'assert';
import { AI_EDIT_LABEL, AIEditChoice, AIEditTarget, AIEditUI, runAIEdit } from '../../ai/editSession';
import { OPERATIONS_JSON_SCHEMA } from '../../ai/operations';
import { buildEditPrompt, extractOperationsJson } from '../../ai/prompt';
import { DiagramAIProvider, NoModelAvailableError } from '../../ai/provider';
import { Diagram, serializeDiagram } from '../../model/diagram';

const SAMPLE: Diagram = {
    version: 1,
    nodes: [
        { id: 'node-1', type: 'rectangle', x: 40, y: 40, width: 140, height: 70, label: 'Worker' },
        { id: 'node-2', type: 'ellipse', x: 300, y: 40, width: 140, height: 80, label: 'API' },
        { id: 'node-3', type: 'rectangle', x: 300, y: 240, width: 140, height: 70, label: 'Queue' },
    ],
    edges: [{ id: 'edge-1', from: 'node-2', to: 'node-3', label: 'enqueue' }],
};

const VALID_OPS = [
    { op: 'renameNode', id: 'node-2', label: 'Public API' },
    { op: 'addConnector', from: 'node-1', to: 'node-3' },
    { op: 'addNode', tempId: 'cache', label: 'Cache' },
];

/** A fake document that behaves like `DiagramDocument`: edits replace the diagram and are recorded. */
class FakeDocument implements AIEditTarget {
    edits: { label: string; diagram: Diagram }[] = [];
    constructor(
        public diagram: Diagram,
        readonly selectedNodeIds: string[] = [],
    ) {}
    applyEdit(label: string, diagram: Diagram): void {
        this.edits.push({ label, diagram });
        this.diagram = diagram;
    }
}

class FakeProvider implements DiagramAIProvider {
    prompts: string[] = [];
    constructor(private readonly reply: string | Error) {}
    async complete(prompt: string): Promise<string> {
        this.prompts.push(prompt);
        if (this.reply instanceof Error) {
            throw this.reply;
        }
        return this.reply;
    }
}

class FakeUI implements AIEditUI {
    summaries: (readonly string[])[] = [];
    errors: string[] = [];
    infos: string[] = [];
    constructor(
        private readonly instruction: string | undefined,
        private readonly choice: AIEditChoice = undefined,
    ) {}
    async askInstruction() {
        return this.instruction;
    }
    withProgress<T>(task: (token: { isCancellationRequested: boolean }) => Promise<T>): Promise<T> {
        return task({ isCancellationRequested: false });
    }
    async confirm(summary: readonly string[]) {
        this.summaries.push(summary);
        return this.choice;
    }
    showError(message: string) {
        this.errors.push(message);
    }
    showInfo(message: string) {
        this.infos.push(message);
    }
}

describe('AI edit prompt', () => {
    it('contains the diagram, the labelled selection, the schema and the output instruction', () => {
        const prompt = buildEditPrompt({ diagram: SAMPLE, selectedNodeIds: ['node-2'], instruction: 'Rename this to Gateway' });
        for (const node of SAMPLE.nodes) {
            assert.ok(prompt.includes(`"id": "${node.id}"`), node.id);
            assert.ok(prompt.includes(`"label": "${node.label}"`), node.label);
        }
        assert.ok(prompt.includes('"from": "node-2"') && prompt.includes('"label": "enqueue"'));
        const selection = prompt.slice(prompt.indexOf('## Selection'), prompt.indexOf('## Operation JSON Schema'));
        assert.ok(selection.includes('"id": "node-2"') && selection.includes('"label": "API"'), selection);
        assert.ok(!selection.includes('node-1'));
        assert.ok(prompt.includes(JSON.stringify(OPERATIONS_JSON_SCHEMA, null, 2)));
        assert.ok(prompt.includes('Rename this to Gateway'));
        assert.match(prompt, /Respond with ONLY a JSON array of operations/);
    });

    it('says when nothing is selected', () => {
        const prompt = buildEditPrompt({ diagram: SAMPLE, selectedNodeIds: [], instruction: 'x' });
        assert.ok(prompt.includes('Nothing is selected.'));
    });

    it('extracts JSON from plain and code-fenced responses', () => {
        assert.strictEqual(extractOperationsJson('  [1]  '), '[1]');
        assert.strictEqual(extractOperationsJson('```json\n[{"op":"applyLayout"}]\n```'), '[{"op":"applyLayout"}]');
        assert.strictEqual(extractOperationsJson('Here you go:\n```\n[]\n```\nDone.'), '[]');
    });
});

describe('Edit with AI flow (mocked provider)', () => {
    it('sends the diagram, selected node ids and schema to the provider', async () => {
        const doc = new FakeDocument(SAMPLE, ['node-1']);
        const provider = new FakeProvider(JSON.stringify(VALID_OPS));
        await runAIEdit(doc, provider, new FakeUI('Connect the worker to the queue'));
        assert.strictEqual(provider.prompts.length, 1);
        const prompt = provider.prompts[0];
        assert.ok(prompt.includes('"id": "node-3"'));
        assert.ok(prompt.includes('## Selection'));
        assert.match(prompt.slice(prompt.indexOf('## Selection')), /"id": "node-1",\s*"label": "Worker"/);
        assert.ok(prompt.includes('"schemaVersion": 1'));
    });

    it('shows a summary and leaves the document unchanged on Cancel', async () => {
        const doc = new FakeDocument(SAMPLE);
        const before = serializeDiagram(doc.diagram);
        const ui = new FakeUI('Rename the API', undefined);
        const outcome = await runAIEdit(doc, new FakeProvider(JSON.stringify(VALID_OPS)), ui);
        assert.strictEqual(outcome, 'cancelled');
        assert.deepStrictEqual(ui.summaries, [
            ['Add 1 node: "Cache"', 'Rename "API" → "Public API"', 'Connect "Worker" → "Queue"'],
        ]);
        assert.deepStrictEqual(doc.edits, []);
        assert.strictEqual(serializeDiagram(doc.diagram), before);
    });

    it('applies the batch as one edit on Apply, keeping positions', async () => {
        const doc = new FakeDocument(SAMPLE);
        const ui = new FakeUI('Rename the API', 'apply');
        const outcome = await runAIEdit(doc, new FakeProvider('```json\n' + JSON.stringify(VALID_OPS) + '\n```'), ui);
        assert.strictEqual(outcome, 'applied');
        assert.strictEqual(doc.edits.length, 1);
        assert.strictEqual(doc.edits[0].label, AI_EDIT_LABEL);
        assert.strictEqual(doc.diagram.nodes[1].label, 'Public API');
        assert.deepStrictEqual(doc.diagram.nodes.slice(0, 3).map((n) => [n.x, n.y]), SAMPLE.nodes.map((n) => [n.x, n.y]));
        assert.ok(doc.diagram.edges.some((e) => e.from === 'node-1' && e.to === 'node-3'));
        assert.deepStrictEqual(ui.errors, []);
    });

    it('re-lays out the diagram when asked', async () => {
        const doc = new FakeDocument(SAMPLE);
        await runAIEdit(doc, new FakeProvider(JSON.stringify(VALID_OPS)), new FakeUI('x', 'relayout'));
        assert.strictEqual(doc.edits.length, 1);
        assert.notDeepStrictEqual(doc.diagram.nodes.slice(0, 3).map((n) => [n.x, n.y]), SAMPLE.nodes.map((n) => [n.x, n.y]));
    });

    for (const [name, reply] of [
        ['unparseable output', 'Sure! I renamed the API for you.'],
        ['a non-array', '{"op":"renameNode","id":"node-2","label":"X"}'],
        ['an unknown operation', '[{"op":"groupNodes","ids":["node-1"]}]'],
        ['a missing id', '[{"op":"renameNode","id":"node-2","label":"X"},{"op":"removeNode","id":"node-9"}]'],
    ] as const) {
        it(`shows an error and does not modify the document for ${name}`, async () => {
            const doc = new FakeDocument(SAMPLE);
            const before = serializeDiagram(doc.diagram);
            const ui = new FakeUI('do it', 'apply');
            assert.strictEqual(await runAIEdit(doc, new FakeProvider(reply), ui), 'failed');
            assert.strictEqual(ui.errors.length, 1);
            assert.match(ui.errors[0], /could not be applied/);
            assert.deepStrictEqual(ui.summaries, [], 'no preview for invalid output');
            assert.deepStrictEqual(doc.edits, []);
            assert.strictEqual(serializeDiagram(doc.diagram), before);
        });
    }

    it('reports provider errors such as a missing model', async () => {
        const doc = new FakeDocument(SAMPLE);
        const ui = new FakeUI('do it', 'apply');
        const outcome = await runAIEdit(doc, new FakeProvider(new NoModelAvailableError('No language model is available.')), ui);
        assert.strictEqual(outcome, 'failed');
        assert.match(ui.errors[0], /No language model is available/);
        assert.deepStrictEqual(doc.edits, []);
    });

    it('does nothing when the instruction is dismissed or empty', async () => {
        for (const instruction of [undefined, '   ']) {
            const provider = new FakeProvider('[]');
            const doc = new FakeDocument(SAMPLE);
            assert.strictEqual(await runAIEdit(doc, provider, new FakeUI(instruction, 'apply')), 'cancelled');
            assert.deepStrictEqual(provider.prompts, []);
            assert.deepStrictEqual(doc.edits, []);
        }
    });

    it('tells the user when the model suggests no changes', async () => {
        const doc = new FakeDocument(SAMPLE);
        const ui = new FakeUI('nothing', 'apply');
        assert.strictEqual(await runAIEdit(doc, new FakeProvider('[]'), ui), 'noChanges');
        assert.deepStrictEqual(ui.summaries, []);
        assert.deepStrictEqual(doc.edits, []);
    });

    it('re-validates against the current diagram if it changed while waiting', async () => {
        const doc = new FakeDocument(SAMPLE);
        const ui = new FakeUI('x', 'apply');
        ui.confirm = async (summary) => {
            ui.summaries.push(summary);
            // The user deleted the API node while the preview was open.
            doc.diagram = { ...SAMPLE, nodes: SAMPLE.nodes.filter((n) => n.id !== 'node-2'), edges: [] };
            return 'apply';
        };
        assert.strictEqual(await runAIEdit(doc, new FakeProvider(JSON.stringify(VALID_OPS)), ui), 'failed');
        assert.match(ui.errors[0], /no longer applies/);
        assert.deepStrictEqual(doc.edits, []);
    });
});
