import * as vscode from 'vscode';
import { createEmptyDiagram, Diagram, serializeDiagram } from './model/diagram';
import { DIAGRAM_EDITOR_VIEW_TYPE } from './diagramEditor';

export const NEW_DIAGRAM_COMMAND = 'diagrammer.newDiagram';

/**
 * Creates `untitled.diagram.json` (or `untitled-N.diagram.json` if that name is taken) in the first
 * workspace folder, writes an empty diagram into it and opens it in the diagram editor.
 * Without an open workspace folder the user is asked where to save the file.
 */
export async function newDiagram(): Promise<vscode.Uri | undefined> {
    return createDiagramFile(createEmptyDiagram(), { title: 'New Diagram' });
}

export interface CreateDiagramFileOptions {
    /** File name without `.diagram.json`; defaults to `untitled`. */
    baseName?: string;
    /** Folder for the new file; defaults to the first workspace folder. */
    folder?: vscode.Uri;
    /** Title of the save dialog shown when there is no folder. */
    title: string;
}

/**
 * Writes `diagram` to a new `<baseName>.diagram.json` (or `<baseName>-N.diagram.json` if taken) and
 * opens it in the diagram editor. Never overwrites an existing file. Without a folder the user is
 * asked where to save it; returns `undefined` if they cancel.
 */
export async function createDiagramFile(
    diagram: Diagram,
    options: CreateDiagramFileOptions,
): Promise<vscode.Uri | undefined> {
    const baseName = options.baseName ?? 'untitled';
    const folder = options.folder ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    let target: vscode.Uri | undefined;
    if (folder) {
        target = await findFreeUri(folder, baseName);
    } else {
        target = await vscode.window.showSaveDialog({
            title: options.title,
            saveLabel: 'Create Diagram',
            filters: { Diagram: ['diagram.json'] },
        });
    }
    if (!target) {
        return undefined;
    }

    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(serializeDiagram(diagram)));
    await vscode.commands.executeCommand('vscode.openWith', target, DIAGRAM_EDITOR_VIEW_TYPE);
    return target;
}

async function findFreeUri(folder: vscode.Uri, baseName: string): Promise<vscode.Uri> {
    for (let i = 0; ; i++) {
        const name = i === 0 ? `${baseName}.diagram.json` : `${baseName}-${i}.diagram.json`;
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
