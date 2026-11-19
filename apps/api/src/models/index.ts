/**
 * Mongoose barrel.
 *
 * T-06: connection helpers.
 * T-07: domain schemas and indexes.
 */

export { connectDatabase, disconnectDatabase, getDatabaseState } from './connection.js';
export { DEFAULT_RETRY, MONGOOSE_CONNECTED, MONGOOSE_DISCONNECTED } from './connection.js';
export type {
  ConnectDatabaseOptions,
  ConnectionAdapter,
  DisconnectDatabaseOptions,
  RetryConfig,
} from './connection.js';

export { MatchModel } from './match.model.js';
export type { MatchDocument, MatchHydratedDocument } from './match.model.js';

export { MatchEventModel } from './matchEvent.model.js';
export type { MatchEventDocument, MatchEventHydratedDocument } from './matchEvent.model.js';

export { EventModel } from './event.model.js';
export type { EventDocumentModel, EventHydratedDocument } from './event.model.js';

export { AccountModel } from './account.model.js';
export type { AccountDocument, AccountHydratedDocument } from './account.model.js';

export {
  ACTOR_TYPES,
  EVENT_TYPES,
  GAME_CLOCK_MODES,
  MATCH_STATUSES,
  META_EVENT_TYPES,
  isMetaEventType,
  OWNER_TYPES,
  PERIOD_STATUSES,
  RESULT_DECISIONS,
  SPORTS,
} from './enums.js';
export type { MetaEventType } from './enums.js';
