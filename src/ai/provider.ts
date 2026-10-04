/** Minimal cancellation token shape, compatible with `vscode.CancellationToken`. */
export interface CancellationTokenLike {
    readonly isCancellationRequested: boolean;
}

/**
 * Something that turns a prompt into a model response. The extension uses the VS Code Language
 * Model API (`VsCodeLanguageModelProvider`); tests use fakes. Implementations must not need
 * API keys or vendor SDKs of their own.
 */
export interface DiagramAIProvider {
    complete(prompt: string, token?: CancellationTokenLike): Promise<string>;
}

/** Thrown by a provider when no language model can be used. Its message is shown to the user. */
export class NoModelAvailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'NoModelAvailableError';
    }
}
