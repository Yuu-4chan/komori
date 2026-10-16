import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { App } from "./App";
import { AppErrorBoundary } from "./app/AppErrorBoundary";
import { installWindowLifecycle } from "./app/windowLifecycle";
import { NativeSurfaces } from "./components/layout/NativeSurfaces";
import { AppearanceProvider } from "./features/appearance/AppearanceProvider";
import "./styles/index.css";

const stopWindowLifecycle = installWindowLifecycle();
if (import.meta.hot) import.meta.hot.dispose(stopWindowLifecycle);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppErrorBoundary>
      <BrowserRouter>
        <AppearanceProvider>
          <App />
          <NativeSurfaces />
        </AppearanceProvider>
      </BrowserRouter>
    </AppErrorBoundary>
  </StrictMode>,
);
