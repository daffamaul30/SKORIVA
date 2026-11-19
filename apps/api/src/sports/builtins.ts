/**
 * Built-in sport engine registration (T-19…T-23).
 *
 * Registration is explicit and sequential to avoid conflicts between engine
 * tasks. The application boundary imports this module once.
 */

import { badmintonEngine } from './badminton/index.js';
import { basketballEngine } from './basketball/index.js';
import { futsalEngine } from './futsal/index.js';
import { volleyballEngine } from './volleyball/index.js';
import { sportRegistry } from './registry.js';
import type { SportRegistry } from './registry.js';

export function registerBuiltInEngines(registry: SportRegistry = sportRegistry): SportRegistry {
  if (!registry.has('basketball')) registry.register(basketballEngine);
  if (!registry.has('futsal')) registry.register(futsalEngine);
  if (!registry.has('badminton')) registry.register(badmintonEngine);
  if (!registry.has('volleyball')) registry.register(volleyballEngine);

  return registry;
}

/** Default registry with all four MVP engines registered. */
export const builtInSportRegistry = registerBuiltInEngines();
