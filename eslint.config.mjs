import boundaries from 'eslint-plugin-boundaries';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import nextConfig from 'eslint-config-next';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

const COLOR_RULE = {
  selector: [
    'JSXAttribute Literal:matches([value=/#[0-9a-fA-F]{3,8}/], [value=/\\brgba?\\(/], [value=/\\bhsla?\\(/])',
    'JSXAttribute JSXExpressionContainer TemplateElement[value.raw=/#[0-9a-fA-F]{3,8}/]',
  ].join(', '),
  message:
    '禁止硬编码颜色，请使用语义 token（bg-surface / text-fg / border-border …），定义见 src/app/globals.css',
};

export default defineConfig([
  globalIgnores([
    '.next/**',
    'docs/**',
    'node_modules/**',
    'data/**',
    'drizzle/**',
    'playwright-report/**',
  ]),

  // Baseline: react / next / react-hooks rules.
  nextConfig,

  // TypeScript rules (non type-aware; keeps lint fast).
  ...tseslint.configs.recommended,

  // Accessibility rules for JSX. eslint-config-next already registers the
  // `jsx-a11y` plugin instance, so only its rules/language options are applied
  // here (re-registering the plugin would fail with "Cannot redefine plugin").
  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    languageOptions: jsxA11y.flatConfigs.recommended.languageOptions,
    rules: jsxA11y.flatConfigs.recommended.rules,
  },

  // Architectural boundaries: app → feature/ui/lib, feature → ui/lib (no cross-feature),
  // ui → lib, lib → lib. Everything else is disallowed.
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { boundaries },
    settings: {
      'boundaries/elements': [
        { type: 'app', pattern: 'src/app/**', mode: 'full' },
        { type: 'feature', pattern: 'src/features/*/**', capture: ['feature'], mode: 'full' },
        { type: 'ui', pattern: 'src/components/ui/**', mode: 'full' },
        { type: 'component', pattern: 'src/components/**', mode: 'full' },
        { type: 'lib', pattern: 'src/lib/**', mode: 'full' },
      ],
    },
    rules: {
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: [
            { from: 'app', allow: ['app', 'component', 'feature', 'ui', 'lib'] },
            { from: 'component', allow: ['component', 'ui', 'lib'] },
            {
              from: 'feature',
              allow: [['feature', { feature: '${from.feature}' }], 'ui', 'lib'],
              disallow: [['feature', { feature: '!${from.feature}' }]],
            },
            { from: 'ui', allow: ['ui', 'lib'] },
            { from: 'lib', allow: ['lib'] },
          ],
        },
      ],
    },
  },

  // Boundaries describe shipped code. Tests may import from any layer to build
  // fixtures — e.g. a `lib` hook test wrapping itself in the `component`-layer
  // provider it is tested against.
  {
    files: ['src/**/*.test.{ts,tsx}'],
    rules: { 'boundaries/element-types': 'off' },
  },

  // No hard-coded colors in JSX attributes; use semantic tokens instead.
  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    rules: {
      'no-restricted-syntax': ['error', COLOR_RULE],
    },
  },
]);
