import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'migrations', 'coverage'] },
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // 원칙 17: any 사용 최소화
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          // 구조분해로 특정 키를 제외할 때 쓰는 `_name` 변수는 예외로 둔다.
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      // 공통 04 §2: 원문 로그 유출 방지를 위해 콘솔 직접 사용 금지 (logger를 쓴다)
      'no-console': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    // CLI 성격의 스크립트와 테스트는 사람이 보는 출력이 필요하다.
    files: [
      'src/db/migrate.ts',
      'src/db/seed.ts',
      'src/admin/issue-admin-token.ts',
      'src/jobs/mastery-recalc.ts',
      '**/*.test.ts',
    ],
    rules: { 'no-console': 'off' },
  },
);
