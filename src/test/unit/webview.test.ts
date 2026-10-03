import * as assert from 'assert';
import * as path from 'path';
import { buildSync } from 'esbuild';
import { JSDOM } from 'jsdom';
import type { Diagram } from '../../model/diagram';
import type { HostToWebviewMessage, WebviewToHostMessage } from '../../protocol';

/**
 * Exercises the real webview bundle inside jsdom: the host side is replaced by a fake
 * `acquireVsCodeApi` that records posted messages.
 */

const webviewSource = buildSync({
    entryPoints: [path.resolve(__dirname, '../../../src/webview/main.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
}).outputFiles[0].text;

const HTML = `<!DOCTYPE html><html><body>
<div id="app"><aside id="palette"></aside>
<div id="canvas-container" tabindex="0"><svg id="canvas" xmlns="http://www.w3.org/2000/svg"></svg></div></div>
<div id="error" hidden></div></body></html>`;

const SAMPLE: Diagram = {
    version: 1,
    nodes: [
        { id: 'node-1', type: 'rectangle', x: 0, y: 0, width: 100, height: 50, label: 'A' },
        { id: 'node-2', type: 'ellipse', x: 300, y: 0, width: 100, height: 50, label: 'B' },
        { id: 'node-3', type: 'diamond', x: 0, y: 300, width: 100, height: 50, label: 'C' },
    ],
    edges: [
        { id: 'edge-1', from: 'node-1', to: 'node-2', label: 'calls' },
        { id: 'edge-2', from: 'node-2', to: 'node-3' },
    ],
};

interface Harness {
    window: JSDOM['window'];
    document: Document;
    sent: WebviewToHostMessage[];
    send(message: HostToWebviewMessage): void;
    lastEdit(): Extract<WebviewToHostMessage, { type: 'edit' }>;
    nodeEl(id: string): Element;
    edgeLine(id: string): Element;
    pointer(type: string, target: EventTarget, x: number, y: number): void;
    container: HTMLElement;
}

function setup(initial: Diagram | null = SAMPLE): Harness {
    const dom = new JSDOM(HTML, { runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = dom;
    const sent: WebviewToHostMessage[] = [];
    const win = window as unknown as Record<string, unknown>;
    win.acquireVsCodeApi = () => ({ postMessage: (m: WebviewToHostMessage) => sent.push(JSON.parse(JSON.stringify(m))) });
    // jsdom has no SVG layout engine.
    (window.SVGElement.prototype as unknown as Record<string, unknown>).getBBox = () => ({ x: 0, y: 0, width: 10, height: 10 });
    window.eval(webviewSource);

    const document = window.document;
    const harness: Harness = {
        window,
        document,
        sent,
        container: document.getElementById('canvas-container') as HTMLElement,
        send(message) {
            window.dispatchEvent(new window.MessageEvent('message', { data: message }));
        },
        lastEdit() {
            const edits = sent.filter((m) => m.type === 'edit');
            assert.ok(edits.length > 0, 'expected an edit message');
            return edits[edits.length - 1] as Extract<WebviewToHostMessage, { type: 'edit' }>;
        },
        nodeEl(id) {
            const el = document.querySelector(`.node[data-id="${id}"]`);
            assert.ok(el, `node ${id} should be rendered`);
            return el;
        },
        edgeLine(id) {
            const el = document.querySelector(`.edge[data-id="${id}"] .edge-line`);
            assert.ok(el, `edge ${id} should be rendered`);
            return el;
        },
        pointer(type, target, x, y) {
            target.dispatchEvent(
                new window.PointerEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }),
            );
        },
    };
    if (initial) {
        harness.send({ type: 'init', diagram: initial });
    }
    return harness;
}

describe('webview canvas', () => {
    it('asks the host for the document when loaded', () => {
        const h = setup(null);
        assert.deepStrictEqual(h.sent, [{ type: 'ready' }]);
    });

    it('renders the palette with all six shapes', () => {
        const h = setup();
        const types = [...h.document.querySelectorAll<HTMLElement>('.palette-item')].map((b) => b.dataset.type);
        assert.deepStrictEqual(types, ['rectangle', 'roundedRectangle', 'ellipse', 'diamond', 'text', 'sticky']);
    });

    it('renders existing nodes, edges and labels and reports the counts', () => {
        const h = setup();
        assert.strictEqual(h.document.querySelectorAll('.node').length, 3);
        assert.strictEqual(h.document.querySelectorAll('.edge').length, 2);
        assert.strictEqual(h.nodeEl('node-2').querySelector('ellipse') !== null, true);
        assert.strictEqual(h.nodeEl('node-3').querySelector('polygon') !== null, true);
        assert.strictEqual(h.nodeEl('node-1').querySelector('.node-label')?.textContent, 'A');
        assert.strictEqual(h.document.querySelector('.edge[data-id="edge-1"] .edge-label')?.textContent, 'calls');
        assert.deepStrictEqual(h.sent[h.sent.length - 1], { type: 'rendered', nodes: 3, edges: 2 });
    });

    it('renders labels as text, never as markup', () => {
        const h = setup({
            version: 1,
            nodes: [{ id: 'x', type: 'text', x: 0, y: 0, width: 50, height: 20, label: '<img src=x onerror=alert(1)>' }],
            edges: [],
        });
        assert.strictEqual(h.document.querySelector('img'), null);
        assert.strictEqual(h.nodeEl('x').textContent, '<img src=x onerror=alert(1)>');
    });

    it('shows an error instead of the canvas for malformed documents', () => {
        const h = setup(null);
        h.send({ type: 'error', message: 'Invalid JSON' });
        assert.strictEqual((h.document.getElementById('app') as HTMLElement).hidden, true);
        assert.strictEqual(h.document.getElementById('error')?.textContent, 'Invalid JSON');
    });

    it('adds a shape dropped from the palette at the drop position', () => {
        const h = setup();
        const drop = new h.window.Event('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(drop, 'dataTransfer', {
            value: { types: ['application/x-diagrammer-shape'], getData: () => 'sticky' },
        });
        Object.assign(drop, { clientX: 500, clientY: 400 });
        h.container.dispatchEvent(drop);

        const edit = h.lastEdit();
        assert.strictEqual(edit.diagram.nodes.length, 4);
        const added = edit.diagram.nodes[3];
        assert.strictEqual(added.type, 'sticky');
        assert.strictEqual(added.x + added.width / 2, 500);
        assert.strictEqual(added.y + added.height / 2, 400);
        assert.strictEqual(h.document.querySelectorAll('.node').length, 4);
    });

    it('moves a node by dragging and keeps its connectors attached', () => {
        const h = setup();
        const before = h.edgeLine('edge-1').getAttribute('x1');
        h.pointer('pointerdown', h.nodeEl('node-1').querySelector('.shape') as Element, 50, 25);
        h.pointer('pointermove', h.window, 90, 225);
        h.pointer('pointerup', h.window, 90, 225);

        const edit = h.lastEdit();
        assert.strictEqual(edit.label, 'Move node');
        const moved = edit.diagram.nodes.find((n) => n.id === 'node-1');
        assert.deepStrictEqual({ x: moved?.x, y: moved?.y }, { x: 40, y: 200 });
        assert.strictEqual(h.nodeEl('node-1').getAttribute('transform'), 'translate(40,200)');
        assert.notStrictEqual(h.edgeLine('edge-1').getAttribute('x1'), before);
        assert.strictEqual(edit.diagram.edges.length, 2);
    });

    it('does not report an edit for a simple click', () => {
        const h = setup();
        const count = h.sent.length;
        h.pointer('pointerdown', h.nodeEl('node-1').querySelector('.shape') as Element, 50, 25);
        h.pointer('pointerup', h.window, 50, 25);
        assert.strictEqual(h.sent.length, count);
        assert.ok(h.nodeEl('node-1').classList.contains('selected'));
    });

    it('creates a connector by dragging from a handle to another node', () => {
        const h = setup();
        const handle = h.nodeEl('node-1').querySelector('.handle') as Element;
        h.pointer('pointerdown', handle, 50, 0);
        h.pointer('pointermove', h.window, 40, 320);
        assert.ok(h.document.querySelector('.edge-preview'), 'a preview line is drawn while connecting');
        h.pointer('pointerup', h.window, 40, 320);

        const edit = h.lastEdit();
        assert.strictEqual(edit.label, 'Add connector');
        assert.deepStrictEqual(
            edit.diagram.edges.map((e) => [e.from, e.to]),
            [
                ['node-1', 'node-2'],
                ['node-2', 'node-3'],
                ['node-1', 'node-3'],
            ],
        );
        assert.strictEqual(h.document.querySelectorAll('.edge').length, 3);
        assert.strictEqual(h.document.querySelector('.edge-preview'), null);
    });

    it('does not create a connector when released over empty canvas', () => {
        const h = setup();
        const count = h.sent.length;
        h.pointer('pointerdown', h.nodeEl('node-1').querySelector('.handle') as Element, 50, 0);
        h.pointer('pointermove', h.window, 700, 700);
        h.pointer('pointerup', h.window, 700, 700);
        assert.strictEqual(h.sent.filter((m) => m.type === 'edit').length, 0);
        assert.strictEqual(h.sent.length, count);
    });

    it('deletes the selected node together with its connectors', () => {
        const h = setup();
        h.pointer('pointerdown', h.nodeEl('node-2').querySelector('.shape') as Element, 350, 25);
        h.pointer('pointerup', h.window, 350, 25);
        h.container.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));

        const edit = h.lastEdit();
        assert.deepStrictEqual(
            edit.diagram.nodes.map((n) => n.id),
            ['node-1', 'node-3'],
        );
        assert.deepStrictEqual(edit.diagram.edges, []);
        assert.strictEqual(h.document.querySelectorAll('.edge').length, 0);
    });

    it('deletes a selected connector', () => {
        const h = setup();
        h.pointer('pointerdown', h.document.querySelector('.edge[data-id="edge-2"] .edge-hit') as Element, 0, 0);
        h.container.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
        const edit = h.lastEdit();
        assert.deepStrictEqual(
            edit.diagram.edges.map((e) => e.id),
            ['edge-1'],
        );
        assert.strictEqual(edit.diagram.nodes.length, 3);
    });

    it('edits a node label on double-click', () => {
        const h = setup();
        h.nodeEl('node-1').dispatchEvent(new h.window.MouseEvent('dblclick', { bubbles: true }));
        const editor = h.document.querySelector('textarea.label-editor') as HTMLTextAreaElement;
        assert.ok(editor, 'label editor should open');
        assert.strictEqual(editor.value, 'A');
        editor.value = 'Renamed';
        editor.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

        const edit = h.lastEdit();
        assert.strictEqual(edit.label, 'Edit label');
        assert.strictEqual(edit.diagram.nodes[0].label, 'Renamed');
        assert.strictEqual(h.document.querySelector('textarea.label-editor'), null);
        assert.strictEqual(h.nodeEl('node-1').querySelector('.node-label')?.textContent, 'Renamed');
    });

    it('edits an edge label on double-click and cancels with Escape', () => {
        const h = setup();
        const edge = h.document.querySelector('.edge[data-id="edge-2"] .edge-hit') as Element;
        edge.dispatchEvent(new h.window.MouseEvent('dblclick', { bubbles: true }));
        let editor = h.document.querySelector('textarea.label-editor') as HTMLTextAreaElement;
        editor.value = 'ignored';
        editor.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        assert.strictEqual(h.sent.filter((m) => m.type === 'edit').length, 0);

        edge.dispatchEvent(new h.window.MouseEvent('dblclick', { bubbles: true }));
        editor = h.document.querySelector('textarea.label-editor') as HTMLTextAreaElement;
        assert.strictEqual(editor.value, '');
        editor.value = 'returns';
        editor.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        assert.strictEqual(h.lastEdit().diagram.edges[1].label, 'returns');
    });

    it('asks the host to apply the default auto layout from the toolbar button', () => {
        const h = setup();
        const button = h.document.getElementById('auto-layout') as HTMLButtonElement;
        assert.ok(button, 'auto layout button should be rendered');
        button.click();
        assert.deepStrictEqual(h.sent[h.sent.length - 1], { type: 'autoLayout' });
        assert.strictEqual(h.sent.filter((m) => m.type === 'edit').length, 0, 'layout is applied by the host');
    });

    it('replaces its state when the host sends an update (undo/redo)', () => {
        const h = setup();
        h.send({ type: 'update', diagram: { ...SAMPLE, nodes: SAMPLE.nodes.slice(0, 1), edges: [] } });
        assert.strictEqual(h.document.querySelectorAll('.node').length, 1);
        assert.strictEqual(h.document.querySelectorAll('.edge').length, 0);
    });
});
