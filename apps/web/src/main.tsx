import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { PublicFeedback } from "./feedback/PublicFeedback";
import "./styles.css";

const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
const feedbackPath = window.location.pathname.match(/^\/feedback\/([^/]*)\/?$/);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      {feedbackPath ? <PublicFeedback token={feedbackPath[1]!} /> : <App />}
    </QueryClientProvider>
  </StrictMode>,
);
