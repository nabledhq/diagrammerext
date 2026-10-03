import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['dist/**', 'out/**', '.vscode-test/**', 'node_modules/**'] },
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ['src/**/*.ts'],
        rules: {
            curly: 'warn',
            eqeqeq: 'warn',
            'no-throw-literal': 'warn',
            '@typescript-eslint/naming-convention': [
                'warn',
                { selector: 'import', format: ['camelCase', 'PascalCase'] },
            ],
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' },
            ],
        },
    },
);
