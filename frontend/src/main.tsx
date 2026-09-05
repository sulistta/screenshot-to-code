import React from "react";
import { initializePreferences } from "./lib/preferences";
import ReactDOM from "react-dom/client";
import { HashRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "react-hot-toast";
import StudioPage from "./components/studio/StudioPage";
import "./index.css";
const client = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });
const root = ReactDOM.createRoot(document.getElementById("root")!);
root.render(<p role="status">Opening Studio…</p>);
initializePreferences().then(() => root.render(
  <React.StrictMode>
    <QueryClientProvider client={client}>
      <HashRouter><Routes>
        <Route path="/" element={<StudioPage />} />
        <Route path="/projects/:projectId" element={<StudioPage />} />
      </Routes></HashRouter>
    </QueryClientProvider>
    <Toaster toastOptions={{ className: "dark:bg-zinc-950 dark:text-white" }} />
  </React.StrictMode>,
)).catch((error: Error) => root.render(<div role="alert"><h1>Studio could not open</h1><p>{error.message}</p><button onClick={() => window.location.reload()}>Try again</button></div>));
