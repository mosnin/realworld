"use client";

import { useEffect } from "react";

export default function ErrorBoundary({
  error,
  reset,
}: Readonly<{
  error: Error & { digest?: string };
  reset: () => void;
}>) {
  useEffect(() => {
    console.error("Route error", { digest: error.digest, name: error.name });
  }, [error.digest, error.name]);

  return (
    <main className="system-message" id="main-content" tabIndex={-1}>
      <h1>That space could not open.</h1>
      <p>Your work has not been changed. Try loading this space again.</p>
      <button type="button" onClick={reset}>
        Try again
      </button>
    </main>
  );
}
