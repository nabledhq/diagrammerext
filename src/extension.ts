import * as vscode from 'vscode';
import { DiagramEditorProvider, RenderReport } from './diagramEditor';
import { NEW_DIAGRAM_COMMAND, newDiagram } from './newDiagram';

export interface DiagrammerApi {
    /** Fired whenever a diagram webview finishes rendering. */
    onDidRender: vscode.Event<RenderReport>;
}

export function activate(context: vscode.ExtensionContext): DiagrammerApi {
    const provider = DiagramEditorProvider.register(context);
    context.subscriptions.push(vscode.commands.registerCommand(NEW_DIAGRAM_COMMAND, newDiagram));
    return { onDidRender: provider.onDidRender };
}

export function deactivate(): void {
    // Nothing to clean up: everything is registered on the extension context.
}
