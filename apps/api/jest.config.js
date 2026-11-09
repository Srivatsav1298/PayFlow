const base = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: { '^.+\\.ts$': ['ts-jest', { diagnostics: { ignoreCodes: [151001] } }] },
};

module.exports = {
  testTimeout: 60000,
  projects: [
    { ...base, displayName: 'unit', rootDir: '.', testMatch: ['<rootDir>/src/**/*.spec.ts'] },
    {
      ...base,
      displayName: 'integration',
      rootDir: '.',
      testMatch: ['<rootDir>/test/integration/**/*.int-spec.ts'],
      setupFiles: ['<rootDir>/test/setup-env.ts'],
    },
    {
      ...base,
      displayName: 'e2e',
      rootDir: '.',
      testMatch: ['<rootDir>/test/e2e/**/*.e2e-spec.ts'],
      setupFiles: ['<rootDir>/test/setup-env.ts'],
    },
  ],
};
