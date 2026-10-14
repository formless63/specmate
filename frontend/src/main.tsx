import "@fontsource/geist/latin-400.css";
import "@fontsource/geist/latin-500.css";
import "@fontsource/geist/latin-600.css";
import "@fontsource/geist/latin-700.css";
import "@fontsource/geist-mono/latin-400.css";
import "@fontsource/geist-mono/latin-500.css";
import "@fontsource/geist-mono/latin-600.css";
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "@mantine/spotlight/styles.css";
import "./theme/schematic-bench.css";
import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { observeNumericCells } from "./lib/numericCells";
import { sbVariables, schematicBench } from "./theme/schematicBench";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });
const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

observeNumericCells();

createRoot(root).render(
  <StrictMode>
    <MantineProvider theme={schematicBench} cssVariablesResolver={sbVariables} defaultColorScheme="auto">
      <Notifications position="bottom-right" />
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </MantineProvider>
  </StrictMode>,
);
