import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });
import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import StudioPage from "./components/studio/StudioPage.tsx";
import "./index.css";
import { Toaster } from "react-hot-toast";
import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
const RunEvalsPage = lazy(() => import("./components/evals/RunEvalsPage.tsx"));
const BestOfNEvalsPage = lazy(() => import("./components/evals/BestOfNEvalsPage.tsx"));
const AllEvalsPage = lazy(() => import("./components/evals/AllEvalsPage.tsx"));
const OpenAIInputComparePage = lazy(() => import("./components/evals/OpenAIInputComparePage.tsx"));
const PromptReportsPage = lazy(() => import("./components/evals/PromptReportsPage.tsx"));
const AgentRunsPage = lazy(() => import("./components/evals/AgentRunsPage.tsx"));
const EvalSessionsPage = lazy(() => import("./components/evals/EvalSessionsPage.tsx"));
const EvalComparePage = lazy(() => import("./components/evals/EvalComparePage.tsx"));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}><Router>
      <Suspense fallback={<div className="p-8" role="status">Opening workspace…</div>}><Routes>
        <Route path="/" element={<StudioPage />} />
        <Route path="/projects/:projectId" element={<StudioPage />} />
        <Route path="/evals" element={<AllEvalsPage />} />
        <Route path="/evals/best-of-n" element={<BestOfNEvalsPage />} />
        <Route path="/evals/run" element={<RunEvalsPage />} />
        <Route
          path="/evals/openai-input-compare"
          element={<OpenAIInputComparePage />}
        />
        <Route path="/evals/prompt-reports" element={<PromptReportsPage />} />
        <Route path="/evals/agent-runs" element={<AgentRunsPage />} />
        <Route path="/evals/sessions" element={<EvalSessionsPage />} />
        <Route path="/evals/compare" element={<EvalComparePage />} />
      </Routes></Suspense>
    </Router></QueryClientProvider>
    <Toaster toastOptions={{ className: "dark:bg-zinc-950 dark:text-white" }} />
  </React.StrictMode>
);
