import * as vscode from 'vscode';
import { DiagramAIProvider, NoModelAvailableError } from './provider';

/** `DiagramAIProvider` backed by the VS Code Language Model API (`vscode.lm`). */
export class VsCodeLanguageModelProvider implements DiagramAIProvider {
    /** The editor passes the `vscode.CancellationToken` of its progress notification. */
    async complete(prompt: string, token?: vscode.CancellationToken): Promise<string> {
        const models = await vscode.lm.selectChatModels();
        const model = models[0];
        if (!model) {
            throw new NoModelAvailableError(
                'No language model is available. Install and sign in to an extension that provides chat models ' +
                    '(for example GitHub Copilot Chat), then try again.',
            );
        }
        try {
            const response = await model.sendRequest(
                [vscode.LanguageModelChatMessage.User(prompt)],
                { justification: 'Diagrammer turns your instruction into diagram edit operations.' },
                token,
            );
            let text = '';
            for await (const fragment of response.text) {
                text += fragment;
            }
            return text;
        } catch (err) {
            if (err instanceof vscode.LanguageModelError) {
                throw new Error(`${model.name}: ${err.message}`);
            }
            throw err;
        }
    }
}
