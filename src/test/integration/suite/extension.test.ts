import * as assert from 'assert';
import * as vscode from 'vscode';
import type { DiagrammerApi } from '../../../extension';
import type { RenderReport } from '../../../diagramEditor';
import { Diagram, parseDiagram, parseDiagramWithPlacement } from '../../../model/diagram';

const VIEW_TYPE = 'diagrammer.diagramEditor';

function workspaceUri(name: string): vscode.Uri {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'tests must run with a workspace folder open');
    return vscode.Uri.joinPath(folder.uri, name);
}

function activeCustomEditorInput(): vscode.TabInputCustom | undefined {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return input instanceof vscode.TabInputCustom ? input : undefined;
}

function activeTab(): vscode.Tab | undefined {
    return vscode.window.tabGroups.activeTabGroup.activeTab;
}

async function readDiagramFile(uri: vscode.Uri): Promise<Diagram> {
    return parseDiagram(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
}

function assertNoOverlaps(d: Diagram): void {
    for (const a of d.nodes) {
        for (const b of d.nodes) {
            if (a !== b) {
                const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
                assert.ok(!overlap, `${a.id} overlaps ${b.id}`);
            }
        }
    }
}

async function waitFor<T>(what: string, check: () => T | undefined, timeoutMs = 10000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = check();
        if (value !== undefined) {
            return value;
        }
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Timed out waiting for ${what}`);
}

describe('Diagrammer extension', () => {
    let api: DiagrammerApi;

    before(async () => {
        const extension = vscode.extensions.getExtension<DiagrammerApi>('nabled.diagrammer');
        assert.ok(extension, 'extension should be installed');
        api = await extension.activate();
    });

    afterEach(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    it('registers the Diagrammer: New Diagram command', async () => {
        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes('diagrammer.newDiagram'));
    });

    it('opens .diagram.json files in the custom editor and renders their nodes and edges', async () => {
        const uri = workspaceUri('sample.diagram.json');
        const rendered = new Promise<RenderReport>((resolve) => {
            const sub = api.onDidRender((report) => {
                if (report.uri.toString() === uri.toString()) {
                    sub.dispose();
                    resolve(report);
                }
            });
        });

        // Plain "open" uses the default editor for the file, which should be ours.
        await vscode.commands.executeCommand('vscode.open', uri);

        const input = await waitFor('custom editor tab', activeCustomEditorInput);
        assert.strictEqual(input.viewType, VIEW_TYPE);
        assert.strictEqual(input.uri.toString(), uri.toString());

        const report = await rendered;
        assert.strictEqual(report.nodes, 3);
        assert.strictEqual(report.edges, 2);
    });

    it('New Diagram creates a valid empty diagram file and opens it', async () => {
        const created = await vscode.commands.executeCommand<vscode.Uri>('diagrammer.newDiagram');
        assert.ok(created);
        assert.ok(created.path.endsWith('/untitled.diagram.json'), created.path);

        const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(created));
        assert.deepStrictEqual(parseDiagram(text), { version: 1, nodes: [], edges: [] });
        assert.deepStrictEqual(JSON.parse(text), { version: 1, nodes: [], edges: [] });

        const input = await waitFor('custom editor tab', activeCustomEditorInput);
        assert.strictEqual(input.viewType, VIEW_TYPE);
        assert.strictEqual(input.uri.toString(), created.toString());

        // A second invocation must not overwrite the first file.
        const second = await vscode.commands.executeCommand<vscode.Uri>('diagrammer.newDiagram');
        assert.ok(second?.path.endsWith('/untitled-1.diagram.json'), second?.path);
    });

    it('registers the auto layout commands', async () => {
        const commands = await vscode.commands.getCommands(true);
        for (const command of ['diagrammer.autoLayout', 'diagrammer.autoLayoutTopToBottom', 'diagrammer.autoLayoutLeftToRight']) {
            assert.ok(commands.includes(command), command);
        }
    });

    it('places nodes without coordinates on open, and keeps the saved positions on reload', async () => {
        const uri = workspaceUri('unpositioned.diagram.json');
        assert.strictEqual(
            parseDiagramWithPlacement(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri))).unpositioned.length,
            6,
        );
        await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
        await waitFor('auto placement to dirty the document', () => (activeTab()?.isDirty ? true : undefined));
        await vscode.commands.executeCommand('workbench.action.files.save');

        const saved = await readDiagramFile(uri);
        const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
        assert.deepStrictEqual(parseDiagramWithPlacement(text).unpositioned, []);
        assertNoOverlaps(saved);

        // Reopening a fully positioned diagram must not lay it out again.
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
        await waitFor('custom editor tab', activeCustomEditorInput);
        await new Promise((r) => setTimeout(r, 500));
        assert.strictEqual(activeTab()?.isDirty, false);
    });

    it('Auto Layout commands lay out the active diagram as an undoable edit that saves to JSON', async () => {
        const uri = workspaceUri('sample.diagram.json');
        const original = await readDiagramFile(uri);
        await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
        await waitFor('custom editor tab', activeCustomEditorInput);

        const changed = await vscode.commands.executeCommand<boolean>('diagrammer.autoLayoutLeftToRight');
        assert.strictEqual(changed, true);
        assert.strictEqual(activeTab()?.isDirty, true);

        await vscode.commands.executeCommand('undo');
        await waitFor('undo to clean the document', () => (activeTab()?.isDirty === false ? true : undefined));
        await vscode.commands.executeCommand('redo');
        await waitFor('redo to dirty the document', () => (activeTab()?.isDirty ? true : undefined));

        await vscode.commands.executeCommand('workbench.action.files.save');
        const saved = await readDiagramFile(uri);
        assert.notDeepStrictEqual(saved, original);
        assertNoOverlaps(saved);
        for (const edge of saved.edges) {
            const from = saved.nodes.find((n) => n.id === edge.from);
            const to = saved.nodes.find((n) => n.id === edge.to);
            assert.ok(from && to && to.x > from.x, `${edge.from} -> ${edge.to} should point right`);
        }
        // Same ids, labels and connectors; only positions differ.
        assert.deepStrictEqual(
            saved.nodes.map(({ x: _x, y: _y, ...rest }) => rest),
            original.nodes.map(({ x: _x, y: _y, ...rest }) => rest),
        );
        assert.deepStrictEqual(saved.edges, original.edges);

        // Running the default layout twice in a row only changes the diagram once.
        assert.strictEqual(await vscode.commands.executeCommand<boolean>('diagrammer.autoLayout'), true);
        assert.strictEqual(await vscode.commands.executeCommand<boolean>('diagrammer.autoLayout'), false);
        // Leave no dirty editor behind, so closing it does not prompt.
        await vscode.commands.executeCommand('workbench.action.files.revert');
    });

    it('registers the AI editing commands', async () => {
        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes('diagrammer.editWithAI'));
        assert.ok(commands.includes('diagrammer.applyOperations'));
    });

    it('diagrammer.applyOperations applies valid batches as undoable edits and rejects invalid ones', async () => {
        const uri = workspaceUri('sample.diagram.json');
        const original = await readDiagramFile(uri);
        await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
        await waitFor('custom editor tab', activeCustomEditorInput);

        const invalid = await vscode.commands.executeCommand<{ errors?: string[] }>('diagrammer.applyOperations', [
            { op: 'renameNode', id: 'node-2', label: 'Public API' },
            { op: 'removeNode', id: 'missing' },
        ]);
        assert.ok(invalid.errors && invalid.errors.length === 1, JSON.stringify(invalid));
        assert.strictEqual(activeTab()?.isDirty, false);

        const result = await vscode.commands.executeCommand<{ summary?: string[]; idMap?: Record<string, string> }>(
            'diagrammer.applyOperations',
            uri,
            [
                { op: 'renameNode', id: 'node-2', label: 'Public API' },
                { op: 'addNode', tempId: 'queue', label: 'Queue' },
                { op: 'addConnector', from: 'node-2', to: 'queue' },
            ],
        );
        assert.deepStrictEqual(result.summary, ['Add 1 node: "Queue"', 'Rename "API" → "Public API"', 'Connect "API" → "Queue"']);
        assert.strictEqual(activeTab()?.isDirty, true);

        await vscode.commands.executeCommand('undo');
        await waitFor('undo to clean the document', () => (activeTab()?.isDirty === false ? true : undefined));
        await vscode.commands.executeCommand('redo');
        await waitFor('redo to dirty the document', () => (activeTab()?.isDirty ? true : undefined));
        await vscode.commands.executeCommand('workbench.action.files.save');

        const saved = await readDiagramFile(uri);
        const queueId = result.idMap?.queue;
        assert.ok(queueId);
        assert.strictEqual(saved.nodes.find((n) => n.id === 'node-2')?.label, 'Public API');
        assert.ok(saved.nodes.some((n) => n.id === queueId && n.label === 'Queue'));
        assert.ok(saved.edges.some((e) => e.from === 'node-2' && e.to === queueId));
        assert.strictEqual(saved.edges.length, original.edges.length + 1);
    });

    it('opens malformed files without throwing and leaves them untouched', async () => {
        const uri = workspaceUri('broken.diagram.json');
        const before = await vscode.workspace.fs.readFile(uri);
        await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
        const input = await waitFor('custom editor tab', activeCustomEditorInput);
        assert.strictEqual(input.uri.toString(), uri.toString());
        await vscode.commands.executeCommand('workbench.action.files.save');
        const after = await vscode.workspace.fs.readFile(uri);
        assert.deepStrictEqual(Buffer.from(after), Buffer.from(before));
    });
});
