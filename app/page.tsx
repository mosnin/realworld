import { MissionAccessGate } from "@/app/auth/mission-access-gate";
import { MissionWorld } from "@/app/mission-world";

export default function HomePage() {
  return (
    <MissionAccessGate>
      <MissionWorld />
    </MissionAccessGate>
  );
}
