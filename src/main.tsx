import React from "react";
import ReactDOM from "react-dom/client";
import "./App.css";
import App from "./App";
import TextManagerWindow from "./features/textmanager/TextManagerWindow";
import PasswordWindow from "./features/password/PasswordWindow";

const hash = window.location.hash.toLowerCase();
const View: React.ReactNode =
  hash === "#textmanager" ? <TextManagerWindow /> :
  hash === "#password" ? <PasswordWindow /> :
  <App />;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {View}
  </React.StrictMode>,
);
