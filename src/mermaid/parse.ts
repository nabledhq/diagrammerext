/**
 * Hand-written parser for the subset of Mermaid flowchart syntax Diagrammer can import.
 *
 * Pure TypeScript with no `vscode` (or `mermaid`) dependency, so it can run in unit tests, a CLI or
 * the webview. See the README ("Mermaid import and export") for the supported subset.
 */

export const MERMAID_DIRECTIONS = ['TD', 'TB', 'BT', 'LR', 'RL'] as const;

export type MermaidDirection = (typeof MERMAID_DIRECTIONS)[number];

export type MermaidShape = 'rectangle' | 'rounded' | 'diamond' | 'circle';

/** `normal` is `--`, `dotted` is `-.`, `thick` is `==`. */
export type MermaidEdgeStyle = 'normal' | 'dotted' | 'thick';

export interface MermaidNode {
    id: string;
    label: string;
    shape: MermaidShape;
}

export interface MermaidEdge {
    from: string;
    to: string;
    label?: string;
    style: MermaidEdgeStyle;
    /** `false` for open links such as `---`. */
    arrow: boolean;
}

export interface MermaidWarning {
    /** 1-based line number in the parsed text. */
    line: number;
    /** The skipped construct (e.g. `subgraph`), when the warning is about one. */
    construct?: string;
    message: string;
}

export interface MermaidFlowchart {
    nodes: MermaidNode[];
    edges: MermaidEdge[];
    direction: MermaidDirection;
    warnings: MermaidWarning[];
}

export class MermaidParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'MermaidParseError';
    }
}

/** Statements that are recognised but not supported; they are skipped with a warning. */
export const UNSUPPORTED_CONSTRUCTS = ['subgraph', 'end', 'classDef', 'class', 'style', 'linkStyle', 'click', 'direction'];

interface Statement {
    text: string;
    line: number;
}

/**
 * Parses Mermaid `flowchart`/`graph` text. Throws `MermaidParseError` if the input is not a
 * flowchart (e.g. `sequenceDiagram`) or has an invalid direction; anything inside the flowchart
 * that cannot be imported is skipped and reported in `warnings`.
 */
export function parseMermaid(text: string): MermaidFlowchart {
    const statements = splitStatements(text);
    const header = statements.shift();
    if (!header) {
        throw new MermaidParseError('The text is empty: expected a Mermaid "flowchart" or "graph" diagram.');
    }
    const direction = parseHeader(header);

    const nodes = new Map<string, MermaidNode>();
    const edges: MermaidEdge[] = [];
    const warnings: MermaidWarning[] = [];

    for (const statement of statements) {
        const keyword = /^[A-Za-z]+/.exec(statement.text)?.[0];
        const construct = UNSUPPORTED_CONSTRUCTS.find((c) => c === keyword);
        if (construct && (statement.text.length === construct.length || /^\s/.test(statement.text.slice(construct.length)))) {
            warnings.push({
                line: statement.line,
                construct,
                message: `Line ${statement.line}: "${construct}" is not supported and was skipped.`,
            });
            continue;
        }
        const error = parseStatement(statement, nodes, edges, warnings);
        if (error) {
            warnings.push({
                line: statement.line,
                message: `Line ${statement.line}: could not parse "${statement.text}" (${error}); it was skipped.`,
            });
        }
    }

    return { nodes: [...nodes.values()], edges, direction, warnings };
}

/**
 * Splits the text into trimmed, non-empty statements (lines, further split on `;`), dropping `%%`
 * comments and an optional leading `---` front-matter block.
 */
function splitStatements(text: string): Statement[] {
    const lines = text.split(/\r?\n/);
    const statements: Statement[] = [];
    let start = 0;
    const firstContent = lines.findIndex((l) => l.trim() !== '');
    if (firstContent >= 0 && lines[firstContent].trim() === '---') {
        const close = lines.findIndex((l, i) => i > firstContent && l.trim() === '---');
        if (close > 0) {
            start = close + 1;
        }
    }
    for (let i = start; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line === '' || line.startsWith('%%')) {
            continue;
        }
        for (const part of splitOnSemicolons(line)) {
            const trimmed = part.trim();
            if (trimmed !== '') {
                statements.push({ text: trimmed, line: i + 1 });
            }
        }
    }
    return statements;
}

