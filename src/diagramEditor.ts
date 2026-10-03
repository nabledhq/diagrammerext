import * as vscode from 'vscode';
import { Diagram, DiagramParseError, parseDiagram, serializeDiagram } from './model/diagram';
import type { HostToWebviewMessage, WebviewToHostMessage } from './protocol';

export const DIAGRAM_EDITOR_VIEW_TYPE = 'diagrammer.diagramEditor';

export interface RenderReport {
    uri: vscode.Uri;
    nodes: number;
    edges: number;
}

/**
 * In-memory model of an open `.diagram.json` file.
 *
 * Edits coming from the webview replace the whole (immutable) diagram; each one is reported to
 * VS Code as a `CustomDocumentEditEvent` so dirty tracking, undo and redo use VS Code's own
 * edit stack.
 */
export class DiagramDocument implements vscode.CustomDocument {
    static async create(uri: vscode.Uri, backupId: string | undefined): Promise<DiagramDocument> {
        const source = backupId ? vscode.Uri.parse(backupId) : uri;
        const { diagram, error } = await readDiagram(source);
        return new DiagramDocument(uri, diagram, error);
    }

    private readonly _onDidDispose = new vscode.EventEmitter<void>();
    readonly onDidDispose = this._onDidDispose.event;

    private readonly _onDidChange = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<DiagramDocument>>();
    readonly onDidChange = this._onDidChange.event;

    /** Fired when the diagram changes for a reason other than a webview edit (undo, redo, revert). */
    private readonly _onDidChangeContent = new vscode.EventEmitter<Diagram>();
    readonly onDidChangeContent = this._onDidChangeContent.event;

    private constructor(
        readonly uri: vscode.Uri,
        private _diagram: Diagram,
        private _parseError: string | undefined,
    ) {}

    get diagram(): Diagram {
        return this._diagram;
    }

    /** Set when the file on disk could not be parsed; the editor is read-only in that state. */
    get parseError(): string | undefined {
        return this._parseError;
    }

    applyEdit(label: string, diagram: Diagram): void {
        if (this._parseError) {
            return;
        }
        const before = this._diagram;
        this._diagram = diagram;
        this._onDidChange.fire({
            document: this,
            label,
            undo: () => this.setDiagram(before),
            redo: () => this.setDiagram(diagram),
        });
    }

    async save(cancellation: vscode.CancellationToken): Promise<void> {
        await this.saveAs(this.uri, cancellation);
    }

    async saveAs(target: vscode.Uri, cancellation: vscode.CancellationToken): Promise<void> {
        if (this._parseError) {
            // Never overwrite a file we could not understand with an empty diagram.
            return;
        }
        if (cancellation.isCancellationRequested) {
            return;
        }
        await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(serializeDiagram(this._diagram)));
    }

    async revert(): Promise<void> {
        const { diagram, error } = await readDiagram(this.uri);
        this._parseError = error;
        this.setDiagram(diagram);
    }

    async backup(destination: vscode.Uri, cancellation: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
        await this.saveAs(destination, cancellation);
        return {
            id: destination.toString(),
            delete: async () => {
                try {
                    await vscode.workspace.fs.delete(destination);
                } catch {
                    // The backup may already be gone.
                }
            },
        };
    }

    dispose(): void {
        this._onDidDispose.fire();
        this._onDidDispose.dispose();
        this._onDidChange.dispose();
        this._onDidChangeContent.dispose();
    }

    private setDiagram(diagram: Diagram): void {
        this._diagram = diagram;
        this._onDidChangeContent.fire(diagram);
    }
}

async function readDiagram(uri: vscode.Uri): Promise<{ diagram: Diagram; error?: string }> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = new TextDecoder().decode(bytes);
    try {
        return { diagram: parseDiagram(text) };
    } catch (err) {
        const message = err instanceof DiagramParseError ? err.message : String(err);
        return { diagram: parseDiagram(''), error: message };
    }
}

export class DiagramEditorProvider implements vscode.CustomEditorProvider<DiagramDocument> {
    static register(context: vscode.ExtensionContext): DiagramEditorProvider {
        const provider = new DiagramEditorProvider(context.extensionUri);
        context.subscriptions.push(
            vscode.window.registerCustomEditorProvider(DIAGRAM_EDITOR_VIEW_TYPE, provider, {
                supportsMultipleEditorsPerDocument: true,
            }),
            provider._onDidChangeCustomDocument,
            provider._onDidRender,
        );
        return provider;
    }

