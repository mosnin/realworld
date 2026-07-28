import { notFound } from "next/navigation";

import { RealtimeLifecycleDiagnostic } from "./realtime-lifecycle-diagnostic";

export default function RealtimeLifecycleVerificationPage() {
  if (process.env.NEXT_PUBLIC_APP_ENV !== "test") notFound();
  return <RealtimeLifecycleDiagnostic />;
}