/** Splits on `;` outside quotes, brackets, `|…|` edge labels and `#entity;` references. */
function splitOnSemicolons(line: string): string[] {
    const parts: string[] = [];
    let current = '';
    let inQuote = false;
    let inPipe = false;
    let depth = 0;
    for (const ch of line) {
        if (ch === '"') {
            inQuote = !inQuote;
        } else if (!inQuote) {
            if (ch === '[' || ch === '(' || ch === '{') {
                depth++;
            } else if ((ch === ']' || ch === ')' || ch === '}') && depth > 0) {
                depth--;
            } else if (ch === '|' && depth === 0) {
                inPipe = !inPipe;
            } else if (ch === ';' && depth === 0 && !inPipe && !/#\w+$/.test(current)) {
                parts.push(current);
                current = '';
                continue;
            }
        }
        current += ch;
    }
    parts.push(current);
    return parts;
}

function parseHeader(header: Statement): MermaidDirection {
    const match = /^(\S+)(?:\s+(\S+))?\s*$/.exec(header.text);
    const keyword = match?.[1] ?? header.text;
    if (keyword !== 'flowchart' && keyword !== 'graph') {
        throw new MermaidParseError(
            `Line ${header.line}: "${keyword}" is not supported; only Mermaid "flowchart" and "graph" diagrams can be imported.`,
        );
    }
    if (!match) {
        throw new MermaidParseError(`Line ${header.line}: unexpected text after "${keyword}".`);
    }
    const direction = (match[2] ?? 'TD').toUpperCase();
    if (!(MERMAID_DIRECTIONS as readonly string[]).includes(direction)) {
        throw new MermaidParseError(
            `Line ${header.line}: unsupported direction "${match[2]}"; expected one of ${MERMAID_DIRECTIONS.join(', ')}.`,
        );
    }
    return direction as MermaidDirection;
}

// ---------------------------------------------------------------------------
// Statements: node (link node)*
// ---------------------------------------------------------------------------

interface ShapeSyntax {
    open: string;
    close: string;
    /** `undefined` for Mermaid shapes Diagrammer cannot represent (imported as rectangles). */
    shape?: MermaidShape;
}

/** Longest openers first so that `((` wins over `(`. */
const SHAPES: ShapeSyntax[] = [
    { open: '(((', close: ')))' },
    { open: '((', close: '))', shape: 'circle' },
    { open: '([', close: '])' },
    { open: '[[', close: ']]' },
    { open: '[(', close: ')]' },
    { open: '{{', close: '}}' },
    { open: '[/', close: '/]' },
    { open: '[\\', close: '\\]' },
    { open: '>', close: ']' },
    { open: '(', close: ')', shape: 'rounded' },
    { open: '[', close: ']', shape: 'rectangle' },
    { open: '{', close: '}', shape: 'diamond' },
];

const ID_PATTERN = /^[\p{L}\p{N}_]+/u;

/** Link with inline text: `-- text -->`, `-. text .->`, `== text ==>` (and their open variants). */
const TEXT_LINK = /^(--|-\.|==)\s*("[^"]*"|[^\s\-=.>|"][^]*?)\s*(-{2,}>|-{3,}|\.-+>|\.-+|={2,}>|={3,})/;
/** Plain link: `-->`, `---`, `-.->`, `-.-`, `==>`, `===` (optionally longer, or `<`-prefixed). */
const PLAIN_LINK = /^<?(-{2,}>|-{3,}|-\.+->|-\.+-|={2,}>|={3,})/;

class Cursor {
    pos = 0;
    constructor(readonly text: string) {}
    get rest(): string {
        return this.text.slice(this.pos);
    }
    skipSpace(): void {
        while (this.pos < this.text.length && /\s/.test(this.text[this.pos])) {
            this.pos++;
        }
    }
    done(): boolean {
        return this.pos >= this.text.length;
    }
}

/** Parses one statement into `nodes`/`edges`. Returns an error description, or undefined on success. */
function parseStatement(
    statement: Statement,
    nodes: Map<string, MermaidNode>,
    edges: MermaidEdge[],
    warnings: MermaidWarning[],
): string | undefined {
    const cursor = new Cursor(statement.text);
    const pendingNodes: ParsedNode[] = [];
    const pendingEdges: MermaidEdge[] = [];
    const pendingWarnings: MermaidWarning[] = [];

    const first = readNode(cursor, statement.line, pendingWarnings);
    if (typeof first === 'string') {
        return first;
    }
    pendingNodes.push(first);
    let previous = first;
    cursor.skipSpace();
    while (!cursor.done()) {
        const link = readLink(cursor);
        if (typeof link === 'string') {
            return link;
        }
        cursor.skipSpace();
        const next = readNode(cursor, statement.line, pendingWarnings);
        if (typeof next === 'string') {
            return next;
        }
        pendingNodes.push(next);
        pendingEdges.push({ from: previous.id, to: next.id, ...link });
        previous = next;
        cursor.skipSpace();
    }

    // Only commit once the whole statement parsed, so a bad statement leaves no partial result.
    for (const node of pendingNodes) {
        const existing = nodes.get(node.id);
        if (!existing || node.explicit) {
            nodes.set(node.id, { id: node.id, label: node.label, shape: node.shape });
        }
    }
    edges.push(...pendingEdges);
    warnings.push(...pendingWarnings);
    return undefined;
}

