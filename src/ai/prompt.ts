/**
 * Prompt construction and response parsing for AI diagram edits. Pure: no `vscode` import.
 */
import type { Diagram } from '../model/diagram';
import { OPERATIONS_JSON_SCHEMA, OPERATIONS_SCHEMA_VERSION } from './operations';

export interface EditPromptInput {
    diagram: Diagram;
    /** Ids of the nodes selected in the editor (may be empty). */
    selectedNodeIds: readonly string[];
    instruction: string;
}

/** Builds the full prompt sent to the language model for one natural-language instruction. */
export function buildEditPrompt({ diagram, selectedNodeIds, instruction }: EditPromptInput): string {
    const current = {
        nodes: diagram.nodes.map((n) => ({
            id: n.id,
            label: n.label,
            type: n.type,
            x: n.x,
            y: n.y,
            width: n.width,
            height: n.height,
        })),
        connectors: diagram.edges.map((e) => ({ id: e.id, from: e.from, to: e.to, label: e.label ?? '' })),
    };
    const selected = selectedNodeIds
        .map((id) => diagram.nodes.find((n) => n.id === id))
        .filter((n) => n !== undefined)
        .map((n) => ({ id: n.id, label: n.label }));

    return [
        'You edit diagrams in the Diagrammer VS Code extension. Translate the user instruction into a batch of edit',
        'operations against the current diagram. Never rewrite the whole diagram.',
        '',
        'Rules:',
        '- Reference existing nodes and connectors by their "id".',
        '- Give every new node a unique "tempId" (for example "new-1") and use it to reference the node in later',
        '  operations of the same batch. tempIds must not reuse existing ids.',
        '- Omit x/y for new nodes unless the user asks for a specific position; they are placed automatically.',
        '- "This", "these", "it" or "the selection" in the instruction usually refer to the selected nodes.',
        '',
        '## Current diagram',
        JSON.stringify(current, null, 2),
        '',
        '## Selection (nodes currently selected in the editor)',
        selected.length > 0 ? JSON.stringify(selected, null, 2) : 'Nothing is selected.',
        '',
        `## Operation JSON Schema (schemaVersion ${OPERATIONS_SCHEMA_VERSION})`,
        JSON.stringify(OPERATIONS_JSON_SCHEMA, null, 2),
        '',
        '## Instruction',
        instruction,
        '',
        'Respond with ONLY a JSON array of operations that matches the schema. No explanations, no prose.',
        'Respond with [] if the instruction needs no change.',
    ].join('\n');
}

/**
 * Extracts the JSON text from a model response, tolerating surrounding whitespace and Markdown code
 * fences. The result still has to be validated with `parseOperations`/`applyOperations`.
 */
export function extractOperationsJson(response: string): string {
    const text = response.trim();
    const fenced = /```[\w-]*[ \t]*\r?\n?([\s\S]*?)```/.exec(text);
    return (fenced ? fenced[1] : text).trim();
}
