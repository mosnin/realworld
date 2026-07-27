/* eslint-disable @typescript-eslint/no-empty-object-type, @typescript-eslint/no-explicit-any */
/** Generated Convex API bindings. Regenerate with the Convex CLI. */

import type * as missions from "../missions.js";
import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";

declare const fullApi: ApiFromModules<{ missions: typeof missions }>;
export declare const api: FilterApi<typeof fullApi, FunctionReference<any, "public">>;
export declare const internal: FilterApi<typeof fullApi, FunctionReference<any, "internal">>;
export declare const components: {};
