import {
    addEdge,
    addNode,
    createNode,
    Diagram,
    DiagramNode,
    findEdge,
    findNode,
    getEdgeEndpoints,
    hitTestNode,
    isNodeType,
    moveNode,
    nodeCenter,
    boundaryPoint,
    NodeType,
    Point,
    removeElement,
    setLabel,
} from '../model/diagram';
import type { HostToWebviewMessage, WebviewToHostMessage } from '../protocol';

interface VsCodeApi {
    postMessage(message: WebviewToHostMessage): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

const SVG_NS = 'http://www.w3.org/2000/svg';
const SHAPE_MIME = 'application/x-diagrammer-shape';
const CANVAS_MARGIN = 200;

const PALETTE: { type: NodeType; title: string }[] = [
    { type: 'rectangle', title: 'Rectangle' },
    { type: 'roundedRectangle', title: 'Rounded rectangle' },
    { type: 'ellipse', title: 'Ellipse' },
    { type: 'diamond', title: 'Diamond' },
    { type: 'text', title: 'Text label' },
    { type: 'sticky', title: 'Sticky note' },
];

type Selection = { kind: 'node' | 'edge'; id: string } | undefined;

type Interaction =
    | { kind: 'none' }
    | { kind: 'move'; nodeId: string; start: Point; origin: Point; moved: boolean }
    | { kind: 'connect'; fromId: string; pointer: Point; targetId?: string };

const app = document.getElementById('app') as HTMLDivElement;
const palette = document.getElementById('palette') as HTMLElement;
const container = document.getElementById('canvas-container') as HTMLDivElement;
const svg = document.getElementById('canvas') as unknown as SVGSVGElement;
const errorBox = document.getElementById('error') as HTMLDivElement;

let diagram: Diagram | undefined;
let selection: Selection;
/** Node ids last sent to the host in a `selection` message. */
let reportedSelection: string[] = [];
let interaction: Interaction = { kind: 'none' };
let labelEditor: HTMLTextAreaElement | undefined;

const edgeLayer = svgEl('g', { class: 'edges' });
const nodeLayer = svgEl('g', { class: 'nodes' });
const overlayLayer = svgEl('g', { class: 'overlay' });

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function init(): void {
    const defs = svgEl('defs');
    const marker = svgEl('marker', {
        id: 'arrow',
        viewBox: '0 0 10 10',
        refX: '10',
        refY: '5',
        markerWidth: '8',
        markerHeight: '8',
        orient: 'auto-start-reverse',
    });
    marker.appendChild(svgEl('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: 'arrowhead' }));
    defs.appendChild(marker);
    svg.append(defs, edgeLayer, nodeLayer, overlayLayer);

    buildPalette();

    container.addEventListener('dragover', (e) => {
        if (e.dataTransfer?.types.includes(SHAPE_MIME)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        }
    });
    container.addEventListener('drop', (e) => {
        const type = e.dataTransfer?.getData(SHAPE_MIME);
        if (!isNodeType(type)) {
            return;
        }
        e.preventDefault();
        addShape(type, toCanvasPoint(e));
    });

    svg.addEventListener('pointerdown', onCanvasPointerDown);
    svg.addEventListener('dblclick', onCanvasDoubleClick);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('resize', () => updateCanvasSize());
    container.addEventListener('keydown', onKeyDown);

    window.addEventListener('message', (event: MessageEvent<HostToWebviewMessage>) => {
        const message = event.data;
        switch (message.type) {
            case 'init':
            case 'update':
                cancelInteraction();
                diagram = message.diagram;
                if (selection && !findNode(diagram, selection.id) && !findEdge(diagram, selection.id)) {
                    selection = undefined;
                }
                showError(undefined);
                render();
                reportRendered();
                break;
            case 'error':
                diagram = undefined;
                showError(message.message);
                break;
        }
    });

    vscode.postMessage({ type: 'ready' });
}

function buildPalette(): void {
    for (const item of PALETTE) {
        const button = document.createElement('button');
        button.className = 'palette-item';
        button.type = 'button';
        button.draggable = true;
        button.title = `${item.title} (drag onto the canvas or click to add)`;
        button.setAttribute('aria-label', item.title);
        button.dataset.type = item.type;

        const icon = svgEl('svg', { width: '40', height: '28', viewBox: '0 0 40 28' }) as SVGSVGElement;
        icon.appendChild(paletteIcon(item.type));
        const caption = document.createElement('span');
        caption.textContent = item.title;
        button.append(icon, caption);

        button.addEventListener('dragstart', (e) => {
            e.dataTransfer?.setData(SHAPE_MIME, item.type);
            if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = 'copy';
            }
        });
        button.addEventListener('click', () => {
            const center = {
                x: container.scrollLeft + container.clientWidth / 2,
                y: container.scrollTop + container.clientHeight / 2,
            };
            addShape(item.type, center);
        });
        palette.appendChild(button);
    }

    palette.appendChild(document.createElement('hr')).className = 'palette-separator';
    const layoutButton = document.createElement('button');
    layoutButton.id = 'auto-layout';
    layoutButton.className = 'toolbar-action';
    layoutButton.type = 'button';
    layoutButton.title = 'Auto layout (top to bottom)';
    layoutButton.setAttribute('aria-label', 'Auto layout');
    const icon = svgEl('svg', { width: '40', height: '28', viewBox: '0 0 40 28' }) as SVGSVGElement;
    icon.append(
        svgEl('rect', { class: 'toolbar-icon', x: '15', y: '1', width: '10', height: '7' }),
        svgEl('rect', { class: 'toolbar-icon', x: '4', y: '20', width: '10', height: '7' }),
        svgEl('rect', { class: 'toolbar-icon', x: '26', y: '20', width: '10', height: '7' }),
        svgEl('path', { class: 'toolbar-icon-line', d: 'M20 8 V14 M9 20 V14 H31 V20' }),
    );
    const caption = document.createElement('span');
    caption.textContent = 'Auto layout';
    layoutButton.append(icon, caption);
    layoutButton.addEventListener('click', requestAutoLayout);
    palette.appendChild(layoutButton);
}

/** Layout runs in the extension host, which applies it as a normal edit and sends back an update. */
function requestAutoLayout(): void {
    if (!diagram) {
        return;
    }
    closeLabelEditor(true);
    interaction = { kind: 'none' };
    vscode.postMessage({ type: 'autoLayout' });
}

function paletteIcon(type: NodeType): SVGElement {
    const node: DiagramNode = { id: '', type, x: 4, y: 4, width: 32, height: 20, label: '' };
    if (type === 'text') {
        const text = svgEl('text', { x: '20', y: '19', class: 'palette-text', 'text-anchor': 'middle' });
        text.textContent = 'Aa';
        return text;
    }
    const g = svgEl('g', { class: `node-${type}` });
    g.appendChild(shapeElement({ ...node, x: 0, y: 0 }));
    g.setAttribute('transform', 'translate(4,4)');
    return g;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render(): void {
    edgeLayer.replaceChildren();
    nodeLayer.replaceChildren();
    overlayLayer.replaceChildren();
    if (!diagram) {
        return;
    }
    for (const edge of diagram.edges) {
        const endpoints = getEdgeEndpoints(diagram, edge);
        if (!endpoints) {
            continue;
        }
        const { start, end } = endpoints;
        const g = svgEl('g', { class: 'edge', 'data-id': edge.id });
        if (selection?.kind === 'edge' && selection.id === edge.id) {
            g.classList.add('selected');
        }
        const coords = { x1: `${start.x}`, y1: `${start.y}`, x2: `${end.x}`, y2: `${end.y}` };
        g.appendChild(svgEl('line', { ...coords, class: 'edge-hit' }));
        g.appendChild(svgEl('line', { ...coords, class: 'edge-line', 'marker-end': 'url(#arrow)' }));
        edgeLayer.appendChild(g);
        if (edge.label) {
            const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
            const bg = svgEl('rect', { class: 'edge-label-bg' });
            const text = labelText(edge.label, mid, 'edge-label');
            g.append(bg, text);
            const box = text.getBBox();
            setAttrs(bg, {
                x: `${box.x - 4}`,
                y: `${box.y - 2}`,
                width: `${box.width + 8}`,
                height: `${box.height + 4}`,
                rx: '3',
            });
        }
    }

    for (const node of diagram.nodes) {
        const g = svgEl('g', {
            class: `node node-${node.type}`,
            'data-id': node.id,
            transform: `translate(${node.x},${node.y})`,
        });
        if (selection?.kind === 'node' && selection.id === node.id) {
            g.classList.add('selected');
        }
        if (interaction.kind === 'connect' && interaction.targetId === node.id) {
            g.classList.add('connect-target');
        }
        g.appendChild(shapeElement({ ...node, x: 0, y: 0 }));
        g.appendChild(labelText(node.label, { x: node.width / 2, y: node.height / 2 }, 'node-label'));
        for (const handle of handlePositions(node)) {
            g.appendChild(svgEl('circle', { class: 'handle', cx: `${handle.x}`, cy: `${handle.y}`, r: '5' }));
        }
        nodeLayer.appendChild(g);
    }

    if (interaction.kind === 'connect') {
        const from = findNode(diagram, interaction.fromId);
        if (from) {
            const target = interaction.targetId ? findNode(diagram, interaction.targetId) : undefined;
            const start = boundaryPoint(from, target ? nodeCenter(target) : interaction.pointer);
            const end = target ? boundaryPoint(target, nodeCenter(from)) : interaction.pointer;
            overlayLayer.appendChild(
                svgEl('line', {
                    class: 'edge-line edge-preview',
                    x1: `${start.x}`,
                    y1: `${start.y}`,
                    x2: `${end.x}`,
                    y2: `${end.y}`,
                    'marker-end': 'url(#arrow)',
                }),
            );
        }
    }

    updateCanvasSize();
    reportSelection();
}

function shapeElement(node: DiagramNode): SVGElement {
    const { width: w, height: h } = node;
    switch (node.type) {
        case 'ellipse':
            return svgEl('ellipse', { class: 'shape', cx: `${w / 2}`, cy: `${h / 2}`, rx: `${w / 2}`, ry: `${h / 2}` });
        case 'diamond':
            return svgEl('polygon', {
                class: 'shape',
                points: `${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}`,
            });
        case 'roundedRectangle':
            return svgEl('rect', { class: 'shape', width: `${w}`, height: `${h}`, rx: `${Math.min(14, h / 3)}` });
        case 'sticky': {
            const fold = Math.min(18, w / 4, h / 4);
            const g = svgEl('g');
            g.appendChild(
                svgEl('path', {
                    class: 'shape',
                    d: `M0,0 H${w} V${h - fold} L${w - fold},${h} H0 Z`,
                }),
            );
            g.appendChild(
                svgEl('path', { class: 'sticky-fold', d: `M${w},${h - fold} H${w - fold} V${h} Z` }),
            );
            return g;
        }
        case 'text':
        case 'rectangle':
        default:
            return svgEl('rect', { class: 'shape', width: `${w}`, height: `${h}` });
    }
}

function labelText(label: string, center: Point, className: string): SVGTextElement {
    const text = svgEl('text', {
        class: className,
        x: `${center.x}`,
        y: `${center.y}`,
        'text-anchor': 'middle',
        'dominant-baseline': 'central',
    }) as SVGTextElement;
    const lines = label.split('\n');
    const lineHeight = 1.2;
    lines.forEach((line, i) => {
        const tspan = svgEl('tspan', {
            x: `${center.x}`,
            dy: i === 0 ? `${(-(lines.length - 1) * lineHeight) / 2}em` : `${lineHeight}em`,
        });
        // textContent (never innerHTML) so labels cannot inject markup.
        tspan.textContent = line === '' ? '\u00a0' : line;
        text.appendChild(tspan);
    });
    return text;
}

function handlePositions(node: DiagramNode): Point[] {
    const { width: w, height: h } = node;
    return [
        { x: w / 2, y: 0 },
        { x: w, y: h / 2 },
        { x: w / 2, y: h },
        { x: 0, y: h / 2 },
    ];
}

function updateCanvasSize(): void {
    let maxX = 0;
    let maxY = 0;
    for (const n of diagram?.nodes ?? []) {
        maxX = Math.max(maxX, n.x + n.width);
        maxY = Math.max(maxY, n.y + n.height);
    }
    svg.setAttribute('width', `${Math.max(container.clientWidth, maxX + CANVAS_MARGIN)}`);
    svg.setAttribute('height', `${Math.max(container.clientHeight, maxY + CANVAS_MARGIN)}`);
}

function reportRendered(): void {
    vscode.postMessage({
        type: 'rendered',
        nodes: nodeLayer.querySelectorAll('.node').length,
        edges: edgeLayer.querySelectorAll('.edge').length,
    });
}

function showError(message: string | undefined): void {
    errorBox.hidden = message === undefined;
    app.hidden = message !== undefined;
    errorBox.textContent = message ?? '';
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

function commit(label: string, next: Diagram): void {
    if (next === diagram) {
        return;
    }
    diagram = next;
    render();
    if (diagram) {
        vscode.postMessage({ type: 'edit', label, diagram });
    }
}

function addShape(type: NodeType, center: Point): void {
    if (!diagram) {
        return;
    }
    const node = createNode(diagram, type, center);
    node.x = Math.max(0, node.x);
    node.y = Math.max(0, node.y);
    selection = { kind: 'node', id: node.id };
    commit(`Add ${type}`, addNode(diagram, node));
    container.focus();
}

function deleteSelection(): void {
    if (!diagram || !selection) {
        return;
    }
    const next = removeElement(diagram, selection.id);
    const kind = selection.kind;
    selection = undefined;
    commit(kind === 'node' ? 'Delete node' : 'Delete connector', next);
}

function startLabelEdit(id: string): void {
    if (!diagram) {
        return;
    }
    closeLabelEditor(false);
    const node = findNode(diagram, id);
    const edge = node ? undefined : findEdge(diagram, id);
    let box: { x: number; y: number; width: number; height: number };
    let current: string;
    if (node) {
        box = { x: node.x, y: node.y, width: Math.max(node.width, 80), height: Math.max(node.height, 30) };
        current = node.label;
    } else if (edge) {
        const endpoints = getEdgeEndpoints(diagram, edge);
        if (!endpoints) {
            return;
        }
        const mid = { x: (endpoints.start.x + endpoints.end.x) / 2, y: (endpoints.start.y + endpoints.end.y) / 2 };
        box = { x: mid.x - 70, y: mid.y - 16, width: 140, height: 32 };
        current = edge.label ?? '';
    } else {
        return;
    }

    const editor = document.createElement('textarea');
    editor.className = 'label-editor';
    editor.value = current;
    editor.style.left = `${box.x}px`;
    editor.style.top = `${box.y}px`;
    editor.style.width = `${box.width}px`;
    editor.style.height = `${box.height}px`;
    editor.dataset.id = id;
    editor.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            closeLabelEditor(true);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            closeLabelEditor(false);
        }
    });
    editor.addEventListener('blur', () => closeLabelEditor(true));
    container.appendChild(editor);
    labelEditor = editor;
    editor.focus();
    editor.select();
}

function closeLabelEditor(save: boolean): void {
    const editor = labelEditor;
    if (!editor) {
        return;
    }
    labelEditor = undefined;
    const id = editor.dataset.id ?? '';
    const value = editor.value;
    editor.remove();
    container.focus();
    if (save && diagram) {
        const node = findNode(diagram, id);
        const edge = findEdge(diagram, id);
        const before = node ? node.label : (edge?.label ?? '');
        if ((node || edge) && value !== before) {
            commit('Edit label', setLabel(diagram, id, value));
        }
    }
}

// ---------------------------------------------------------------------------
// Pointer and keyboard handling
// ---------------------------------------------------------------------------

function onCanvasPointerDown(e: PointerEvent): void {
    if (!diagram || e.button !== 0) {
        return;
    }
    container.focus();
    const target = e.target as Element;
    const point = toCanvasPoint(e);
    const nodeEl = target.closest('.node');
    const edgeEl = target.closest('.edge');

    if (nodeEl) {
        const id = nodeEl.getAttribute('data-id') ?? '';
        const node = findNode(diagram, id);
        if (!node) {
            return;
        }
        e.preventDefault();
        selection = { kind: 'node', id };
        if (target.classList.contains('handle')) {
            interaction = { kind: 'connect', fromId: id, pointer: point };
        } else {
            interaction = { kind: 'move', nodeId: id, start: point, origin: { x: node.x, y: node.y }, moved: false };
        }
    } else if (edgeEl) {
        selection = { kind: 'edge', id: edgeEl.getAttribute('data-id') ?? '' };
    } else {
        selection = undefined;
    }
    // Only toggle classes here: rebuilding the elements under the pointer would break double-click.
    updateSelectionClasses();
}

function updateSelectionClasses(): void {
    for (const el of svg.querySelectorAll('.node, .edge')) {
        const kind = el.classList.contains('node') ? 'node' : 'edge';
        el.classList.toggle('selected', selection?.kind === kind && selection.id === el.getAttribute('data-id'));
    }
    reportSelection();
}

/** Tells the host which nodes are selected (used as context for AI edits). Only sent on change. */
function reportSelection(): void {
    const nodeIds = selection?.kind === 'node' && diagram && findNode(diagram, selection.id) ? [selection.id] : [];
    if (nodeIds.length !== reportedSelection.length || nodeIds.some((id, i) => id !== reportedSelection[i])) {
        reportedSelection = nodeIds;
        vscode.postMessage({ type: 'selection', nodeIds });
    }
}

function onPointerMove(e: PointerEvent): void {
    if (!diagram || interaction.kind === 'none') {
        return;
    }
    const point = toCanvasPoint(e);
    if (interaction.kind === 'move') {
        const dx = point.x - interaction.start.x;
        const dy = point.y - interaction.start.y;
        if (!interaction.moved && Math.abs(dx) < 2 && Math.abs(dy) < 2) {
            return;
        }
        interaction.moved = true;
        const x = Math.max(0, Math.round(interaction.origin.x + dx));
        const y = Math.max(0, Math.round(interaction.origin.y + dy));
        // Update locally while dragging; the edit is reported once on pointer up.
        diagram = moveNode(diagram, interaction.nodeId, x, y);
        render();
    } else {
        interaction.pointer = point;
        interaction.targetId = hitTestNode(diagram, point, interaction.fromId)?.id;
        render();
    }
}

function onPointerUp(): void {
    if (!diagram) {
        return;
    }
    const finished = interaction;
    interaction = { kind: 'none' };
    if (finished.kind === 'move') {
        if (finished.moved) {
            vscode.postMessage({ type: 'edit', label: 'Move node', diagram });
        }
    } else if (finished.kind === 'connect') {
        if (finished.targetId) {
            const next = addEdge(diagram, finished.fromId, finished.targetId);
            const created = next.edges.find((edge) => !diagram?.edges.includes(edge));
            if (created) {
                selection = { kind: 'edge', id: created.id };
            }
            commit('Add connector', next);
        }
        render();
    }
}

function cancelInteraction(): void {
    interaction = { kind: 'none' };
    closeLabelEditor(false);
}

function onCanvasDoubleClick(e: MouseEvent): void {
    const target = e.target as Element;
    const el = target.closest('.node') ?? target.closest('.edge');
    const id = el?.getAttribute('data-id');
    if (id) {
        e.preventDefault();
        startLabelEdit(id);
    }
}

function onKeyDown(e: KeyboardEvent): void {
    if (labelEditor) {
        return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selection) {
            e.preventDefault();
            deleteSelection();
        }
    } else if (e.key === 'Enter' || e.key === 'F2') {
        if (selection) {
            e.preventDefault();
            startLabelEdit(selection.id);
        }
    } else if (e.key === 'Escape') {
        if (interaction.kind !== 'none' || selection) {
            interaction = { kind: 'none' };
            selection = undefined;
            render();
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toCanvasPoint(e: { clientX: number; clientY: number }): Point {
    const rect = svg.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string> = {}): SVGElementTagNameMap[K] {
    const el = document.createElementNS(SVG_NS, tag);
    setAttrs(el, attrs);
    return el;
}

function setAttrs(el: Element, attrs: Record<string, string>): void {
    for (const [key, value] of Object.entries(attrs)) {
        el.setAttribute(key, value);
    }
}

init();
