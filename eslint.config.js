import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const determinismBans = [
  {
    selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message: 'Date.now() breaks reproducibility. Take a Clock and call clock.now().',
  },
  {
    selector: "NewExpression[callee.name='Date']",
    message: 'new Date() breaks reproducibility. Take a Clock and work in epoch milliseconds.',
  },
  {
    selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
    message:
      'Math.random() breaks reproducibility. Use a seeded Rng from src/core/seeded-random.ts.',
  },
  {
    selector: "MemberExpression[object.name='performance'][property.name='now']",
    message: 'performance.now() breaks reproducibility. Take a Clock.',
  },
  {
    selector: "CallExpression[callee.property.name='randomUUID']",
    message:
      'randomUUID() breaks reproducibility. Use createIdFactory from src/core/identifiers.ts.',
  },
]

const hiddenSimulatorState = [
  {
    group: ['**/sim/hidden/**', '**/sim/hidden'],
    message:
      'Simulator latent state is hidden from the engine by design: ability to pay, willingness, ' +
      'annoyance and cancellation propensity are things a real merchant cannot observe. ' +
      'Importing them lets the engine peek at the answer and invalidates every measured result.',
  },
]

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'dist/**',
      'drizzle/**',
      'coverage/**',
      'ml/**',
      'next-env.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      'no-restricted-syntax': ['error', ...determinismBans],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['error'] }],
    },
  },

  {
    files: ['src/**/*.ts'],
    ignores: ['src/sim/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...hiddenSimulatorState,
            {
              group: ['**/sim/**', '**/sim'],
              message:
                'The engine must not import the simulator. It consumes gateway events and the ' +
                'database, exactly as it would in production. Importing simulator code couples ' +
                'the engine to a world it is supposed to be blind to.',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['scripts/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: hiddenSimulatorState }],
    },
  },

  {
    files: ['src/core/clock.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...determinismBans.filter((ban) => !ban.selector.includes('Date')),
      ],
    },
  },

  {
    files: ['scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },

  {
    files: ['tests/**/*.ts'],
    rules: {
      'no-restricted-syntax': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },

  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
)
