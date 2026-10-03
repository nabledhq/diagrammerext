import * as assert from 'assert';
import * as vscode from 'vscode';
import type { DiagrammerApi } from '../../../extension';
import type { RenderReport } from '../../../diagramEditor';
import { parseDiagram } from '../../../model/diagram';

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
