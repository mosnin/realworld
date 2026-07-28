import { isAuthenticatedNextjs } from "@convex-dev/auth/nextjs/server";

import { MissionAccessGate } from "@/app/auth/mission-access-gate";
import { MissionWorld } from "@/app/mission-world";

export default async function HomePage() {
  const initialAuthenticated =
    process.env.NEXT_PUBLIC_CONVEX_URL === undefined
      ? false
      : await isAuthenticatedNextjs();

  return (
    <MissionAccessGate initialAuthenticated={initialAuthenticated}>
      <MissionWorld />
    </MissionAccessGate>
  );
}
