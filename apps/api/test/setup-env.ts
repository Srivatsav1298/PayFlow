// Loaded before every integration/e2e test file. Points the app at the ISOLATED test
// database and Redis DB index — tests can never touch development data.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://payflow:payflow_dev_password@localhost:5434/payflow_test?schema=public';
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6380/1';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-test-access-secret-123';
process.env.ENCRYPTION_KEY = 'cd'.repeat(32);
process.env.MOCK_PROVIDER_WEBHOOK_SECRET = 'whsec_test_mock';
process.env.THROTTLE_LIMIT = '100000';
process.env.AUTH_THROTTLE_LIMIT = '100000';
process.env.WEBHOOK_BACKOFF_BASE_MS = '10';
process.env.WEBHOOK_MAX_ATTEMPTS = '3';
