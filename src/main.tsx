import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import PinnedImageWindow from "./features/screenshot/PinnedImageWindow";

const searchParams = new URLSearchParams(window.location.search);
const isPinnedWindow = searchParams.get("mode") === "pinned";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isPinnedWindow ? <PinnedImageWindow /> : <App />}
  </React.StrictMode>,
);
