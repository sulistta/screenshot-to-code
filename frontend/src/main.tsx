import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });
import React from "react";
import ReactDOM from "react-dom/client";
import StudioPage from "./components/studio/StudioPage.tsx";
import "./index.css";
import { Toaster } from "react-hot-toast";
import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import RunEvalsPage from "./components/evals/RunEvalsPage.tsx";
import BestOfNEvalsPage from "./components/evals/BestOfNEvalsPage.tsx";
import AllEvalsPage from "./components/evals/AllEvalsPage.tsx";
import OpenAIInputComparePage from "./components/evals/OpenAIInputComparePage.tsx";
import PromptReportsPage from "./components/evals/PromptReportsPage.tsx";
import AgentRunsPage from "./components/evals/AgentRunsPage.tsx";
import EvalSessionsPage from "./components/evals/EvalSessionsPage.tsx";
import EvalComparePage from "./components/evals/EvalComparePage.tsx";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}><Router>
      <Routes>
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
      </Routes>
    </Router></QueryClientProvider>
    <Toaster toastOptions={{ className: "dark:bg-zinc-950 dark:text-white" }} />
  </React.StrictMode>
);
