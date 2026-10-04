import * as vscode from 'vscode';
import { registerAICommands } from './ai/commands';
import { VsCodeLanguageModelProvider } from './ai/vscodeLmProvider';
import { DiagramEditorProvider, RenderReport } from './diagramEditor';
import { LayoutMode } from './layout';
import { registerMermaidCommands } from './mermaid/commands';
import { NEW_DIAGRAM_COMMAND, newDiagram } from './newDiagram';

export interface DiagrammerApi {
    /** Fired whenever a diagram webview finishes rendering. */
    onDidRender: vscode.Event<RenderReport>;
}

/** Auto-layout commands and the mode each one applies (`undefined` = default mode). */
export const AUTO_LAYOUT_COMMANDS: Record<string, LayoutMode | undefined> = {
    'diagrammer.autoLayout': undefined,
    'diagrammer.autoLayoutTopToBottom': 'top-to-bottom',
    'diagrammer.autoLayoutLeftToRight': 'left-to-right',
};

export function activate(context: vscode.ExtensionContext): DiagrammerApi {
    const provider = DiagramEditorProvider.register(context);
    context.subscriptions.push(vscode.commands.registerCommand(NEW_DIAGRAM_COMMAND, newDiagram));
    for (const [command, mode] of Object.entries(AUTO_LAYOUT_COMMANDS)) {
        // An optional URI argument lets scripts and AI agents target a specific open diagram.
        context.subscriptions.push(
            vscode.commands.registerCommand(command, (uri?: unknown) =>
                provider.autoLayoutEditor(mode, uri instanceof vscode.Uri ? uri : undefined),
            ),
        );
    }
    registerAICommands(context, provider, new VsCodeLanguageModelProvider());
    registerMermaidCommands(context, provider);
    return { onDidRender: provider.onDidRender };
}

export function deactivate(): void {
    // Nothing to clean up: everything is registered on the extension context.
}
