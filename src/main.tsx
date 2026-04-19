import React from "react";
import ReactDOM from "react-dom/client";
import "./App.css";
import App from "./App";
import PinnedImageWindow from "./features/screenshot/PinnedImageWindow";
import ScreenshotSelectorWindow from "./features/screenshot/ScreenshotSelectorWindow";

const searchParams = new URLSearchParams(window.location.search);
const mode = searchParams.get("mode");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {mode === "pinned" ? (
      <PinnedImageWindow />
    ) : mode === "selector" ? (
      <ScreenshotSelectorWindow />
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
