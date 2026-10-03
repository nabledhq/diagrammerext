import type { LayoutMode } from './layout';
import type { Diagram } from './model/diagram';

/** Messages sent from the webview to the extension host. */
export type WebviewToHostMessage =
    | { type: 'ready' }
    | { type: 'edit'; label: string; diagram: Diagram }
    /** Asks the host to auto-layout the diagram (default mode when `mode` is omitted). */
    | { type: 'autoLayout'; mode?: LayoutMode }
    /** Reported after each full render with the number of node and edge elements drawn. */
    | { type: 'rendered'; nodes: number; edges: number }
    /** Sent whenever the selected nodes change (the editor currently selects at most one node). */
    | { type: 'selection'; nodeIds: string[] };

/** Messages sent from the extension host to the webview. */
export type HostToWebviewMessage =
    | { type: 'init'; diagram: Diagram }
    | { type: 'update'; diagram: Diagram }
    | { type: 'error'; message: string };
