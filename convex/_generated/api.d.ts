/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as calls from "../calls.js";
import type * as canvas from "../canvas.js";
import type * as fractures from "../fractures.js";
import type * as http from "../http.js";
import type * as invites from "../invites.js";
import type * as launch from "../launch.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_mission_templates from "../lib/mission_templates.js";
import type * as missions from "../missions.js";
import type * as moves from "../moves.js";
import type * as proofs from "../proofs.js";
import type * as pulse from "../pulse.js";
import type * as realtime from "../realtime.js";
import type * as realtime_authorization from "../realtime_authorization.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  calls: typeof calls;
  canvas: typeof canvas;
  fractures: typeof fractures;
  http: typeof http;
  invites: typeof invites;
  launch: typeof launch;
  "lib/auth": typeof lib_auth;
  "lib/mission_templates": typeof lib_mission_templates;
  missions: typeof missions;
  moves: typeof moves;
  proofs: typeof proofs;
  pulse: typeof pulse;
  realtime: typeof realtime;
  realtime_authorization: typeof realtime_authorization;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
