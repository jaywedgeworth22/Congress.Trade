/**
 * Durable-queue handler wiring shared by Deno.cron and POST /api/admin/runtime-tick.
 * Kept free of app/index imports so the admin router can drive ticks without a
 * circular dependency through app.ts.
 */

import type { DurableQueueHandlers } from './durableQueue.ts';
import {
  handleCorruptDeadLetterMessage,
  handleDeadLetterMessage,
  handleDeliveryMessage,
  handleIngestMessage,
} from '../queueHandlers.ts';
import { isTerminalUsageTelemetryDeliveryError } from '../shared/thirdPartyTelemetry.ts';
import { completeDeliveryOutbox } from '../delivery/outbox.ts';
import { completeIngestionOutbox } from '../ingestion/outbox.ts';

export function createRuntimeQueueHandlers(): DurableQueueHandlers {
  return {
    handleIngestMessage,
    handleDeliveryMessage,
    handleDeadLetterMessage,
    handleCorruptDeadLetterMessage,
    isTerminalDeadLetterError: (message, error) =>
      message.type === 'usage.telemetry'
      && isTerminalUsageTelemetryDeliveryError(error),
    completeIngestionOutbox,
    completeDeliveryOutbox,
  };
}
