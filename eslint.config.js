import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'
import prettier from 'eslint-config-prettier'

/**
 * Deliberately lean: Prettier does the formatting, tsc does the types.
 * The linter here deals mostly with what neither of them sees — above all
 * the size of a file.
 */
export default [
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'data/**',
      'apps/web/public/**',
      // Rust build artifacts of the macOS app, generated JavaScript included.
      'apps/desktop/src-tauri/target/**',
      'apps/desktop/src-tauri/gen/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],

  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    rules: {
      /**
       * A hard ceiling per file. Breaking it means you have two things in one
       * file — comments and blank lines deliberately do not count, so that
       * good documentation is not punished.
       */
      'max-lines': ['error', { max: 1000, skipBlankLines: true, skipComments: true }],

      // Unused is usually a leftover from a rewrite; a leading _ means intent.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // We never reach for `any` on purpose, but it is not an error either.
      '@typescript-eslint/no-explicit-any': 'warn',
      // Vue templates: we do not enforce multi-word names, folders suffice.
      'vue/multi-word-component-names': 'off',
    },
  },

  /**
   * No app reaches into another app's source.
   *
   * The worker used to import a dozen modules out of `apps/api/src` with
   * relative paths, without declaring the API as a dependency — it resolved
   * only because npm hoists everything into one node_modules, and the worker
   * was missing half the packages that code needed. What the two share is
   * `@soloops/core`, and that is the only way in.
   */
  {
    files: ['apps/**/*.ts', 'apps/**/*.vue'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/api/src/**', '**/worker/src/**', '../../api/*', '../../worker/*'],
              message:
                'Nicht quer in eine andere App greifen — gemeinsamer Code gehoert in @soloops/core.',
            },
          ],
        },
      ],
      /**
       * The same rule for `await import(...)`, which `no-restricted-imports`
       * does not see. That is not hypothetical: apps/api/src/auth.ts imports
       * the database lazily on purpose, so a JWT costs no lookup — exactly
       * the shape the static rule would wave through.
       */
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression > Literal[value=/(api|worker)\\u002Fsrc\\u002F/]',
          message:
            'Nicht quer in eine andere App greifen — gemeinsamer Code gehoert in @soloops/core.',
        },
      ],
    },
  },

  // Vue files need the TS parser inside <script setup lang="ts">
  {
    files: ['**/*.vue'],
    languageOptions: { parserOptions: { parser: tseslint.parser } },
  },

  prettier,
]
