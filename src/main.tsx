import React from "react";
import ReactDOM from "react-dom/client";
import "./App.css";
import App from "./App";
import TextManagerWindow from "./features/textmanager/TextManagerWindow";

const hash = window.location.hash.toLowerCase();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {hash === "#textmanager" ? <TextManagerWindow /> : <App />}
  </React.StrictMode>,
);
