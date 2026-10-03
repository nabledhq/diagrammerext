/**
 * The "Edit Diagram with AI" flow, independent of the VS Code UI so it can be unit tested with a
 * fake provider and fake dialogs: ask for an instruction, prompt the model, validate the returned
 * operations, preview the summary and apply only after confirmation.
 */
import type { Diagram } from '../model/diagram';
import { applyOperations, ApplyResult } from './operations';
import { buildEditPrompt, extractOperationsJson } from './prompt';
import type { CancellationTokenLike, DiagramAIProvider } from './provider';

/** The open document being edited. */
export interface AIEditTarget {
    /** The current diagram (read again before applying, in case it changed meanwhile). */
    readonly diagram: Diagram;
    readonly selectedNodeIds: readonly string[];
    /** Applies the new diagram through the document's normal (undoable) edit path. */
    applyEdit(label: string, diagram: Diagram): void;
}

/** `apply` keeps positions, `relayout` also runs auto layout; `undefined` means cancelled. */
export type AIEditChoice = 'apply' | 'relayout' | undefined;

export interface AIEditUI {
    askInstruction(): Promise<string | undefined>;
    /** Runs the model request, showing progress; the token is cancelled if the user cancels. */
    withProgress<T>(task: (token: CancellationTokenLike) => Promise<T>): Promise<T>;
    confirm(summary: readonly string[]): Promise<AIEditChoice>;
    showError(message: string): void;
    showInfo(message: string): void;
}

export type AIEditOutcome = 'applied' | 'cancelled' | 'failed' | 'noChanges';

export const AI_EDIT_LABEL = 'Edit with AI';

export async function runAIEdit(target: AIEditTarget, provider: DiagramAIProvider, ui: AIEditUI): Promise<AIEditOutcome> {
    const instruction = (await ui.askInstruction())?.trim();
    if (!instruction) {
        return 'cancelled';
    }
    const base = target.diagram;
    const prompt = buildEditPrompt({ diagram: base, selectedNodeIds: target.selectedNodeIds, instruction });

    let response: string;
    let cancelled = false;
    try {
        response = await ui.withProgress(async (token) => {
            const text = await provider.complete(prompt, token);
            cancelled = token.isCancellationRequested;
            return text;
        });
    } catch (err) {
        ui.showError(`Edit with AI failed: ${err instanceof Error ? err.message : String(err)}`);
        return 'failed';
    }
    if (cancelled) {
        return 'cancelled';
    }

    const json = extractOperationsJson(response);
    const preview = applyOperations(base, json);
    if (!preview.ok) {
        ui.showError(`The AI response could not be applied, so the diagram was not changed. ${formatErrors(preview.errors)}`);
        return 'failed';
    }
    if (preview.summary.length === 0) {
        ui.showInfo('The AI suggested no changes.');
        return 'noChanges';
    }

    const choice = await ui.confirm(preview.summary);
    if (!choice) {
        return 'cancelled';
    }
    let result: ApplyResult = preview;
    const ops = JSON.parse(json) as unknown[];
    const batch = choice === 'relayout' ? [...ops, { op: 'applyLayout' }] : ops;
    if (choice === 'relayout' || target.diagram !== base) {
        result = applyOperations(target.diagram, batch);
    }
    if (!result.ok) {
        ui.showError(`The diagram changed while waiting for the AI and the edit no longer applies. ${formatErrors(result.errors)}`);
        return 'failed';
    }
    target.applyEdit(AI_EDIT_LABEL, result.diagram);
    return 'applied';
}

function formatErrors(errors: readonly string[]): string {
    const shown = errors.slice(0, 5).join(' ');
    return errors.length > 5 ? `${shown} (and ${errors.length - 5} more)` : shown;
}
