import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import "@livekit/components-styles";
import "./styles.css";

import { App } from "./App";
import { AuthProvider } from "./auth/AuthContext";
import { E2EEProvider } from "./e2ee/E2EEContext";
import { ThemeProvider } from "./theme/ThemeContext";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element #root not found");

createRoot(rootEl).render(
  <StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        <AuthProvider>
          <E2EEProvider>
            <App />
          </E2EEProvider>
        </AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
  </StrictMode>,
);
