import { NextResponse } from "next/server";

import { getPublicAppEnvironment } from "@/app/lib/env";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    {
      status: "ok",
      service: "realworld-web",
      environment: getPublicAppEnvironment(),
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
