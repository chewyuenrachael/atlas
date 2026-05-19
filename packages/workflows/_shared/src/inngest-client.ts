/**
 * Shared Inngest client.
 *
 * Every Atlas Inngest function imports this client so they all register
 * under the same app id and share the same retry/observability config.
 *
 * SPEC.md §5.3 (pipeline orchestration), §8.3 (extension model).
 */
import { Inngest } from 'inngest';

/** The app id surfaced in the Inngest dashboard. */
export const INNGEST_APP_ID = 'atlas';

/**
 * Singleton client. Lazy event-key resolution: in production the key is
 * pulled from `INNGEST_EVENT_KEY`; locally the Inngest dev server accepts
 * any value, so an undefined key is fine.
 */
export const inngest = new Inngest({ id: INNGEST_APP_ID });
