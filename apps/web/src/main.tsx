import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { PublicFeedback } from "./feedback/PublicFeedback";
import { PortalApp } from "./portal/PortalApp";
import "./styles.css";

const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
const feedbackPath = window.location.pathname.match(/^\/feedback\/([^/]*)\/?$/);
// jobs-portal: the applicant portal is a separate app with its own session.
const portalPath = /^\/portal(\/|$)/.test(window.location.pathname);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      {feedbackPath ? <PublicFeedback token={feedbackPath[1]!} /> : portalPath ? <PortalApp /> : <App />}
    </QueryClientProvider>
  </StrictMode>,
);
