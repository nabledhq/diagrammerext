import * as vscode from 'vscode';
import { createEmptyDiagram, serializeDiagram } from './model/diagram';
import { DIAGRAM_EDITOR_VIEW_TYPE } from './diagramEditor';

export const NEW_DIAGRAM_COMMAND = 'diagrammer.newDiagram';

/**
 * Creates `untitled.diagram.json` (or `untitled-N.diagram.json` if that name is taken) in the first
 * workspace folder, writes an empty diagram into it and opens it in the diagram editor.
 * Without an open workspace folder the user is asked where to save the file.
 */
export async function newDiagram(): Promise<vscode.Uri | undefined> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    let target: vscode.Uri | undefined;
    if (folder) {
        target = await findFreeUri(folder.uri);
    } else {
        target = await vscode.window.showSaveDialog({
            title: 'New Diagram',
            saveLabel: 'Create Diagram',
            filters: { Diagram: ['diagram.json'] },
        });
    }
    if (!target) {
        return undefined;
    }

    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(serializeDiagram(createEmptyDiagram())));
    await vscode.commands.executeCommand('vscode.openWith', target, DIAGRAM_EDITOR_VIEW_TYPE);
    return target;
}

async function findFreeUri(folder: vscode.Uri): Promise<vscode.Uri> {
    for (let i = 0; ; i++) {
        const name = i === 0 ? 'untitled.diagram.json' : `untitled-${i}.diagram.json`;
        const candidate = vscode.Uri.joinPath(folder, name);
        if (!(await exists(candidate))) {
            return candidate;
        }
    }
}

async function exists(uri: vscode.Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}
