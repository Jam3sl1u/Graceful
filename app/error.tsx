"use client";

import { Page } from "@/components/ui/Page";
import { ErrorState } from "@/components/ui/States";

// Route-level error boundary: an unexpected render error on any screen
// lands here instead of a blank page.
export default function RouteError({ reset }: { error: Error; reset: () => void }) {
  return (
    <Page width="narrow">
      <ErrorState onRetry={reset} />
    </Page>
  );
}
