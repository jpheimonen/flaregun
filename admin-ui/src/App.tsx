/**
 * Root application component with client-side routing.
 *
 * Sets up the MUI theme provider and React Router with the application shell.
 */

import { BrowserRouter, Routes, Route } from "react-router-dom";
import CssBaseline from "@mui/material/CssBaseline";
import { ThemeProvider, createTheme } from "@mui/material/styles";
import { AppShell } from "./components/AppShell";
import { ServiceDashboard } from "./components/ServiceDashboard";
import { ConfigEditor } from "./components/ConfigEditor";
import { LogViewer } from "./components/LogViewer";

const theme = createTheme({
  palette: {
    mode: "dark",
  },
});

export function App() {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <BrowserRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<ServiceDashboard />} />
            <Route path="/config" element={<ConfigEditor />} />
            <Route path="/logs" element={<LogViewer />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ThemeProvider>
  );
}