    private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<
        vscode.CustomDocumentEditEvent<DiagramDocument>
    >();
    readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

    private readonly _onDidRender = new vscode.EventEmitter<RenderReport>();
    /** Fired whenever a webview finishes rendering a diagram. Used by integration tests. */
    readonly onDidRender = this._onDidRender.event;

    private readonly webviews = new Map<string, Set<vscode.WebviewPanel>>();

    constructor(private readonly extensionUri: vscode.Uri) {}

    async openCustomDocument(
        uri: vscode.Uri,
        openContext: vscode.CustomDocumentOpenContext,
        _token: vscode.CancellationToken,
    ): Promise<DiagramDocument> {
        const document = await DiagramDocument.create(uri, openContext.backupId);
        const subscriptions = [
            document.onDidChange((e) => this._onDidChangeCustomDocument.fire(e)),
            document.onDidChangeContent((diagram) => {
                for (const panel of this.panelsFor(document)) {
                    this.postMessage(panel, document.parseError ? errorMessage(document) : { type: 'update', diagram });
                }
            }),
        ];
        document.onDidDispose(() => subscriptions.forEach((s) => s.dispose()));
        return document;
    }

    async resolveCustomEditor(
        document: DiagramDocument,
        panel: vscode.WebviewPanel,
        _token: vscode.CancellationToken,
    ): Promise<void> {
        const key = document.uri.toString();
        let panels = this.webviews.get(key);
        if (!panels) {
            panels = new Set();
            this.webviews.set(key, panels);
        }
        panels.add(panel);
        panel.onDidDispose(() => {
            panels.delete(panel);
            if (panels.size === 0) {
                this.webviews.delete(key);
            }
        });

        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.extensionUri, 'dist'),
                vscode.Uri.joinPath(this.extensionUri, 'media'),
            ],
        };
        panel.webview.html = this.getHtml(panel.webview);

        panel.webview.onDidReceiveMessage((message: WebviewToHostMessage) => {
            switch (message.type) {
                case 'ready':
                    this.postMessage(
                        panel,
                        document.parseError ? errorMessage(document) : { type: 'init', diagram: document.diagram },
                    );
                    break;
                case 'edit':
                    document.applyEdit(message.label, message.diagram);
                    for (const other of this.panelsFor(document)) {
                        if (other !== panel) {
                            this.postMessage(other, { type: 'update', diagram: document.diagram });
                        }
                    }
                    break;
                case 'rendered':
                    this._onDidRender.fire({ uri: document.uri, nodes: message.nodes, edges: message.edges });
                    break;
            }
        });
    }

    saveCustomDocument(document: DiagramDocument, cancellation: vscode.CancellationToken): Thenable<void> {
        return document.save(cancellation);
    }

    saveCustomDocumentAs(
        document: DiagramDocument,
        destination: vscode.Uri,
        cancellation: vscode.CancellationToken,
    ): Thenable<void> {
        return document.saveAs(destination, cancellation);
    }

    revertCustomDocument(document: DiagramDocument, _cancellation: vscode.CancellationToken): Thenable<void> {
        return document.revert();
    }

    backupCustomDocument(
        document: DiagramDocument,
        context: vscode.CustomDocumentBackupContext,
        cancellation: vscode.CancellationToken,
    ): Thenable<vscode.CustomDocumentBackup> {
        return document.backup(context.destination, cancellation);
    }

    private panelsFor(document: DiagramDocument): Iterable<vscode.WebviewPanel> {
        return this.webviews.get(document.uri.toString()) ?? [];
    }

    private postMessage(panel: vscode.WebviewPanel, message: HostToWebviewMessage): void {
        void panel.webview.postMessage(message);
    }

    private getHtml(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'diagram.css'));
        const nonce = getNonce();
        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="${styleUri}" rel="stylesheet">
    <title>Diagram</title>
</head>
<body>
    <div id="app">
        <aside id="palette" aria-label="Shapes"></aside>
        <div id="canvas-container" tabindex="0">
            <svg id="canvas" xmlns="http://www.w3.org/2000/svg"></svg>
        </div>
    </div>
    <div id="error" hidden></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

function errorMessage(document: DiagramDocument): HostToWebviewMessage {
    return { type: 'error', message: `Could not open ${document.uri.fsPath}: ${document.parseError}` };
}

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 32; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}
