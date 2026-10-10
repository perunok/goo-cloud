import { defineConfig } from "vitest/config";

// Tests need a real PostgreSQL. Point TEST_DATABASE_URL at a throwaway database, e.g.:
//   docker run -d --rm --name goo-cloud-test-pg -p 127.0.0.1:55433:5432 -e POSTGRES_PASSWORD=test -e POSTGRES_DB=goo_test \
//     --tmpfs /var/lib/postgresql/data postgres:16-alpine
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:test@127.0.0.1:55433/goo_test";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/globalSetup.ts"],
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      NODE_ENV: "test",
      GOO_SIGNING_SECRET: "test-signing-secret-that-is-long-enough-0123456789"
    },
    testTimeout: 30000,
    hookTimeout: 60000,
    fileParallelism: false
  }
});
