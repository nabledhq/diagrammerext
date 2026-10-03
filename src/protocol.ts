import type { Diagram } from './model/diagram';

/** Messages sent from the webview to the extension host. */
export type WebviewToHostMessage =
    | { type: 'ready' }
    | { type: 'edit'; label: string; diagram: Diagram }
    /** Reported after each full render with the number of node and edge elements drawn. */
    | { type: 'rendered'; nodes: number; edges: number };

/** Messages sent from the extension host to the webview. */
export type HostToWebviewMessage =
    | { type: 'init'; diagram: Diagram }
    | { type: 'update'; diagram: Diagram }
    | { type: 'error'; message: string };
