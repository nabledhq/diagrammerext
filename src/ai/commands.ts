import * as vscode from 'vscode';
import type { DiagramEditorProvider } from '../diagramEditor';
import { AIEditOutcome, AIEditUI, runAIEdit } from './editSession';
import { applyOperations } from './operations';
import type { DiagramAIProvider } from './provider';

export const EDIT_WITH_AI_COMMAND = 'diagrammer.editWithAI';
export const APPLY_OPERATIONS_COMMAND = 'diagrammer.applyOperations';

export type ApplyOperationsCommandResult = { summary: string[]; idMap: Record<string, string> } | { errors: string[] };

const APPLY = 'Apply (keep positions)';
const RELAYOUT = 'Apply and Re-layout';

const vscodeUI: AIEditUI = {
    askInstruction: async () =>
        vscode.window.showInputBox({
            title: 'Edit Diagram with AI',
            prompt: 'Describe the change. Selected nodes are sent as context.',
            placeHolder: 'e.g. Add a Redis cache between "API" and "Database"',
            ignoreFocusOut: true,
        }),
    withProgress: async (task) =>
        vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Asking the language model…', cancellable: true },
            (_progress, token) => task(token),
        ),
    confirm: async (summary) => {
        const choice = await vscode.window.showInformationMessage(
            'Apply these AI changes to the diagram?',
            { modal: true, detail: summary.map((line) => `• ${line}`).join('\n') },
            APPLY,
            RELAYOUT,
        );
        return choice === APPLY ? 'apply' : choice === RELAYOUT ? 'relayout' : undefined;
    },
    showError: (message) => void vscode.window.showErrorMessage(message),
    showInfo: (message) => void vscode.window.showInformationMessage(message),
};

/** Registers `diagrammer.editWithAI` and `diagrammer.applyOperations`. */
export function registerAICommands(
    context: vscode.ExtensionContext,
    editors: DiagramEditorProvider,
    aiProvider: DiagramAIProvider,
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(EDIT_WITH_AI_COMMAND, async (uri?: unknown): Promise<AIEditOutcome> => {
            const document = editors.findDocument(uri instanceof vscode.Uri ? uri : undefined);
            if (!document) {
                void vscode.window.showInformationMessage('Open a diagram in the Diagrammer editor to edit it with AI.');
                return 'cancelled';
            }
            if (document.parseError) {
                void vscode.window.showWarningMessage(`Cannot edit ${document.uri.fsPath}: ${document.parseError}`);
                return 'failed';
            }
            const target = {
                get diagram() {
                    return document.diagram;
                },
                selectedNodeIds: editors.selectedNodeIds(document),
                applyEdit: (label: string, diagram: typeof document.diagram) =>
                    editors.applyDocumentEdit(document, label, diagram),
            };
            return runAIEdit(target, aiProvider, vscodeUI);
        }),
        vscode.commands.registerCommand(
            APPLY_OPERATIONS_COMMAND,
            (uriOrOps?: unknown, maybeOps?: unknown): ApplyOperationsCommandResult => {
                const hasUri = uriOrOps instanceof vscode.Uri;
                const document = editors.findDocument(hasUri ? uriOrOps : undefined);
                if (!document) {
                    return { errors: ['No open Diagrammer document. Open the diagram or pass the URI of an open one.'] };
                }
                if (document.parseError) {
                    return { errors: [`Cannot edit ${document.uri.fsPath}: ${document.parseError}`] };
                }
                const result = applyOperations(document.diagram, hasUri ? maybeOps : uriOrOps);
                if (!result.ok) {
                    return { errors: result.errors };
                }
                if (result.diagram !== document.diagram) {
                    editors.applyDocumentEdit(document, 'Apply operations', result.diagram);
                }
                return { summary: result.summary, idMap: result.idMap };
            },
        ),
    );
}
