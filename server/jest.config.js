/** Jest config for R1 pilot integration tests. Runs against a REAL local
 * PostgreSQL 16 database (fresh_pilot_test), never mocked, per the task's
 * "run actual PostgreSQL" requirement. Serial execution (--runInBand, set
 * in package.json) because tests share one DB and rely on real row locks /
 * unique constraints for correctness (e.g. idempotency, CAS races). */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/test/**/*.test.ts'],
  setupFilesAfterEnv: ['<rootDir>/test/setupEnv.ts'],
  globalSetup: '<rootDir>/test/globalSetup.ts',
  globalTeardown: '<rootDir>/test/globalTeardown.ts',
  testTimeout: 20000,
  verbose: true,
};
