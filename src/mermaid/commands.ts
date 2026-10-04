import * as path from 'path';
import * as vscode from 'vscode';
import type { DiagramDocument, DiagramEditorProvider } from '../diagramEditor';
import { createDiagramFile } from '../newDiagram';
import { diagramToMermaid, mermaidToDiagram } from './convert';
import { MermaidParseError, MermaidWarning, parseMermaid } from './parse';

export const IMPORT_MERMAID_TEXT_COMMAND = 'diagrammer.importMermaidFromText';
export const IMPORT_MERMAID_FILE_COMMAND = 'diagrammer.importMermaidFile';
export const COPY_AS_MERMAID_COMMAND = 'diagrammer.copyAsMermaid';
export const EXPORT_MERMAID_FILE_COMMAND = 'diagrammer.exportMermaidFile';

const MERMAID_FILE_FILTERS = { Mermaid: ['mmd', 'mermaid'] };
const SHOW_WARNINGS = 'Show Warnings';

/**
 * Registers the Mermaid import/export commands. Each command also accepts an optional `Uri`
 * argument so scripts and agents can skip the dialogs:
 * - import file: the `.mmd` file to import;
 * - copy/export: the open diagram to export (defaults to the active Diagrammer editor);
 * - export file: a second `Uri` for the target file.
 */
export function registerMermaidCommands(context: vscode.ExtensionContext, editors: DiagramEditorProvider): void {
    let output: vscode.OutputChannel | undefined;
    const showWarnings = (source: string, warnings: MermaidWarning[]): void => {
        if (warnings.length === 0) {
            return;
        }
        if (!output) {
            output = vscode.window.createOutputChannel('Diagrammer');
            context.subscriptions.push(output);
        }
        output.appendLine(`Mermaid import from ${source}: ${warnings.length} warning(s)`);
        for (const w of warnings) {
            output.appendLine(`  ${w.message}`);
        }
        const preview = warnings
            .slice(0, 3)
            .map((w) => w.message)
            .join(' ');
        const more = warnings.length > 3 ? ` (+${warnings.length - 3} more)` : '';
        const channel = output;
        void vscode.window
            .showWarningMessage(`Mermaid import skipped some content. ${preview}${more}`, SHOW_WARNINGS)
            .then((choice) => choice === SHOW_WARNINGS && channel.show(true));
    };

    const importText = async (text: string, source: string, folder: vscode.Uri | undefined, baseName: string) => {
        let flowchart;
        try {
            flowchart = parseMermaid(text);
        } catch (err) {
            if (err instanceof MermaidParseError) {
                void vscode.window.showErrorMessage(`Cannot import Mermaid from ${source}: ${err.message}`);
                return undefined;
            }
            throw err;
        }
        const target = await createDiagramFile(mermaidToDiagram(flowchart), {
            baseName,
            folder,
            title: 'Save Imported Diagram',
        });
        if (target) {
            showWarnings(source, flowchart.warnings);
        }
        return target;
    };

    context.subscriptions.push(
        vscode.commands.registerCommand(IMPORT_MERMAID_TEXT_COMMAND, async (): Promise<vscode.Uri | undefined> => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                const document = await openUntitledMermaid();
                await vscode.window.showTextDocument(document);
                void vscode.window.showInformationMessage(
                    'Paste your Mermaid flowchart into this editor, then run "Diagrammer: Import Mermaid from Text" again.',
                );
                return undefined;
            }
            const selection = editor.selection;
            const text = selection.isEmpty ? editor.document.getText() : editor.document.getText(selection);
            const uri = editor.document.uri;
            const isFile = uri.scheme === 'file';
            const name = isFile ? path.basename(uri.fsPath) : 'the active editor';
            return importText(
                text,
                selection.isEmpty ? name : `the selection in ${name}`,
                isFile ? vscode.Uri.joinPath(uri, '..') : undefined,
                isFile ? stripExtension(uri) : 'mermaid-import',
            );
        }),
        vscode.commands.registerCommand(
            IMPORT_MERMAID_FILE_COMMAND,
            async (uri?: unknown): Promise<vscode.Uri | undefined> => {
                let source = uri instanceof vscode.Uri ? uri : undefined;
                if (!source) {
                    const picked = await vscode.window.showOpenDialog({
                        title: 'Import Mermaid File',
                        openLabel: 'Import',
                        canSelectMany: false,
                        filters: MERMAID_FILE_FILTERS,
                    });
                    source = picked?.[0];
                }
                if (!source) {
                    return undefined;
                }
                const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(source));
                return importText(text, path.basename(source.path), vscode.Uri.joinPath(source, '..'), stripExtension(source));
            },
        ),
        vscode.commands.registerCommand(COPY_AS_MERMAID_COMMAND, async (uri?: unknown): Promise<string | undefined> => {
            const document = exportableDocument(editors, uri);
            if (!document) {
                return undefined;
            }
            const text = diagramToMermaid(document.diagram);
            await vscode.env.clipboard.writeText(text);
            void vscode.window.showInformationMessage(
                `Copied ${document.diagram.nodes.length} node(s) and ${document.diagram.edges.length} connector(s) as Mermaid.`,
            );
            return text;
        }),
        vscode.commands.registerCommand(
            EXPORT_MERMAID_FILE_COMMAND,
            async (uri?: unknown, targetUri?: unknown): Promise<vscode.Uri | undefined> => {
                const document = exportableDocument(editors, uri);
                if (!document) {
                    return undefined;
                }
                let target = targetUri instanceof vscode.Uri ? targetUri : undefined;
                if (!target) {
                    target = await vscode.window.showSaveDialog({
                        title: 'Export Mermaid File',
                        saveLabel: 'Export',
                        defaultUri: vscode.Uri.joinPath(document.uri, '..', `${stripExtension(document.uri)}.mmd`),
                        filters: { Mermaid: ['mmd'] },
                    });
                }
                if (!target) {
                    return undefined;
                }
                const text = diagramToMermaid(document.diagram);
                await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(text));
                void vscode.window.showInformationMessage(`Exported Mermaid to ${path.basename(target.path)}.`);
                return target;
            },
        ),
    );
}

function exportableDocument(editors: DiagramEditorProvider, uri: unknown): DiagramDocument | undefined {
    const document = editors.findDocument(uri instanceof vscode.Uri ? uri : undefined);
    if (!document) {
        void vscode.window.showErrorMessage('No active diagram. Open a diagram in the Diagrammer editor to export it as Mermaid.');
        return undefined;
    }
    if (document.parseError) {
        void vscode.window.showErrorMessage(`Cannot export ${document.uri.fsPath}: ${document.parseError}`);
        return undefined;
    }
    return document;
}

async function openUntitledMermaid(): Promise<vscode.TextDocument> {
    try {
        return await vscode.workspace.openTextDocument({ language: 'mermaid', content: '' });
    } catch {
        // No extension contributes the `mermaid` language; fall back to plain text.
        return vscode.workspace.openTextDocument({ content: '' });
    }
}

/** `flow.mmd` → `flow`, `arch.diagram.json` → `arch`. */
function stripExtension(uri: vscode.Uri): string {
    const name = path.posix.basename(uri.path);
    return name.replace(/(\.diagram\.json|\.[^.]+)$/i, '') || 'mermaid-import';
}
