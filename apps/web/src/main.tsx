import React from "react";
import { createRoot } from "react-dom/client";

import { App } from "./ui/App";
import { registerMediaServiceWorker } from "./ui/serviceWorker/registerMediaServiceWorker";

void registerMediaServiceWorker();

const rootElement = document.getElementById("root");
if (!rootElement) {
    throw new Error("Missing #root mount element");
}

createRoot(rootElement).render(
    <React.StrictMode>
        <App />
    </React.StrictMode>,
);
