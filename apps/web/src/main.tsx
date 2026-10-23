import { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "./api";
import { lazyDefault, lazyNamed } from "./lib/lazy";
import "./styles.css";
import { Loading } from "./ui/Loading";

// The staff app, the applicant portal and the public feedback form are separate chunks:
// each entry loads only the code it needs.
const App = lazyDefault(() => import("./App"));
const PortalApp = lazyNamed(() => import("./portal/PortalApp"), "PortalApp");
const PublicFeedback = lazyNamed(() => import("./feedback/PublicFeedback"), "PublicFeedback");

// Queries retry once on a network or server error; a 4xx answer (no access, not found, invalid) is final.
// Mutations never retry (TanStack's default). Tests build their own client with retry off.
const client = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failures, e) => failures < 1 && !(e instanceof ApiError && e.status >= 400 && e.status < 500),
      refetchOnWindowFocus: false,
    },
  },
});
const feedbackPath = window.location.pathname.match(/^\/feedback\/([^/]*)\/?$/);
// jobs-portal: the applicant portal is a separate app with its own session.
const portalPath = /^\/portal(\/|$)/.test(window.location.pathname);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <Suspense fallback={<Loading page />}>
        {feedbackPath ? <PublicFeedback token={feedbackPath[1]!} /> : portalPath ? <PortalApp /> : <App />}
      </Suspense>
    </QueryClientProvider>
  </StrictMode>,
);
