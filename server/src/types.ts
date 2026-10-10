import type { AppConfig } from "./config.js";
import type { RateLimitStore } from "./lib/rateLimitStore.js";

declare module "fastify" {
  interface FastifyInstance {
    config: AppConfig;
    /** Counter storage behind the credential-endpoint and sync rate limiters. */
    rateLimitStore: RateLimitStore;
  }
  interface FastifyContextConfig {
    /** See `RouteSpec.allowWhilePasswordChangeRequired` (read by `authenticate`). */
    allowWhilePasswordChangeRequired?: boolean;
  }
}
export {};
