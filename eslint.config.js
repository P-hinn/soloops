import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'
import prettier from 'eslint-config-prettier'

/**
 * Bewusst schlank: Formatierung macht Prettier, Typprüfung macht tsc.
 * Der Linter kümmert sich hier vor allem um das, was beide nicht sehen —
 * allen voran die Dateigröße.
 */
export default [
  { ignores: ['**/dist/**', '**/node_modules/**', 'data/**', 'apps/web/public/**'] },

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
       * Harte Obergrenze pro Datei. Wer sie reißt, hat zwei Dinge in einer
       * Datei — Kommentare und Leerzeilen zählen bewusst nicht mit, damit
       * gute Dokumentation nicht bestraft wird.
       */
      'max-lines': ['error', { max: 1000, skipBlankLines: true, skipComments: true }],

      // Ungenutztes ist meist ein Rest vom Umbau; führendes _ heißt "Absicht".
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Wir setzen `any` nirgends bewusst ein, aber ein Fehler ist es nicht.
      '@typescript-eslint/no-explicit-any': 'warn',
      // Vue-Templates: mehrwortige Namen erzwingen wir nicht, die Ordner reichen.
      'vue/multi-word-component-names': 'off',
    },
  },

  // Vue-Dateien brauchen den TS-Parser innerhalb von <script setup lang="ts">
  {
    files: ['**/*.vue'],
    languageOptions: { parserOptions: { parser: tseslint.parser } },
  },

  prettier,
]
