import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
    const root = path.resolve(__dirname, '../../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');

    // Run against a throw-away copy of the fixture workspace so tests can create files freely.
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'diagrammer-test-'));
    fs.cpSync(path.join(root, 'test-fixtures', 'workspace'), workspace, { recursive: true });

    try {
        await runTests({
            extensionDevelopmentPath: root,
            extensionTestsPath,
            launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust'],
        });
    } catch (err) {
        console.error('Failed to run integration tests', err);
        process.exitCode = 1;
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
}

void main();