type ParsedNode = MermaidNode & { explicit: boolean };

function readNode(cursor: Cursor, line: number, warnings: MermaidWarning[]): ParsedNode | string {
    const idMatch = ID_PATTERN.exec(cursor.rest);
    if (!idMatch) {
        return cursor.done() ? 'expected a node after the link' : `unexpected "${cursor.rest[0]}"`;
    }
    const id = idMatch[0];
    cursor.pos += id.length;
    const syntax = SHAPES.find((s) => cursor.rest.startsWith(s.open));
    if (!syntax) {
        return { id, label: id, shape: 'rectangle', explicit: false };
    }
    cursor.pos += syntax.open.length;
    let label: string;
    const rest = cursor.rest;
    const quoted = /^\s*"([^"]*)"\s*/.exec(rest);
    if (quoted && rest.slice(quoted[0].length).startsWith(syntax.close)) {
        label = quoted[1];
        cursor.pos += quoted[0].length + syntax.close.length;
    } else {
        const end = rest.indexOf(syntax.close);
        if (end < 0) {
            return `missing "${syntax.close}" after the label of "${id}"`;
        }
        label = rest.slice(0, end).trim();
        cursor.pos += end + syntax.close.length;
    }
    if (cursor.rest.startsWith(':::')) {
        const cls = /^:::[\w-]+/.exec(cursor.rest)?.[0] ?? ':::';
        cursor.pos += cls.length;
        warnings.push({ line, construct: ':::', message: `Line ${line}: class shorthand "${cls}" on "${id}" was skipped.` });
    }
    if (!syntax.shape) {
        warnings.push({
            line,
            message: `Line ${line}: shape "${syntax.open}…${syntax.close}" of "${id}" is not supported and was imported as a rectangle.`,
        });
    }
    return { id, label: decodeLabel(label), shape: syntax.shape ?? 'rectangle', explicit: true };
}

function readLink(cursor: Cursor): Omit<MermaidEdge, 'from' | 'to'> | string {
    const textLink = TEXT_LINK.exec(cursor.rest);
    if (textLink) {
        cursor.pos += textLink[0].length;
        return { ...linkKind(textLink[3]), label: decodeLabel(unquote(textLink[2].trim())) };
    }
    const plain = PLAIN_LINK.exec(cursor.rest);
    if (!plain) {
        return cursor.rest.trim() === '' ? 'expected a link' : `expected a link at "${cursor.rest}"`;
    }
    cursor.pos += plain[0].length;
    const link: Omit<MermaidEdge, 'from' | 'to'> = linkKind(plain[1]);
    const pipe = /^\s*\|\s*("[^"]*"|[^|]*?)\s*\|/.exec(cursor.rest);
    if (pipe) {
        cursor.pos += pipe[0].length;
        link.label = decodeLabel(unquote(pipe[1]));
    }
    return link;
}

function linkKind(token: string): { style: MermaidEdgeStyle; arrow: boolean } {
    const style: MermaidEdgeStyle = token.includes('.') ? 'dotted' : token.includes('=') ? 'thick' : 'normal';
    return { style, arrow: token.endsWith('>') };
}

function unquote(text: string): string {
    return text.length >= 2 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text;
}

const NAMED_ENTITIES: Record<string, string> = { quot: '"', amp: '&', lt: '<', gt: '>', nbsp: '\u00a0', num: '#' };

/** Decodes Mermaid entity codes (`#quot;`, `#35;`) and turns `<br>` into line breaks. */
export function decodeLabel(text: string): string {
    return text
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/#(\w+);/g, (whole, code: string) => {
            if (/^\d+$/.test(code)) {
                return String.fromCodePoint(Number(code));
            }
            return NAMED_ENTITIES[code] ?? whole;
        });
}
